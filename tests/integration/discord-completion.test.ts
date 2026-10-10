import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "../../src/db/pool.js";
import { migrateUp, migrateDown } from "../../src/db/migrate.js";
import { AuthService } from "../../src/auth/service.js";
import { MembershipService } from "../../src/membership/service.js";
import { MockPaymentProvider } from "../../src/payments/mock.js";
import { loadDiscordConfig } from "../../src/discord/config.js";
import { MockDiscordAdapter, mockGuild } from "../../src/discord/adapters.js";
import {
  RestDiscordAdapter,
  type HttpTransport,
} from "../../src/discord/rest.js";
import { MemberVerification } from "../../src/discord/verification.js";
import { DiscordSyncService } from "../../src/discord/sync.js";
import { RoleOperations } from "../../src/discord/operations.js";
import { DiscordFailure } from "../../src/discord/types.js";
import type { ProductCode } from "../../src/domain/products.js";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Disposable TEST_DATABASE_URL ending in _test required.");
const pool = createPool(url);
const auth = new AuthService(
  pool,
  "test-password-pepper-32-characters",
  "test-session-pepper-32-characters!",
);
const memberships = new MembershipService(pool);
const payments = new MockPaymentProvider();
const config = loadDiscordConfig({
  DISCORD_VERIFICATION_ENABLED: "true",
  DISCORD_RECONCILE_BATCH_SIZE: "2",
});
const memberId = "200000000000000001";
let mock: MockDiscordAdapter;
let sync: DiscordSyncService;
let verification: MemberVerification;
let now = new Date("2026-02-15T00:00:00Z");
beforeAll(async () => migrateUp(pool));
beforeEach(async () => {
  await pool.query(`TRUNCATE administrative_audit_logs,discord_sync_jobs,payment_events,membership_entitlements,
    payments,billing_subscriptions,orders,discord_accounts,user_sessions,app_users,discord_mock_members,discord_runtime,
    discord_member_jobs,discord_gateway_events,discord_role_operations RESTART IDENTITY CASCADE`);
  mock = new MockDiscordAdapter(config);
  sync = new DiscordSyncService(
    pool,
    config,
    memberships,
    mock,
    () => now,
    () => 0,
  );
  verification = new MemberVerification(pool, config, mock, sync);
  now = new Date("2026-02-15T00:00:00Z");
});
afterAll(async () => pool.end());
async function event(
  type = "GUILD_MEMBER_ADD",
  pending: boolean | undefined = true,
  sequence = 1,
  id = memberId,
) {
  await verification.dispatch(
    type,
    {
      guild_id: config.DISCORD_GUILD_ID,
      user: { id },
      roles: mock.members.get(id)?.roles ?? [],
      ...(pending === undefined ? {} : { pending }),
    },
    "session",
    sequence,
  );
}
async function customer() {
  const user = await auth.createUser(
    `${randomUUID()}@example.test`,
    "Strong-test-password-12345!",
  );
  await pool.query(
    "INSERT INTO discord_accounts(user_id,discord_user_id) VALUES($1,$2)",
    [user.id, memberId],
  );
  return user.id;
}
async function buy(
  userId: string,
  product: ProductCode = "VIP_MONTHLY_ONCE",
  at = "2026-02-01T00:00:00Z",
  sub?: string,
) {
  const id = randomUUID();
  if (product === "VIP_MONTHLY_AUTO" && !sub)
    await memberships.createSubscription({
      userId,
      providerSubscriptionId: id,
    });
  await memberships.createOrder({
    userId,
    productCode: product,
    providerOrderId: id,
    idempotencyKey: id,
  });
  const payment = payments.createPurchase({
    userId,
    productCode: product,
    providerOrderId: id,
    providerPaymentId: id,
    eventId: id,
    occurredAt: new Date(at),
    correlationId: randomUUID(),
    ...(product === "VIP_MONTHLY_AUTO"
      ? {
          providerSubscriptionId: sub ?? id,
          periodStart: new Date(at),
          periodEnd: new Date(
            at === "2026-03-01T00:00:00Z"
              ? "2026-04-01T00:00:00Z"
              : "2026-03-01T00:00:00Z",
          ),
        }
      : {}),
  });
  await memberships.processVerifiedEvent(payment);
  return { id, payment };
}
async function drain(service: DiscordSyncService) {
  for (let i = 0; i < 50; i++) if (!(await service.runOne())) break;
}
function liveFixture() {
  const live = loadDiscordConfig({
    DISCORD_ENVIRONMENT: "test-guild",
    DISCORD_TEST_GUILD_ID: "900000000000000001",
    DISCORD_GUILD_ID: "900000000000000001",
    DISCORD_GUILD_OWNER_ID: "100000000000000099",
    DISCORD_OWNER_APPROVED: "true",
    DISCORD_APPROVAL_REFERENCE: "owner-test-fixture",
    DISCORD_ADAPTER: "rest",
    DISCORD_NETWORK_ENABLED: "true",
    DISCORD_DRY_RUN: "false",
    DISCORD_WRITES_ENABLED: "true",
    DISCORD_VERIFICATION_ENABLED: "true",
  });
  const state = new MockDiscordAdapter(live);
  state.members.set(memberId, { id: memberId, roles: [], pending: false });
  let failure: DiscordFailure | undefined;
  let loseConfirmation = false;
  let changed = false;
  const transport: HttpTransport = {
    async request(path, init) {
      if (failure) throw failure;
      const guild = mockGuild(live);
      const prefix = `/api/v10/guilds/${live.DISCORD_GUILD_ID}`;
      if (path === prefix)
        return Response.json({ id: guild.id, owner_id: guild.ownerId });
      if (path === `${prefix}/roles`) return Response.json(guild.roles);
      const match = path.match(/\/members\/(\d+)(?:\/roles\/(\d+))?$/);
      if (!match) throw new Error("Unexpected fixture route");
      const id = match[1]!;
      const role = match[2];
      if (role) {
        const intent = await pool.query(
          "SELECT status FROM discord_role_operations WHERE discord_user_id=$1 AND role_id=$2 ORDER BY created_at DESC LIMIT 1",
          [id, role],
        );
        expect(intent.rows[0]?.status).toBe("intent"); // Visible from a separate connection BEFORE mutation.
        if (init.method === "PUT") await state.addRole(id, role);
        else await state.removeRole(id, role);
        changed = true;
        return new Response(null, { status: 204 });
      }
      if (loseConfirmation && changed)
        throw new DiscordFailure("DISCORD_TIMEOUT", true);
      const member =
        id === live.DISCORD_CLIENT_ID ? guild.bot : state.members.get(id);
      return member
        ? Response.json({
            user: { id },
            roles: member.roles,
            ...("pending" in member ? { pending: member.pending } : {}),
          })
        : new Response("{}", { status: 404 });
    },
  };
  const adapter = new RestDiscordAdapter(
    live,
    "fixture-only-not-a-real-token",
    transport,
  );
  const service = new DiscordSyncService(
    pool,
    live,
    memberships,
    adapter,
    () => now,
    () => 0,
  );
  return {
    live,
    state,
    adapter,
    service,
    verification: new MemberVerification(pool, live, adapter, service),
    setFailure: (value: DiscordFailure | undefined) => {
      failure = value;
    },
    loseConfirmation: () => {
      loseConfirmation = true;
    },
    restore: () => {
      loseConfirmation = false;
    },
  };
}
describe("durable Rules Screening verification", () => {
  it.each([true, undefined])(
    "does not assign Free Member for pending=%s",
    async (pending) => {
      mock.members.set(memberId, {
        id: memberId,
        roles: [],
        ...(pending === undefined ? {} : { pending }),
      });
      await event("GUILD_MEMBER_ADD", pending);
      await verification.runOne();
      expect(mock.mutations).toEqual([]);
      const audits = await pool.query(
        "SELECT metadata FROM administrative_audit_logs WHERE action='DISCORD_VERIFICATION_PLANNED'",
      );
      expect(audits.rows[0].metadata.outcome).toBe(
        "screening_pending_or_unknown",
      );
    },
  );
  it("rechecks REST rather than trusting a pending=false event", async () => {
    mock.members.set(memberId, { id: memberId, roles: [], pending: true });
    await event("GUILD_MEMBER_UPDATE", false);
    await verification.runOne();
    expect(mock.mutations).toHaveLength(0);
    mock.members.get(memberId)!.pending = false;
    await event("GUILD_MEMBER_UPDATE", false, 2);
    await verification.runOne();
    expect(
      (
        await pool.query(
          "SELECT metadata FROM administrative_audit_logs WHERE action='DISCORD_VERIFICATION_PLANNED' ORDER BY id DESC LIMIT 1",
        )
      ).rows[0].metadata.outcome,
    ).toBe("preview");
    expect(mock.mutations).toHaveLength(0);
  });
  it("deduplicates replay and recovers a new job after a process restart", async () => {
    mock.members.set(memberId, { id: memberId, roles: [], pending: false });
    await Promise.all([
      event("GUILD_MEMBER_ADD", false),
      event("GUILD_MEMBER_ADD", false),
    ]);
    expect(
      (
        await pool.query(
          "SELECT requested_version::int AS version FROM discord_member_jobs",
        )
      ).rows[0].version,
    ).toBe(1);
    const restarted = new MemberVerification(pool, config, mock, sync);
    expect(await restarted.runOne()).toBe(true);
    expect(await verification.runOne()).toBe(false);
  });
  it("scans missed events in persistent pages, including unlinked members", async () => {
    for (let i = 1; i <= 3; i++)
      mock.members.set(`20000000000000000${i}`, {
        id: `20000000000000000${i}`,
        roles: [],
        pending: false,
      });
    expect(await verification.reconcileBatch()).toBe(2);
    const restarted = new MemberVerification(pool, config, mock, sync);
    expect(await restarted.reconcileBatch()).toBe(1);
    expect(await restarted.reconcileBatch()).toBe(0);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM discord_member_jobs"))
        .rows[0].n,
    ).toBe(3);
  });
  it("reclaims an expired lease and schedules API failure with rate-limit backoff", async () => {
    await event();
    await pool.query(
      "UPDATE discord_member_jobs SET status='processing',lease_token=gen_random_uuid(),lease_expires_at=now()-interval '1 second'",
    );
    mock.failure = new DiscordFailure("DISCORD_RATE_LIMITED", true, 60000);
    await verification.runOne();
    expect(
      (
        await pool.query(
          "SELECT status,last_error_code,available_at>now()+interval '55 seconds' AS delayed FROM discord_member_jobs",
        )
      ).rows[0],
    ).toMatchObject({
      status: "retry",
      last_error_code: "DISCORD_RATE_LIMITED",
      delayed: true,
    });
    mock.failure = undefined;
    mock.members.set(memberId, { id: memberId, roles: [], pending: false });
    await pool.query("UPDATE discord_member_jobs SET available_at=now()");
    await verification.runOne();
    expect(
      (await pool.query("SELECT status FROM discord_member_jobs")).rows[0]
        .status,
    ).toBe("succeeded");
  });
  it("ignores other guilds and invalidates stale ownership on leaving/rejoining", async () => {
    const userId = await customer();
    await pool.query(
      `INSERT INTO discord_role_ownership(guild_id,discord_user_id,role_id,user_id,source,approval_reference)
      VALUES($1,$2,$3,$4,'bot_assignment','fixture')`,
      [
        config.DISCORD_GUILD_ID,
        memberId,
        config.DISCORD_VIP_MONTHLY_ROLE_ID,
        userId,
      ],
    );
    await verification.dispatch(
      "GUILD_MEMBER_ADD",
      { guild_id: memberId, user: { id: memberId }, pending: false },
      "session",
      1,
    );
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM discord_member_jobs"))
        .rows[0].n,
    ).toBe(0);
    await event("GUILD_MEMBER_REMOVE", undefined, 2);
    await event("GUILD_MEMBER_ADD", true, 3);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM discord_role_ownership",
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM discord_sync_jobs"))
        .rows[0].n,
    ).toBe(1);
  });
  it("performs one verified Free Member assignment across concurrent workers, then noops", async () => {
    const f = liveFixture();
    await f.verification.dispatch(
      "GUILD_MEMBER_ADD",
      {
        guild_id: f.live.DISCORD_GUILD_ID,
        user: { id: memberId },
        pending: false,
      },
      "session",
      1,
    );
    await Promise.all([f.verification.runOne(), f.verification.runOne()]);
    expect(f.state.mutations).toEqual([
      {
        memberId,
        roleId: f.live.DISCORD_FREE_MEMBER_ROLE_ID,
        operation: "add",
      },
    ]);
    await f.verification.dispatch(
      "GUILD_MEMBER_UPDATE",
      {
        guild_id: f.live.DISCORD_GUILD_ID,
        user: { id: memberId },
        pending: false,
        roles: f.state.members.get(memberId)!.roles,
      },
      "session",
      2,
    );
    await f.verification.runOne();
    expect(f.state.mutations).toHaveLength(1);
  });
});
describe("controlled REST contract, no real Discord connection", () => {
  it.each(["VIP_MONTHLY_ONCE", "VIP_MONTHLY_AUTO", "VIP_LIFETIME"] as const)(
    "assigns %s once with durable ownership and intent",
    async (product) => {
      const f = liveFixture();
      const userId = await customer();
      const { payment } = await buy(userId, product);
      await memberships.processVerifiedEvent(payment);
      await Promise.all([f.service.runOne(), f.service.runOne()]);
      expect(f.state.mutations).toHaveLength(1);
      expect(
        (await pool.query("SELECT source FROM discord_role_ownership")).rows[0]
          .source,
      ).toBe("bot_assignment");
      expect(
        (
          await pool.query(
            "SELECT mode,outcome FROM discord_sync_history ORDER BY id DESC LIMIT 1",
          )
        ).rows[0],
      ).toMatchObject({ mode: "test-guild", outcome: "applied" });
    },
  );
  it("keeps manual and protected roles while expiring only bot-owned Monthly access", async () => {
    const f = liveFixture();
    const id = await customer();
    const member = f.state.members.get(memberId)!;
    member.roles = [
      f.live.DISCORD_FREE_MEMBER_ROLE_ID,
      f.live.DISCORD_FOUNDER_ROLE_ID,
      f.live.DISCORD_STAFF_ROLE_ID,
    ];
    await buy(id);
    await drain(f.service);
    now = new Date("2026-03-01T00:00:00Z");
    await memberships.reconcileExpired(now);
    await drain(f.service);
    expect(member.roles).toEqual([
      f.live.DISCORD_FREE_MEMBER_ROLE_ID,
      f.live.DISCORD_FOUNDER_ROLE_ID,
      f.live.DISCORD_STAFF_ROLE_ID,
    ]);
    expect(f.state.mutations.map((m) => m.roleId)).toEqual([
      f.live.DISCORD_VIP_MONTHLY_ROLE_ID,
      f.live.DISCORD_VIP_MONTHLY_ROLE_ID,
    ]);
  });
  it("preserves Lifetime when a separate Monthly purchase is refunded", async () => {
    const f = liveFixture();
    const userId = await customer();
    const monthly = await buy(userId);
    await drain(f.service);
    await buy(userId, "VIP_LIFETIME");
    await drain(f.service);
    await memberships.processVerifiedEvent({
      ...monthly.payment,
      eventId: randomUUID(),
      type: "PAYMENT_REFUNDED",
      occurredAt: now,
    });
    await drain(f.service);
    expect(f.state.members.get(memberId)!.roles).toEqual([
      f.live.DISCORD_VIP_LIFETIME_ROLE_ID,
    ]);
  });
  it("preserves unowned roles and refuses mock ownership as live authority", async () => {
    const f = liveFixture();
    const id = await customer();
    f.state.members.get(memberId)!.roles = [f.live.DISCORD_VIP_MONTHLY_ROLE_ID];
    await pool.query(
      `INSERT INTO discord_role_ownership(guild_id,discord_user_id,role_id,user_id,source,approval_reference)
      VALUES($1,$2,$3,$4,'mock_seed','fixture')`,
      [
        f.live.DISCORD_GUILD_ID,
        memberId,
        f.live.DISCORD_VIP_MONTHLY_ROLE_ID,
        id,
      ],
    );
    await f.service.enqueue(id, "expired");
    await drain(f.service);
    expect(f.state.mutations).toHaveLength(0);
    expect(
      (
        await pool.query(
          "SELECT error_code FROM discord_sync_history ORDER BY id DESC LIMIT 1",
        )
      ).rows[0].error_code,
    ).toBe("ROLE_OWNERSHIP_UNKNOWN");
  });
  it("never lets a VIP role bypass incomplete screening", async () => {
    const f = liveFixture();
    const id = await customer();
    f.state.members.get(memberId)!.pending = true;
    await buy(id);
    await drain(f.service);
    expect(f.state.mutations).toHaveLength(0);
    expect(
      (
        await pool.query(
          "SELECT error_code FROM discord_sync_history ORDER BY id DESC LIMIT 1",
        )
      ).rows[0].error_code,
    ).toBe("MEMBER_SCREENING_INCOMPLETE");
    f.state.members.get(memberId)!.pending = false;
    await f.service.memberRejoined(
      f.live.DISCORD_GUILD_ID,
      memberId,
      "verified",
    );
    await drain(f.service);
    expect(f.state.mutations).toHaveLength(1);
  });
  it("recovers confirmed ownership after transaction rollback without duplicating an assignment", async () => {
    const f = liveFixture();
    const id = await customer();
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await new RoleOperations(pool, f.live, f.adapter).apply(
        db,
        memberId,
        f.live.DISCORD_VIP_MONTHLY_ROLE_ID,
        "add",
        id,
      );
      await db.query("ROLLBACK");
    } finally {
      db.release();
    }
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM discord_role_ownership",
        )
      ).rows[0].n,
    ).toBe(0);
    await buy(id);
    await drain(f.service);
    expect(f.state.mutations).toHaveLength(1);
    expect(
      (await pool.query("SELECT source FROM discord_role_ownership")).rows[0]
        .source,
    ).toBe("bot_assignment");
    await expect(migrateDown(pool)).rejects.toThrow("live operation evidence");
  });
  it("does not claim ownership of an ambiguous API result", async () => {
    const f = liveFixture();
    const id = await customer();
    f.loseConfirmation();
    await buy(id);
    await drain(f.service);
    expect(
      (await pool.query("SELECT status FROM discord_role_operations")).rows[0]
        .status,
    ).toBe("uncertain");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM discord_role_ownership",
        )
      ).rows[0].n,
    ).toBe(0);
    f.restore();
    await pool.query(
      "UPDATE discord_sync_jobs SET available_at=now() WHERE status='retry'",
    );
    await drain(f.service);
    now = new Date("2026-04-01T00:00:00Z");
    await memberships.reconcileExpired(now);
    await drain(f.service);
    expect(f.state.members.get(memberId)!.roles).toContain(
      f.live.DISCORD_VIP_MONTHLY_ROLE_ID,
    );
    expect(
      (
        await pool.query(
          "SELECT error_code FROM discord_sync_history ORDER BY id DESC LIMIT 1",
        )
      ).rows[0].error_code,
    ).toBe("ROLE_OWNERSHIP_UNKNOWN");
  });
  it("retries transient API failure after restart", async () => {
    const f = liveFixture();
    const id = await customer();
    await buy(id);
    f.setFailure(new DiscordFailure("DISCORD_UNAVAILABLE", true));
    await f.service.runOne();
    f.setFailure(undefined);
    await pool.query(
      "UPDATE discord_sync_jobs SET available_at=now() WHERE status='retry'",
    );
    const restarted = new DiscordSyncService(
      pool,
      f.live,
      memberships,
      f.adapter,
      () => now,
      () => 0,
    );
    await drain(restarted);
    expect(f.state.mutations).toHaveLength(1);
  });
});
