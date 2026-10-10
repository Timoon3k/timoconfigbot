import type { DatabasePool } from "../db/pool.js";
import type { DiscordConfig } from "./config.js";
import { snowflake } from "./config.js";
import { assertRole } from "./policy.js";
import {
  DiscordFailure,
  type DiscordAdapter,
  type GuildState,
  type Member,
} from "./types.js";

export function mockGuild(config: DiscordConfig): GuildState {
  const role = (
    id: string,
    name: string,
    position: number,
    permissions = "0",
  ) => ({ id, name, position, permissions, managed: false });
  return {
    id: config.DISCORD_GUILD_ID,
    ownerId: "100000000000000099",
    bot: { id: config.DISCORD_CLIENT_ID, roles: ["100000000000000007"] },
    roles: [
      role(config.DISCORD_GUILD_ID, "@everyone", 0),
      role(config.DISCORD_VIP_MONTHLY_ROLE_ID, "VIP Monthly", 1),
      role(config.DISCORD_VIP_LIFETIME_ROLE_ID, "VIP Lifetime", 2),
      role("100000000000000007", "TimonConfigs Bot", 3, "268435456"),
      role(config.DISCORD_STAFF_ROLE_ID, "Staff", 4),
      role(config.DISCORD_FOUNDER_ROLE_ID, "Founder", 5),
      role(config.DISCORD_FREE_MEMBER_ROLE_ID, "Free Member", 0),
    ],
  };
}

export class MockDiscordAdapter implements DiscordAdapter {
  public readonly kind = "mock" as const;
  public readonly members = new Map<string, Member>();
  public readonly mutations: Array<{
    memberId: string;
    roleId: string;
    operation: "add" | "remove";
  }> = [];
  public failure: DiscordFailure | undefined;
  public guild: GuildState;
  public constructor(private readonly config: DiscordConfig) {
    this.guild = mockGuild(config);
  }
  public async inspectGuild(): Promise<GuildState> {
    if (this.failure) throw this.failure;
    return structuredClone(this.guild);
  }
  public async getMember(id: string): Promise<Member | null> {
    return structuredClone(this.members.get(id) ?? null);
  }
  public async listMembers(after: string, limit: number): Promise<Member[]> {
    return [...this.members.values()]
      .filter((m) => BigInt(m.id) > BigInt(after))
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
      .slice(0, limit)
      .map((m) => structuredClone(m));
  }
  public async addRole(memberId: string, roleId: string): Promise<void> {
    this.change(memberId, roleId, "add");
  }
  public async removeRole(memberId: string, roleId: string): Promise<void> {
    this.change(memberId, roleId, "remove");
  }
  private change(
    memberId: string,
    roleId: string,
    operation: "add" | "remove",
  ): void {
    assertRole(this.config, roleId);
    const member = this.members.get(snowflake.parse(memberId));
    if (!member) throw new DiscordFailure("MEMBER_ABSENT");
    this.mutations.push({ memberId, roleId, operation });
    member.roles =
      operation === "add"
        ? [...new Set([...member.roles, roleId])]
        : member.roles.filter((id) => id !== roleId);
  }
}

export class DatabaseMockDiscordAdapter implements DiscordAdapter {
  public readonly kind = "mock" as const;
  public constructor(
    private readonly pool: DatabasePool,
    private readonly config: DiscordConfig,
  ) {}
  public async inspectGuild(): Promise<GuildState> {
    return mockGuild(this.config);
  }
  public async getMember(id: string): Promise<Member | null> {
    const result = await this.pool.query<{
      roles: string[];
      pending: boolean | null;
    }>(
      "SELECT roles,pending FROM discord_mock_members WHERE guild_id=$1 AND discord_user_id=$2 AND present=true",
      [this.config.DISCORD_GUILD_ID, snowflake.parse(id)],
    );
    return result.rows[0]
      ? {
          id,
          roles: result.rows[0].roles.map((role) => snowflake.parse(role)),
          ...(result.rows[0].pending === null
            ? {}
            : { pending: result.rows[0].pending }),
        }
      : null;
  }
  public async listMembers(after: string, limit: number): Promise<Member[]> {
    const rows = await this.pool.query<{ discord_user_id: string }>(
      `SELECT discord_user_id FROM discord_mock_members WHERE guild_id=$1 AND present=true
       AND discord_user_id::numeric>$2::numeric ORDER BY discord_user_id::numeric LIMIT $3`,
      [this.config.DISCORD_GUILD_ID, after, limit],
    );
    const members = await Promise.all(
      rows.rows.map((row) => this.getMember(row.discord_user_id)),
    );
    return members.filter((member): member is Member => member !== null);
  }
  public async addRole(_memberId: string, _roleId: string): Promise<void> {
    throw new DiscordFailure("MOCK_STATE_READ_ONLY");
  }
  public async removeRole(_memberId: string, _roleId: string): Promise<void> {
    throw new DiscordFailure("MOCK_STATE_READ_ONLY");
  }
}

/** A preview is evidence of intent, never evidence that Discord was changed. */
export class DryRunDiscordAdapter implements DiscordAdapter {
  public readonly kind = "dry-run" as const;
  public constructor(private readonly reader: DiscordAdapter) {}
  public inspectGuild(): Promise<GuildState> {
    return this.reader.inspectGuild();
  }
  public getMember(id: string): Promise<Member | null> {
    return this.reader.getMember(id);
  }
  public listMembers(after: string, limit: number): Promise<Member[]> {
    return this.reader.listMembers(after, limit);
  }
  public async addRole(_memberId: string, _roleId: string): Promise<void> {
    throw new DiscordFailure("DRY_RUN_MUTATION_BLOCKED");
  }
  public async removeRole(_memberId: string, _roleId: string): Promise<void> {
    throw new DiscordFailure("DRY_RUN_MUTATION_BLOCKED");
  }
}
