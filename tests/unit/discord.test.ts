import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { loadDiscordConfig } from "../../src/discord/config.js";
import {
  DryRunDiscordAdapter,
  MockDiscordAdapter,
  mockGuild,
} from "../../src/discord/adapters.js";
import { roleDiff, verifyGuild } from "../../src/discord/policy.js";
import { RestDiscordAdapter, discordResponse } from "../../src/discord/rest.js";
import { RestOAuthProvider } from "../../src/discord/oauth-provider.js";
import {
  verifiedInteraction,
  type DiscordCommands,
} from "../../src/discord/commands.js";

const config = loadDiscordConfig({});
const memberId = "200000000000000001";

describe("Discord safety boundaries", () => {
  it.each(["DISCORD_WRITES_ENABLED", "DISCORD_NETWORK_ENABLED"])(
    "rejects %s even with other defaults",
    (flag) => {
      expect(() => loadDiscordConfig({ [flag]: "true" })).toThrow();
    },
  );
  it("rejects non-distinct IDs, unapproved REST and unsafe redirect destinations", () => {
    expect(() =>
      loadDiscordConfig({
        DISCORD_VIP_MONTHLY_ROLE_ID: config.DISCORD_STAFF_ROLE_ID,
      }),
    ).toThrow();
    expect(() => loadDiscordConfig({ DISCORD_ADAPTER: "rest" })).toThrow();
    expect(() =>
      loadDiscordConfig({
        DISCORD_OAUTH_REDIRECT_URI: "http://attacker.example/callback",
      }),
    ).toThrow();
  });
  it("never includes Founder, Staff, or unrelated roles in a diff", () => {
    const unrelated = [
      config.DISCORD_FOUNDER_ROLE_ID,
      config.DISCORD_STAFF_ROLE_ID,
      "200000000000000009",
    ];
    expect(
      roleDiff(
        config,
        [...unrelated, config.DISCORD_VIP_MONTHLY_ROLE_ID],
        "VIP_LIFETIME",
      ),
    ).toEqual({
      desired: [config.DISCORD_VIP_LIFETIME_ROLE_ID],
      add: [config.DISCORD_VIP_LIFETIME_ROLE_ID],
      remove: [config.DISCORD_VIP_MONTHLY_ROLE_ID],
    });
  });
  it.each([
    [
      "wrong guild",
      (g: ReturnType<typeof mockGuild>) => {
        g.id = "200000000000000099";
      },
    ],
    [
      "Administrator",
      (g: ReturnType<typeof mockGuild>) => {
        g.roles[3]!.permissions = "8";
      },
    ],
    [
      "missing Manage Roles",
      (g: ReturnType<typeof mockGuild>) => {
        g.roles[3]!.permissions = "0";
      },
    ],
    [
      "VIP above bot",
      (g: ReturnType<typeof mockGuild>) => {
        g.roles[1]!.position = 50;
      },
    ],
    [
      "bot above Staff",
      (g: ReturnType<typeof mockGuild>) => {
        g.roles[4]!.position = 2;
      },
    ],
    [
      "managed VIP",
      (g: ReturnType<typeof mockGuild>) => {
        g.roles[1]!.managed = true;
      },
    ],
    [
      "protected role under VIP ID",
      (g: ReturnType<typeof mockGuild>) => {
        g.roles[1]!.name = "Founder";
      },
    ],
    [
      "privileged VIP",
      (g: ReturnType<typeof mockGuild>) => {
        g.roles[1]!.permissions = "8";
      },
    ],
  ])("blocks unsafe configuration: %s", (_name, change) => {
    const guild = mockGuild(config);
    change(guild);
    expect(() => verifyGuild(config, guild)).toThrow();
  });
  it("allows only two roles even in mock mutation methods", async () => {
    const mock = new MockDiscordAdapter(config);
    mock.members.set(memberId, { id: memberId, roles: [] });
    await expect(
      mock.addRole(memberId, config.DISCORD_FOUNDER_ROLE_ID),
    ).rejects.toMatchObject({ code: "ROLE_NOT_ALLOWLISTED" });
    await expect(
      mock.removeRole(memberId, config.DISCORD_STAFF_ROLE_ID),
    ).rejects.toMatchObject({ code: "ROLE_NOT_ALLOWLISTED" });
    expect(mock.mutations).toHaveLength(0);
  });
  it("dry-run wrappers cannot forward any mutation", async () => {
    const mock = new MockDiscordAdapter(config);
    const dry = new DryRunDiscordAdapter(mock);
    await expect(
      dry.addRole(memberId, config.DISCORD_VIP_MONTHLY_ROLE_ID),
    ).rejects.toMatchObject({ code: "DRY_RUN_MUTATION_BLOCKED" });
    await expect(
      dry.removeRole(memberId, config.DISCORD_VIP_LIFETIME_ROLE_ID),
    ).rejects.toThrow();
    expect(mock.mutations).toHaveLength(0);
  });
});

describe("Discord REST contract without network access", () => {
  it("blocks default transport and all real writes before any HTTP operation", async () => {
    const adapter = new RestDiscordAdapter(config, "test-only");
    await expect(adapter.inspectGuild()).rejects.toMatchObject({
      code: "PRODUCTION_CONNECTION_NOT_APPROVED",
    });
    const request = vi.fn();
    const injected = new RestDiscordAdapter(config, "test-only", { request });
    await expect(
      injected.addRole(memberId, config.DISCORD_VIP_MONTHLY_ROLE_ID),
    ).rejects.toMatchObject({ code: "LIVE_MUTATIONS_NOT_APPROVED" });
    await expect(
      injected.removeRole(memberId, config.DISCORD_STAFF_ROLE_ID),
    ).rejects.toMatchObject({ code: "ROLE_NOT_ALLOWLISTED" });
    expect(request).not.toHaveBeenCalled();
  });
  it("uses exact guild member path and authorization header, returns absent members", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 404 }));
    const adapter = new RestDiscordAdapter(config, "fixture-token", {
      request,
    });
    expect(await adapter.getMember(memberId)).toBeNull();
    expect(request).toHaveBeenCalledWith(
      `/api/v10/guilds/${config.DISCORD_GUILD_ID}/members/${memberId}`,
      { method: "GET", headers: { Authorization: "Bot fixture-token" } },
    );
  });
  it("respects the larger Retry-After from JSON and headers", async () => {
    await expect(
      discordResponse(
        new Response('{"retry_after":2.25}', {
          status: 429,
          headers: { "retry-after": "4" },
        }),
      ),
    ).rejects.toMatchObject({
      code: "DISCORD_RATE_LIMITED",
      retryAfterMs: 4000,
      retryable: true,
    });
  });
  it.each([
    [503, true],
    [403, false],
    [401, false],
  ])("classifies HTTP %d safely", async (status, retryable) => {
    await expect(
      discordResponse(
        new Response("do-not-log-secret", { status: Number(status) }),
      ),
    ).rejects.toMatchObject({ retryable });
  });
  it("honors exhausted successful response buckets before the next request", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ user: { id: memberId }, roles: [] }), {
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset-after": "10",
          },
        }),
      );
    const adapter = new RestDiscordAdapter(config, "fixture", { request });
    await adapter.getMember(memberId);
    await expect(adapter.getMember(memberId)).rejects.toMatchObject({
      code: "DISCORD_RATE_LIMITED",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("exchanges PKCE authorization code and identifies user server-side without returning credentials", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          '{"access_token":"hidden","token_type":"Bearer","scope":"identify"}',
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: memberId, username: "untrusted-name" }),
        ),
      );
    const oauth = new RestOAuthProvider(config, "secret-fixture", { request });
    const url = new URL(oauth.authorizationUrl("state", "challenge"));
    expect(url.searchParams.get("scope")).toBe("identify");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(await oauth.identify("code", "verifier")).toBe(memberId);
    expect(request.mock.calls[0]?.[1].body).toContain("code_verifier=verifier");
    expect(request.mock.calls[1]?.[1].headers.Authorization).toBe(
      "Bearer hidden",
    );
  });
});

describe("signed, private bot command input", () => {
  it("verifies Ed25519, application identity and timestamp before dispatch", async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicHex = (
      keys.publicKey.export({ format: "der", type: "spki" }) as Buffer
    )
      .subarray(-32)
      .toString("hex");
    const raw = Buffer.from(
      JSON.stringify({
        type: 2,
        application_id: config.DISCORD_CLIENT_ID,
        guild_id: config.DISCORD_GUILD_ID,
        member: { user: { id: memberId } },
        data: { name: "membership" },
      }),
    );
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(
      null,
      Buffer.concat([Buffer.from(timestamp), raw]),
      keys.privateKey,
    ).toString("hex");
    const handle = vi.fn().mockResolvedValue({ type: 4, data: { flags: 64 } });
    const commands = { handle } as unknown as DiscordCommands;
    await verifiedInteraction(
      raw,
      signature,
      timestamp,
      publicHex,
      commands,
      config.DISCORD_CLIENT_ID,
    );
    expect(handle).toHaveBeenCalledWith(
      config.DISCORD_GUILD_ID,
      memberId,
      "membership",
    );
    await expect(
      verifiedInteraction(
        Buffer.from("{}"),
        signature,
        timestamp,
        publicHex,
        commands,
        config.DISCORD_CLIENT_ID,
      ),
    ).rejects.toThrow();
    await expect(
      verifiedInteraction(
        raw,
        signature,
        timestamp,
        publicHex,
        commands,
        config.DISCORD_CLIENT_ID,
        Date.now() + 400000,
      ),
    ).rejects.toThrow();
    expect(handle).toHaveBeenCalledTimes(1);
  });
});
