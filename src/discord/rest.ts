import { z } from "zod";
import type { DiscordConfig } from "./config.js";
import { snowflake } from "./config.js";
import { assertRole, verifyGuild } from "./policy.js";
import {
  DiscordFailure,
  type DiscordAdapter,
  type GuildState,
  type Member,
} from "./types.js";

export interface HttpTransport {
  request(
    path: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<Response>;
}

/** Intentionally no fetch fallback: approval requires a separately reviewed release. */
export class DisabledDiscordTransport implements HttpTransport {
  public async request(): Promise<Response> {
    throw new DiscordFailure("PRODUCTION_CONNECTION_NOT_APPROVED");
  }
}

export function assertTestGuildNetwork(config: DiscordConfig): void {
  if (
    !["test-guild", "production"].includes(config.DISCORD_ENVIRONMENT) ||
    !config.DISCORD_OWNER_APPROVED ||
    !config.DISCORD_APPROVAL_REFERENCE ||
    !config.DISCORD_NETWORK_ENABLED ||
    (config.DISCORD_ENVIRONMENT === "test-guild"
      ? config.DISCORD_TEST_GUILD_ID
      : config.DISCORD_PRODUCTION_GUILD_ID) !== config.DISCORD_GUILD_ID ||
    !config.DISCORD_GUILD_OWNER_ID
  )
    throw new DiscordFailure("PRODUCTION_CONNECTION_NOT_APPROVED");
}
export function assertTestGuildWrites(
  config: DiscordConfig,
  roleId?: string,
): void {
  assertTestGuildNetwork(config);
  if (config.DISCORD_DRY_RUN || !config.DISCORD_WRITES_ENABLED)
    throw new DiscordFailure("LIVE_MUTATIONS_NOT_APPROVED");
  if (
    config.DISCORD_ENVIRONMENT === "production" &&
    (roleId !== config.DISCORD_FREE_MEMBER_ROLE_ID ||
      !config.DISCORD_FREE_MEMBER_WRITES_APPROVED ||
      !config.DISCORD_FREE_MEMBER_APPROVAL_REFERENCE ||
      !config.DISCORD_VERIFICATION_ENABLED)
  )
    throw new DiscordFailure("PRODUCTION_VIP_MUTATIONS_DISABLED");
}
const memberSchema = z.object({
  user: z.object({ id: snowflake, bot: z.boolean().optional() }),
  roles: z.array(snowflake),
  pending: z.boolean().optional(),
});
const rolesSchema = z.array(
  z.object({
    id: snowflake,
    name: z.string(),
    position: z.number().int(),
    permissions: z.string().regex(/^\d+$/),
    managed: z.boolean(),
  }),
);

export async function discordResponse(response: Response): Promise<unknown> {
  if (response.status === 429) {
    const body: unknown = await response.json().catch(() => ({}));
    const rate = z
      .object({ retry_after: z.number().nonnegative().optional() })
      .safeParse(body);
    const header = Number(
      response.headers.get("retry-after") ??
        response.headers.get("x-ratelimit-reset-after") ??
        1,
    );
    const seconds = Math.max(
      Number.isFinite(header) ? header : 1,
      rate.success ? (rate.data.retry_after ?? 1) : 1,
    );
    throw new DiscordFailure(
      "DISCORD_RATE_LIMITED",
      true,
      Math.ceil(seconds * 1000),
    );
  }
  if (response.status >= 500)
    throw new DiscordFailure("DISCORD_UNAVAILABLE", true);
  if (response.status === 401 || response.status === 403)
    throw new DiscordFailure("DISCORD_PERMISSION_DENIED");
  if (response.status === 404) throw new DiscordFailure("DISCORD_NOT_FOUND");
  if (!response.ok) throw new DiscordFailure("DISCORD_INVALID_REQUEST");
  if (response.status === 204) return null;
  return response.json();
}

/** Fixed API paths and configured guild only. Transport is injected for offline contract tests. */
export class RestDiscordAdapter implements DiscordAdapter {
  public readonly kind = "rest" as const;
  private nextRequestAt = 0;
  public constructor(
    private readonly config: DiscordConfig,
    private readonly token: string,
    private readonly transport: HttpTransport = new DisabledDiscordTransport(),
  ) {}

  private async request(path: string, method = "GET"): Promise<unknown> {
    if (Date.now() < this.nextRequestAt)
      throw new DiscordFailure(
        "DISCORD_RATE_LIMITED",
        true,
        this.nextRequestAt - Date.now(),
      );
    let response: Response;
    try {
      response = await this.transport.request(path, {
        method,
        headers: { Authorization: `Bot ${this.token}` },
      });
    } catch (error) {
      if (error instanceof DiscordFailure) throw error;
      throw new DiscordFailure("DISCORD_TIMEOUT", true);
    }
    if (response.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(
        response.headers.get("x-ratelimit-reset-after") ?? 1,
      );
      this.nextRequestAt =
        Date.now() + Math.ceil((Number.isFinite(reset) ? reset : 1) * 1000);
    }
    return discordResponse(response);
  }
  public async inspectGuild(): Promise<GuildState> {
    const prefix = `/api/v10/guilds/${this.config.DISCORD_GUILD_ID}`;
    const guild = z
      .object({ id: snowflake, owner_id: snowflake })
      .parse(await this.request(prefix));
    const roles = rolesSchema.parse(await this.request(`${prefix}/roles`));
    const bot = await this.getMember(this.config.DISCORD_CLIENT_ID);
    if (!bot) throw new DiscordFailure("BOT_MEMBER_MISSING");
    return { id: guild.id, ownerId: guild.owner_id, roles, bot };
  }
  public async getMember(id: string): Promise<Member | null> {
    try {
      const member = memberSchema.parse(
        await this.request(
          `/api/v10/guilds/${this.config.DISCORD_GUILD_ID}/members/${snowflake.parse(id)}`,
        ),
      );
      if (member.user.id !== id)
        throw new DiscordFailure("MEMBER_IDENTITY_MISMATCH");
      return {
        id,
        roles: member.roles,
        ...(member.user.bot === undefined ? {} : { bot: member.user.bot }),
        ...(member.pending === undefined ? {} : { pending: member.pending }),
      };
    } catch (error) {
      if (error instanceof DiscordFailure && error.code === "DISCORD_NOT_FOUND")
        return null;
      throw error;
    }
  }
  public async listMembers(after: string, limit: number): Promise<Member[]> {
    if (
      !/^[0-9]{1,20}$/.test(after) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 1000
    )
      throw new DiscordFailure("MEMBER_PAGE_INVALID");
    const rows = z
      .array(memberSchema)
      .parse(
        await this.request(
          `/api/v10/guilds/${this.config.DISCORD_GUILD_ID}/members?limit=${limit}&after=${after}`,
        ),
      );
    return rows.map((row) => ({
      id: row.user.id,
      roles: row.roles,
      ...(row.user.bot === undefined ? {} : { bot: row.user.bot }),
      ...(row.pending === undefined ? {} : { pending: row.pending }),
    }));
  }
  public async addRole(memberId: string, roleId: string): Promise<void> {
    await this.mutate(memberId, roleId, "PUT");
  }
  public async removeRole(memberId: string, roleId: string): Promise<void> {
    await this.mutate(memberId, roleId, "DELETE");
  }
  private async mutate(
    memberId: string,
    roleId: string,
    method: string,
  ): Promise<void> {
    assertRole(this.config, roleId);
    snowflake.parse(memberId);
    try {
      assertTestGuildWrites(this.config, roleId);
    } catch {
      throw new DiscordFailure("LIVE_MUTATIONS_NOT_APPROVED");
    }
    verifyGuild(this.config, await this.inspectGuild());
    const current = await this.getMember(memberId);
    if (!current) throw new DiscordFailure("MEMBER_ABSENT");
    // Giving any role can bypass Rules Screening; require explicit REST verification for additions.
    if (method === "PUT" && current.roles.includes(roleId))
      throw new DiscordFailure("ROLE_ASSIGNMENT_RACE");
    if (method === "PUT" && current.pending !== false)
      throw new DiscordFailure("MEMBER_SCREENING_INCOMPLETE");
    if (
      method === "DELETE" &&
      roleId === this.config.DISCORD_FREE_MEMBER_ROLE_ID
    )
      throw new DiscordFailure("FREE_MEMBER_REMOVAL_FORBIDDEN");
    await this.request(
      `/api/v10/guilds/${this.config.DISCORD_GUILD_ID}/members/${memberId}/roles/${roleId}`,
      method,
    );
    const member = await this.getMember(memberId);
    if (!member || member.roles.includes(roleId) !== (method === "PUT"))
      throw new DiscordFailure("MUTATION_NOT_CONFIRMED", true);
  }
}
