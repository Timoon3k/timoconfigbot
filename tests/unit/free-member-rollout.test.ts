import { describe, expect, it, vi } from "vitest";
import { loadDiscordConfig } from "../../src/discord/config.js";
import { mockGuild } from "../../src/discord/adapters.js";
import { RestDiscordAdapter } from "../../src/discord/rest.js";
import { RoleOperations } from "../../src/discord/operations.js";
import type { DatabasePool, DatabaseClient } from "../../src/db/pool.js";
import type { Member } from "../../src/discord/types.js";

const approved = {
  NODE_ENV: "production",
  DISCORD_ENVIRONMENT: "production",
  DISCORD_PRODUCTION_GUILD_ID: "900000000000000001",
  DISCORD_GUILD_ID: "900000000000000001",
  DISCORD_GUILD_OWNER_ID: "100000000000000099",
  DISCORD_OWNER_APPROVED: "true",
  DISCORD_APPROVAL_REFERENCE: "fixture-network-approval",
  DISCORD_ADAPTER: "rest",
  DISCORD_NETWORK_ENABLED: "true",
  DISCORD_VIP_SYNC_ENABLED: "false",
  DISCORD_OAUTH_REDIRECT_URI:
    "https://bot.timonconfigs.com/api/discord/callback",
  DISCORD_INTERACTIONS_PUBLIC_KEY: "a".repeat(64),
  DISCORD_WRITES_ENABLED: "true",
  DISCORD_DRY_RUN: "false",
  DISCORD_VERIFICATION_ENABLED: "true",
  DISCORD_FREE_MEMBER_WRITES_APPROVED: "true",
  DISCORD_FREE_MEMBER_ROLLOUT_MODE: "canary",
  DISCORD_FREE_MEMBER_CANARY_IDS: "200000000000000001",
  DISCORD_FREE_MEMBER_APPROVAL_REFERENCE: "fixture-free-member-approval",
};
const memberId = "200000000000000001";
function fixture(member: Member, override: NodeJS.ProcessEnv = {}) {
  const config = loadDiscordConfig({ ...approved, ...override });
  const guild = mockGuild(config);
  const prefix = `/api/v10/guilds/${config.DISCORD_GUILD_ID}`;
  const request = vi.fn(async (path: string, init: { method: string }) => {
    if (path === prefix)
      return Response.json({ id: guild.id, owner_id: guild.ownerId });
    if (path === `${prefix}/roles`) return Response.json(guild.roles);
    if (path.endsWith(`/roles/${config.DISCORD_FREE_MEMBER_ROLE_ID}`)) {
      expect(init.method).toBe("PUT");
      member.roles.push(config.DISCORD_FREE_MEMBER_ROLE_ID);
      return new Response(null, { status: 204 });
    }
    const current = path.endsWith(`/members/${config.DISCORD_CLIENT_ID}`)
      ? {
          ...guild.bot,
          bot: member.id === config.DISCORD_CLIENT_ID ? member.bot : true,
          pending:
            member.id === config.DISCORD_CLIENT_ID ? member.pending : false,
        }
      : member;
    expect(path).toBe(`${prefix}/members/${current.id}`);
    return Response.json({
      user: { id: current.id, bot: current.bot },
      roles: current.roles,
      pending: current.pending,
    });
  });
  return {
    config,
    request,
    adapter: new RestDiscordAdapter(config, "fixture-only", { request }),
  };
}
function writes(request: ReturnType<typeof fixture>["request"]) {
  return request.mock.calls.filter(([, init]) => init.method !== "GET");
}

describe("Free Member production mutation boundary (offline transport)", () => {
  it.each([true, undefined])(
    "rejects pending=%s at the final REST check",
    async (pending) => {
      const f = fixture({
        id: memberId,
        roles: [],
        ...(pending === undefined ? {} : { pending }),
      });
      await expect(
        f.adapter.addRole(memberId, f.config.DISCORD_FREE_MEMBER_ROLE_ID),
      ).rejects.toMatchObject({ code: "MEMBER_SCREENING_INCOMPLETE" });
      expect(writes(f.request)).toEqual([]);
    },
  );
  it.each(["other-bot", "own-bot"])(
    "rejects %s even with pending=false",
    async (kind) => {
      const id =
        kind === "own-bot" ? loadDiscordConfig({}).DISCORD_CLIENT_ID : memberId;
      const f = fixture({
        id,
        roles: [],
        pending: false,
        ...(kind === "other-bot" ? { bot: true } : {}),
      });
      await expect(
        f.adapter.addRole(id, f.config.DISCORD_FREE_MEMBER_ROLE_ID),
      ).rejects.toMatchObject({ code: "MEMBER_BOT_NOT_ALLOWED" });
      expect(writes(f.request)).toEqual([]);
    },
  );
  it("adds only Free Member and preserves every existing role", async () => {
    const c = loadDiscordConfig({});
    const roles = [
      c.DISCORD_FOUNDER_ROLE_ID,
      c.DISCORD_STAFF_ROLE_ID,
      c.DISCORD_VIP_MONTHLY_ROLE_ID,
      c.DISCORD_VIP_LIFETIME_ROLE_ID,
    ];
    const member = { id: memberId, roles: [...roles], pending: false };
    const f = fixture(member);
    await f.adapter.addRole(memberId, f.config.DISCORD_FREE_MEMBER_ROLE_ID);
    expect(writes(f.request)).toHaveLength(1);
    expect(member.roles).toEqual([
      ...roles,
      f.config.DISCORD_FREE_MEMBER_ROLE_ID,
    ]);
    await expect(
      f.adapter.addRole(memberId, f.config.DISCORD_FREE_MEMBER_ROLE_ID),
    ).rejects.toMatchObject({ code: "ROLE_ASSIGNMENT_RACE" });
    expect(writes(f.request)).toHaveLength(1);
  });
  it("forbids Free Member removal in both operation and REST layers", async () => {
    const f = fixture({ id: memberId, roles: [], pending: false });
    await expect(
      f.adapter.removeRole(memberId, f.config.DISCORD_FREE_MEMBER_ROLE_ID),
    ).rejects.toMatchObject({ code: "FREE_MEMBER_REMOVAL_FORBIDDEN" });
    expect(writes(f.request)).toEqual([]);
    const query = vi.fn();
    const pool = { query } as unknown as DatabasePool;
    const db = { query } as unknown as DatabaseClient;
    await expect(
      new RoleOperations(pool, f.config, f.adapter).apply(
        db,
        memberId,
        f.config.DISCORD_FREE_MEMBER_ROLE_ID,
        "remove",
        null,
      ),
    ).rejects.toMatchObject({ code: "FREE_MEMBER_REMOVAL_FORBIDDEN" });
    expect(query).not.toHaveBeenCalled();
  });
  it.each([
    "DISCORD_FOUNDER_ROLE_ID",
    "DISCORD_STAFF_ROLE_ID",
    "DISCORD_VIP_MONTHLY_ROLE_ID",
    "DISCORD_VIP_LIFETIME_ROLE_ID",
  ] as const)(
    "blocks additions and removals of %s before any HTTP request",
    async (key) => {
      const f = fixture({ id: memberId, roles: [], pending: false });
      await expect(
        f.adapter.addRole(memberId, f.config[key]),
      ).rejects.toThrow();
      await expect(
        f.adapter.removeRole(memberId, f.config[key]),
      ).rejects.toThrow();
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it("rejects a verified user outside the production canary", async () => {
    const other = "200000000000000002";
    const f = fixture({ id: other, roles: [], pending: false });
    await expect(
      f.adapter.addRole(other, f.config.DISCORD_FREE_MEMBER_ROLE_ID),
    ).rejects.toMatchObject({ code: "FREE_MEMBER_ROLLOUT_RESTRICTED" });
    expect(writes(f.request)).toEqual([]);
  });
  it("blocks unapproved non-canary role operations before writing audit records", async () => {
    const other = "200000000000000002";
    const f = fixture({ id: other, roles: [], pending: false });
    const query = vi.fn();
    const pool = { query } as unknown as DatabasePool;
    const db = { query } as unknown as DatabaseClient;
    await expect(
      new RoleOperations(pool, f.config, f.adapter).apply(
        db, other, f.config.DISCORD_FREE_MEMBER_ROLE_ID, "add", null,
      ),
    ).rejects.toMatchObject({ code: "FREE_MEMBER_ROLLOUT_RESTRICTED" });
    expect(query).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });
  it("requires an explicitly approved scope for production writes", () => {
    expect(() => loadDiscordConfig({
      ...approved, DISCORD_FREE_MEMBER_ROLLOUT_MODE: "disabled",
      DISCORD_FREE_MEMBER_CANARY_IDS: "",
    })).toThrow();
    expect(() => loadDiscordConfig({
      ...approved, DISCORD_FREE_MEMBER_ROLLOUT_MODE: "all",
      DISCORD_FREE_MEMBER_CANARY_IDS: "",
    })).toThrow();
    expect(() => loadDiscordConfig({
      ...approved, DISCORD_FREE_MEMBER_ROLLOUT_MODE: "all",
      DISCORD_FREE_MEMBER_CANARY_IDS: "",
      DISCORD_FREE_MEMBER_ALL_APPROVAL_REFERENCE: "fixture-all-server-approval",
    })).not.toThrow();
    expect(() => loadDiscordConfig({
      ...approved,
      DISCORD_FREE_MEMBER_CANARY_IDS: "200000000000000001,200000000000000001",
    })).toThrow();
    expect(() => loadDiscordConfig({
      ...approved,
      DISCORD_FREE_MEMBER_CANARY_IDS: "200000000000000001,200000000000000002,200000000000000003",
    })).toThrow();
  });
  it("keeps the read-only production configuration unable to write", async () => {
    const f = fixture(
      { id: memberId, roles: [], pending: false },
      {
        DISCORD_DRY_RUN: "true",
        DISCORD_WRITES_ENABLED: "false",
        DISCORD_FREE_MEMBER_WRITES_APPROVED: "false",
      },
    );
    await expect(
      f.adapter.addRole(memberId, f.config.DISCORD_FREE_MEMBER_ROLE_ID),
    ).rejects.toMatchObject({ code: "LIVE_MUTATIONS_NOT_APPROVED" });
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each([
    { DISCORD_FREE_MEMBER_WRITES_APPROVED: "false" },
    { DISCORD_FREE_MEMBER_APPROVAL_REFERENCE: "" },
    {
      DISCORD_FREE_MEMBER_APPROVAL_REFERENCE:
        approved.DISCORD_APPROVAL_REFERENCE,
    },
    { DISCORD_VERIFICATION_ENABLED: "false" },
    { DISCORD_NETWORK_ENABLED: "false" },
    { DISCORD_OWNER_APPROVED: "false" },
    { DISCORD_GUILD_OWNER_ID: "" },
    { DISCORD_APPROVAL_REFERENCE: "" },
  ])("rejects incomplete approval gates %j", (override) => {
    expect(() => loadDiscordConfig({ ...approved, ...override })).toThrow();
  });
});
