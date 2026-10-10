import { createHash } from "node:crypto";
import { z } from "zod";
import { snowflake, type DiscordConfig } from "./config.js";
import {
  DisabledDiscordTransport,
  discordResponse,
  type HttpTransport,
} from "./rest.js";
import { DiscordFailure } from "./types.js";

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
export interface DiscordOAuthProvider {
  authorizationUrl(state: string, challenge: string): string;
  identify(code: string, verifier: string): Promise<string>;
}

export class MockOAuthProvider implements DiscordOAuthProvider {
  private readonly codes = new Map<string, { id: string; challenge: string }>();
  public constructor(private readonly redirectUri: string) {}
  public authorizationUrl(state: string, challenge: string): string {
    const url = new URL(this.redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("mock", "true");
    url.searchParams.set("code_challenge", challenge);
    return url.toString();
  }
  /** Test/CLI fixture only. No public endpoint may mint an identity code. */
  public issueCode(code: string, discordId: string, challenge: string): void {
    this.codes.set(code, { id: snowflake.parse(discordId), challenge });
  }
  public async identify(code: string, verifier: string): Promise<string> {
    const entry = this.codes.get(code);
    this.codes.delete(code);
    if (!entry || entry.challenge !== pkceChallenge(verifier))
      throw new DiscordFailure("OAUTH_CODE_INVALID");
    return entry.id;
  }
}

export class RestOAuthProvider implements DiscordOAuthProvider {
  public constructor(
    private readonly config: DiscordConfig,
    private readonly clientSecret: string,
    private readonly transport: HttpTransport = new DisabledDiscordTransport(),
  ) {}
  public authorizationUrl(state: string, challenge: string): string {
    const url = new URL("https://discord.com/oauth2/authorize");
    url.search = new URLSearchParams({
      client_id: this.config.DISCORD_CLIENT_ID,
      response_type: "code",
      scope: "identify",
      redirect_uri: this.config.DISCORD_OAUTH_REDIRECT_URI,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  }
  public async identify(code: string, verifier: string): Promise<string> {
    try {
      const response = await this.transport.request("/api/v10/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: this.config.DISCORD_CLIENT_ID,
          client_secret: this.clientSecret,
          code,
          code_verifier: verifier,
          redirect_uri: this.config.DISCORD_OAUTH_REDIRECT_URI,
        }).toString(),
      });
      const token = z
        .object({
          access_token: z.string().min(1),
          token_type: z.string(),
          scope: z.string(),
        })
        .parse(await discordResponse(response));
      if (
        token.token_type.toLowerCase() !== "bearer" ||
        !token.scope.split(" ").includes("identify")
      )
        throw new DiscordFailure("OAUTH_SCOPE_INVALID");
      // Tokens remain local to this call. No persistence, logging or response serialization.
      const identity = await this.transport.request("/api/v10/users/@me", {
        method: "GET",
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      return z.object({ id: snowflake }).parse(await discordResponse(identity))
        .id;
    } catch (error) {
      if (error instanceof DiscordFailure) throw error;
      throw new DiscordFailure("OAUTH_PROVIDER_FAILURE");
    }
  }
}
