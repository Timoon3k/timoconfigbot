import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { AuthService } from "../../src/auth/service.js";
import { createPool } from "../../src/db/pool.js";
import { migrateDown, migrateUp } from "../../src/db/migrate.js";
import { MembershipService } from "../../src/membership/service.js";
import { MockPaymentProvider } from "../../src/payments/mock.js";
import { loadDiscordConfig } from "../../src/discord/config.js";
import { MockDiscordAdapter } from "../../src/discord/adapters.js";
import { DiscordSyncService } from "../../src/discord/sync.js";
import { enqueueSync } from "../../src/discord/queue.js";
import { DiscordFailure } from "../../src/discord/types.js";
import { MockOAuthProvider } from "../../src/discord/oauth-provider.js";
import { DiscordLinkService } from "../../src/discord/oauth.js";
import { DiscordCommands } from "../../src/discord/commands.js";
import { PostgresDiscordRateGate } from "../../src/discord/transport.js";
import { buildApp } from "../../src/http/app.js";
import type { ProductCode } from "../../src/domain/products.js";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error(
    "A disposable TEST_DATABASE_URL ending in _test is required.",
  );
const pool = createPool(url);
const auth = new AuthService(
  pool,
  "test-password-pepper-32-characters",
  "test-session-pepper-32-characters!",
);
const memberships = new MembershipService(pool);
const config = loadDiscordConfig({ DISCORD_RECONCILE_BATCH_SIZE: "10" });
const paymentProvider = new MockPaymentProvider();
const password = "Secure-test-password-12345!";
const memberId = "200000000000000001";
const secondId = "200000000000000002";
const date = (value: string) => new Date(value);
let now = date("2026-02-15T00:00:00Z");
let adapter: MockDiscordAdapter;
let sync: DiscordSyncService;
let oauth: MockOAuthProvider;
let links: DiscordLinkService;
let app: FastifyInstance;

beforeAll(async () => {
  await migrateUp(pool);
});
beforeEach(async () => {
  if (app) await app.close();
  await pool.query(`TRUNCATE administrative_audit_logs,discord_sync_jobs,payment_events,membership_entitlements,
    payments,billing_subscriptions,orders,discord_accounts,user_sessions,app_users,discord_mock_members,discord_runtime RESTART IDENTITY CASCADE`);
  now = date("2026-02-15T00:00:00Z");
  adapter = new MockDiscordAdapter(config);
  sync = new DiscordSyncService(
    pool,
    config,
    memberships,
    adapter,
    () => now,
    () => 0,
  );
  oauth = new MockOAuthProvider(config.DISCORD_OAUTH_REDIRECT_URI);
  links = new DiscordLinkService(
    pool,
    auth,
    oauth,
    "oauth-test-encryption-secret-32-characters",
  );
  app = buildApp({
    auth,
    memberships,
    production: false,
    discord: { sync, links },
  });
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  await pool.end();
});

async function user(linked = true, role: "customer" | "admin" = "customer") {
  const user = await auth.createUser(
    `${randomUUID()}@example.test`,
    password,
    role,
  );
  if (linked) {
    await pool.query(
      "INSERT INTO discord_accounts(user_id,discord_user_id) VALUES($1,$2)",
      [user.id, memberId],
    );
    await pool.query(
      "INSERT INTO discord_identity_reservations(user_id,discord_user_id) VALUES($1,$2)",
      [user.id, memberId],
    );
    adapter.members.set(memberId, { id: memberId, roles: [] });
  }
  return user;
}
async function own(userId: string, roleId: string, discordId = memberId) {
  await pool.query(
    `INSERT INTO discord_role_ownership(guild_id,discord_user_id,role_id,user_id,source,approval_reference)
    VALUES($1,$2,$3,$4,'mock_seed','integration-fixture') ON CONFLICT DO NOTHING`,
    [config.DISCORD_GUILD_ID, discordId, roleId, userId],
  );
}
async function purchase(
  userId: string,
  productCode: ProductCode = "VIP_MONTHLY_ONCE",
  at = "2026-02-01T00:00:00Z",
  subId?: string,
) {
  const id = randomUUID();
  const subscriptionId = subId ?? `sub-${id}`;
  if (productCode === "VIP_MONTHLY_AUTO" && !subId)
    await memberships.createSubscription({
      userId,
      providerSubscriptionId: subscriptionId,
    });
  await memberships.createOrder({
    userId,
    productCode,
    providerOrderId: id,
    idempotencyKey: id,
  });
  const event = paymentProvider.createPurchase({
    userId,
    productCode,
    providerOrderId: id,
    providerPaymentId: id,
    eventId: id,
    occurredAt: date(at),
    correlationId: randomUUID(),
    ...(productCode === "VIP_MONTHLY_AUTO"
      ? {
          providerSubscriptionId: subscriptionId,
          periodStart: date(at),
          periodEnd: date(
            at === "2026-03-01T00:00:00Z"
              ? "2026-04-01T00:00:00Z"
              : "2026-03-01T00:00:00Z",
          ),
        }
      : {}),
  });
  await memberships.processVerifiedEvent(event);
  return { id, event, subscriptionId };
}
async function drain() {
  for (let i = 0; i < 200; i++) if (!(await sync.runOne())) break;
}
async function latest() {
  return (
    await pool.query(
      "SELECT * FROM discord_sync_history ORDER BY id DESC LIMIT 1",
    )
  ).rows[0]!;
}
async function linkStart(
  userId: string,
  email: string,
  targetId = memberId,
  replacement = false,
) {
  const session = await auth.login(email, password);
  const start = await links.begin(
    session.token,
    session.csrfToken,
    password,
    replacement,
  );
  const url = new URL(start.authorizationUrl);
  const state = url.searchParams.get("state")!;
  const code = randomUUID();
  oauth.issueCode(code, targetId, url.searchParams.get("code_challenge")!);
  return { userId, session, state, code };
}

describe("authoritative membership synchronization", () => {
  it.each(["VIP_MONTHLY_ONCE", "VIP_MONTHLY_AUTO", "VIP_LIFETIME"] as const)(
    "previews a new %s purchase from the Phase 1 outbox",
    async (product) => {
      const owner = await user();
      const { event } = await purchase(owner.id, product);
      await memberships.processVerifiedEvent(event);
      await drain();
      const history = await latest();
      expect(history.outcome).toBe("preview");
      expect(history.preview.add).toEqual([
        product === "VIP_LIFETIME"
          ? config.DISCORD_VIP_LIFETIME_ROLE_ID
          : config.DISCORD_VIP_MONTHLY_ROLE_ID,
      ]);
      expect(history.preview.entitlementReferences).toHaveLength(1);
      expect(
        (await pool.query("SELECT count(*)::int AS n FROM discord_sync_jobs"))
          .rows[0]?.n,
      ).toBe(1);
      expect(adapter.mutations).toHaveLength(0);
      expect(adapter.members.get(memberId)?.roles).toEqual([]);
    },
  );
  it("recomputes a stale paid snapshot after monthly expiration", async () => {
    const owner = await user();
    await purchase(owner.id);
    adapter.members.get(memberId)!.roles = [config.DISCORD_VIP_MONTHLY_ROLE_ID];
    await own(owner.id, config.DISCORD_VIP_MONTHLY_ROLE_ID);
    now = date("2026-03-01T00:00:00Z");
    await drain();
    const preview = (await latest()).preview;
    expect(preview.effectiveMembership).toBe("FREE");
    expect(preview.remove).toEqual([config.DISCORD_VIP_MONTHLY_ROLE_ID]);
    expect(preview.permitted).toBe(true);
  });
  it("preserves a confirmed renewal despite an older expiration job", async () => {
    const owner = await user();
    const initial = await purchase(owner.id, "VIP_MONTHLY_AUTO");
    await enqueueSync(pool, owner.id, "old_expiration");
    await purchase(
      owner.id,
      "VIP_MONTHLY_AUTO",
      "2026-03-01T00:00:00Z",
      initial.subscriptionId,
    );
    now = date("2026-03-15T00:00:00Z");
    await drain();
    expect((await latest()).preview.effectiveMembership).toBe("VIP_MONTHLY");
  });
  it("keeps cancelled membership until its paid period ends", async () => {
    const owner = await user();
    const first = await purchase(owner.id, "VIP_MONTHLY_AUTO");
    await memberships.processVerifiedEvent(
      paymentProvider.createCancellation({
        userId: owner.id,
        providerSubscriptionId: first.subscriptionId,
        eventId: randomUUID(),
        occurredAt: now,
        correlationId: randomUUID(),
      }),
    );
    await drain();
    expect((await latest()).preview.effectiveMembership).toBe("VIP_MONTHLY");
  });
  it("does not extend Discord access after a failed renewal", async () => {
    const owner = await user();
    const first = await purchase(owner.id, "VIP_MONTHLY_AUTO");
    now = date("2026-03-01T00:00:00Z");
    await memberships.processVerifiedEvent(
      paymentProvider.createFailedRenewal({
        userId: owner.id,
        providerSubscriptionId: first.subscriptionId,
        providerPaymentId: randomUUID(),
        eventId: randomUUID(),
        occurredAt: now,
        correlationId: randomUUID(),
      }),
    );
    await drain();
    expect((await latest()).preview.effectiveMembership).toBe("FREE");
  });
  it.each(["VIP_MONTHLY_ONCE", "VIP_LIFETIME"] as const)(
    "reconciles refund of %s",
    async (product) => {
      const owner = await user();
      const paid = await purchase(owner.id, product);
      const role =
        product === "VIP_LIFETIME"
          ? config.DISCORD_VIP_LIFETIME_ROLE_ID
          : config.DISCORD_VIP_MONTHLY_ROLE_ID;
      adapter.members.get(memberId)!.roles = [role];
      await own(owner.id, role);
      await memberships.processVerifiedEvent(
        paymentProvider.createReversal({
          userId: owner.id,
          providerPaymentId: paid.id,
          eventId: randomUUID(),
          occurredAt: now,
          correlationId: randomUUID(),
        }),
      );
      await drain();
      expect((await latest()).preview.remove).toEqual([role]);
    },
  );
  it("converges Monthly to Lifetime and protects unrelated Founder and Staff roles", async () => {
    const owner = await user();
    await purchase(owner.id);
    await purchase(owner.id, "VIP_LIFETIME");
    adapter.members.get(memberId)!.roles = [
      config.DISCORD_FOUNDER_ROLE_ID,
      config.DISCORD_STAFF_ROLE_ID,
      config.DISCORD_VIP_MONTHLY_ROLE_ID,
    ];
    await own(owner.id, config.DISCORD_VIP_MONTHLY_ROLE_ID);
    await drain();
    const preview = (await latest()).preview;
    expect(preview.add).toEqual([config.DISCORD_VIP_LIFETIME_ROLE_ID]);
    expect(preview.remove).toEqual([config.DISCORD_VIP_MONTHLY_ROLE_ID]);
  });
  it("preserves Lifetime when Monthly expires or is refunded", async () => {
    const owner = await user();
    const month = await purchase(owner.id);
    await purchase(owner.id, "VIP_LIFETIME");
    adapter.members.get(memberId)!.roles = [
      config.DISCORD_VIP_LIFETIME_ROLE_ID,
    ];
    now = date("2030-01-01T00:00:00Z");
    await memberships.processVerifiedEvent(
      paymentProvider.createReversal({
        userId: owner.id,
        providerPaymentId: month.id,
        eventId: randomUUID(),
        occurredAt: now,
        correlationId: randomUUID(),
      }),
    );
    await drain();
    expect((await latest()).preview.remove).toEqual([]);
    expect((await latest()).preview.effectiveMembership).toBe("VIP_LIFETIME");
  });
  it("retains overlapping Monthly access when a separate Lifetime is disputed", async () => {
    const owner = await user();
    await purchase(owner.id);
    await purchase(owner.id);
    const lifetime = await purchase(owner.id, "VIP_LIFETIME");
    now = date("2026-03-15T00:00:00Z");
    await memberships.processVerifiedEvent(
      paymentProvider.createReversal({
        userId: owner.id,
        providerPaymentId: lifetime.id,
        eventId: randomUUID(),
        occurredAt: now,
        correlationId: randomUUID(),
        dispute: true,
      }),
    );
    await drain();
    expect((await latest()).preview.effectiveMembership).toBe("VIP_MONTHLY");
  });
  it("blocks unknown manually assigned roles and audits a conflict", async () => {
    const owner = await user();
    adapter.members.get(memberId)!.roles = [
      config.DISCORD_VIP_LIFETIME_ROLE_ID,
    ];
    await sync.enqueue(owner.id, "test_manual_role");
    await drain();
    const history = await latest();
    expect(history.outcome).toBe("dead_letter");
    expect(history.preview.ownershipConflicts).toEqual([
      config.DISCORD_VIP_LIFETIME_ROLE_ID,
    ]);
    expect(adapter.mutations).toHaveLength(0);
    await expect(
      sync.queue.retry(history.job_id, owner.id),
    ).rejects.toMatchObject({ code: "JOB_NOT_RETRYABLE" });
  });
});

describe("durable job execution and recovery", () => {
  it("handles concurrent workers without processing a job twice", async () => {
    const owner = await user();
    await purchase(owner.id);
    await Promise.all(Array.from({ length: 8 }, () => sync.runOne()));
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM discord_sync_history"))
        .rows[0]?.n,
    ).toBe(1);
  });
  it("leases a large batch with SKIP LOCKED and processes all jobs once", async () => {
    const owner = await user();
    await purchase(owner.id);
    await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        enqueueSync(pool, owner.id, "batch", `batch-${i}`),
      ),
    );
    const workers = Array.from({ length: 4 }, async () => {
      for (let i = 0; i < 30; i++) if (!(await sync.runOne())) break;
    });
    await Promise.all(workers);
    const stats = await pool.query(
      "SELECT count(*)::int AS n FROM discord_sync_jobs WHERE status='succeeded'",
    );
    expect(stats.rows[0]?.n).toBe(61);
    expect(
      (
        await pool.query(
          "SELECT count(DISTINCT job_id)::int AS n FROM discord_sync_history",
        )
      ).rows[0]?.n,
    ).toBe(61);
  });
  it("respects Retry-After globally across workers and recovers", async () => {
    const owner = await user();
    await purchase(owner.id);
    adapter.failure = new DiscordFailure("DISCORD_RATE_LIMITED", true, 90000);
    await sync.runOne();
    const job = (await pool.query("SELECT * FROM discord_sync_jobs")).rows[0]!;
    expect(job.status).toBe("retry");
    expect(job.available_at.getTime() - Date.now()).toBeGreaterThan(88000);
    expect(await sync.runOne()).toBe(false);
    adapter.failure = undefined;
    await pool.query(
      "UPDATE discord_runtime SET next_request_at=now()-interval '1 second'",
    );
    await pool.query(
      "UPDATE discord_sync_jobs SET available_at=now()-interval '1 second'",
    );
    await drain();
    expect((await latest()).outcome).toBe("preview");
  });
  it("retries temporary outages and allows explicit retry after exhaustion", async () => {
    const owner = await user();
    await purchase(owner.id);
    await pool.query("UPDATE discord_sync_jobs SET max_attempts=1");
    adapter.failure = new DiscordFailure("DISCORD_UNAVAILABLE", true);
    await sync.runOne();
    const failed = await latest();
    expect(failed.outcome).toBe("dead_letter");
    adapter.failure = undefined;
    await sync.queue.retry(failed.job_id, owner.id);
    await drain();
    expect((await latest()).outcome).toBe("preview");
  });
  it.each(["DISCORD_PERMISSION_DENIED", "VIP_HIERARCHY_INVALID"])(
    "does not repeatedly retry permanent %s",
    async (code) => {
      const owner = await user();
      await purchase(owner.id);
      if (code === "VIP_HIERARCHY_INVALID")
        adapter.guild.roles[1]!.position = 100;
      else adapter.failure = new DiscordFailure(code);
      await drain();
      expect((await latest()).outcome).toBe("dead_letter");
      expect(await sync.reconcileBatch()).toBe(0);
      expect(await sync.runOne()).toBe(false);
    },
  );
  it("marks an absent member and enqueues again on a trusted rejoin event", async () => {
    const owner = await user();
    await purchase(owner.id);
    adapter.members.delete(memberId);
    await drain();
    expect((await latest()).outcome).toBe("member_absent");
    adapter.members.set(memberId, { id: memberId, roles: [] });
    await sync.memberRejoined(config.DISCORD_GUILD_ID, memberId, "join-1");
    await sync.memberRejoined(config.DISCORD_GUILD_ID, memberId, "join-1");
    await drain();
    expect((await latest()).preview.add).toEqual([
      config.DISCORD_VIP_MONTHLY_ROLE_ID,
    ]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM discord_sync_jobs WHERE reason='member_rejoined'",
        )
      ).rows[0]?.n,
    ).toBe(1);
  });
  it("recovers an abandoned lease after process restart and fences the old worker", async () => {
    const owner = await user();
    await purchase(owner.id);
    const abandoned = await sync.queue.claim("crashed-worker");
    expect(abandoned).not.toBeNull();
    await pool.query(
      "UPDATE discord_sync_jobs SET lease_expires_at=now()-interval '1 second'",
    );
    const restarted = new DiscordSyncService(
      pool,
      config,
      memberships,
      adapter,
      () => now,
      () => 0,
    );
    await restarted.runOne();
    await sync.process(abandoned!);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM discord_sync_history WHERE outcome='preview'",
        )
      ).rows[0]?.n,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM discord_sync_history WHERE outcome='lease_recovered'",
        )
      ).rows[0]?.n,
    ).toBe(1);
  });
  it("records sanitized failure details without storing an adapter secret", async () => {
    const owner = await user();
    await purchase(owner.id);
    adapter.inspectGuild = async () => {
      throw new Error("Authorization: Bot SUPER-SECRET");
    };
    await sync.runOne();
    expect(
      JSON.stringify(
        (await pool.query("SELECT * FROM discord_sync_history")).rows,
      ),
    ).not.toContain("SUPER-SECRET");
    expect((await latest()).error_code).toBe("INTERNAL_SYNC_FAILURE");
  });
  it("scans linked accounts in bounded persistent pages, including Lifetime-to-Monthly fallback", async () => {
    const owner = await user();
    await purchase(owner.id);
    await drain();
    expect(await sync.reconcileBatch()).toBe(1);
    await drain();
    expect(await sync.reconcileBatch()).toBe(0);
    const stats = await sync.stats();
    expect(stats.mode).toBe("offline-dry-run");
  });
  it("coordinates rate reservations across independent database clients", async () => {
    const gate = new PostgresDiscordRateGate(pool, "rate-contract-test", 250);
    const slots = await Promise.all(
      Array.from({ length: 4 }, () => gate.reserve()),
    );
    expect(new Set(slots).size).toBe(4);
    expect(Math.max(...slots)).toBeGreaterThan(600);
    await gate.defer(10000);
    await expect(gate.reserve()).rejects.toMatchObject({
      code: "DISCORD_RATE_LIMITED",
      retryable: true,
    });
  });
  it("advances a persistent reconciliation cursor over several pages without duplicate jobs", async () => {
    const seed = await user(false);
    for (let i = 0; i < 21; i++) {
      const owner = (
        await pool.query<{ id: string }>(
          `INSERT INTO app_users(email,password_hash)
        SELECT $1,password_hash FROM app_users WHERE id=$2 RETURNING id`,
          [`batch-${i}@example.test`, seed.id],
        )
      ).rows[0]!;
      await pool.query(
        "INSERT INTO discord_accounts(user_id,discord_user_id) VALUES($1,$2)",
        [owner.id, String(300000000000000000n + BigInt(i))],
      );
    }
    const pages = await Promise.all([
      sync.reconcileBatch(),
      sync.reconcileBatch(),
    ]);
    expect(pages).toEqual([10, 10]);
    expect(await sync.reconcileBatch()).toBe(1);
    expect(await sync.reconcileBatch()).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT count(DISTINCT user_id)::int AS n FROM discord_sync_jobs",
        )
      ).rows[0]?.n,
    ).toBe(21);
  });
});

describe("OAuth linking lifecycle and authorization", () => {
  it("links verified ID with PKCE without granting membership", async () => {
    const owner = await user(false);
    const flow = await linkStart(owner.id, owner.email);
    const saved = (await pool.query("SELECT * FROM discord_oauth_states"))
      .rows[0]!;
    expect(saved.state_hash).not.toBe(flow.state);
    expect(saved.verifier_ciphertext).not.toContain(flow.session.token);
    expect(
      await links.complete(flow.session.token, flow.state, flow.code),
    ).toEqual({ linked: true, discordUserId: memberId });
    expect(await memberships.activeTier(owner.id, now)).toBe("FREE");
    await expect(
      links.complete(flow.session.token, flow.state, flow.code),
    ).rejects.toMatchObject({ code: "OAUTH_STATE_INVALID" });
  });
  it("rejects incorrect state, another session, expired state, CSRF and bad reauthentication", async () => {
    const owner = await user(false);
    const flow = await linkStart(owner.id, owner.email);
    const another = await auth.login(owner.email, password);
    await expect(
      links.complete(another.token, flow.state, flow.code),
    ).rejects.toMatchObject({ code: "OAUTH_STATE_INVALID" });
    await expect(
      links.complete(flow.session.token, "invalid-state", flow.code),
    ).rejects.toThrow();
    await expect(
      links.begin(flow.session.token, "wrong", password),
    ).rejects.toMatchObject({ code: "INVALID_CSRF" });
    await expect(
      links.begin(
        flow.session.token,
        flow.session.csrfToken,
        "incorrect-password",
      ),
    ).rejects.toMatchObject({ code: "REAUTHENTICATION_FAILED" });
    await pool.query(
      "UPDATE discord_oauth_states SET expires_at=now()-interval '1 second'",
    );
    await expect(
      links.complete(flow.session.token, flow.state, flow.code),
    ).rejects.toThrow();
  });
  it("rejects linking the same Discord ID to two accounts under concurrency", async () => {
    const a = await user(false);
    const b = await user(false);
    const fa = await linkStart(a.id, a.email);
    const fb = await linkStart(b.id, b.email);
    const results = await Promise.allSettled([
      links.complete(fa.session.token, fa.state, fa.code),
      links.complete(fb.session.token, fb.state, fb.code),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM discord_accounts"))
        .rows[0]?.n,
    ).toBe(1);
  });
  it("requires explicit replacement and cleans old identity without moving entitlement", async () => {
    const owner = await user();
    await purchase(owner.id, "VIP_LIFETIME");
    adapter.members.get(memberId)!.roles = [
      config.DISCORD_VIP_LIFETIME_ROLE_ID,
    ];
    adapter.members.set(secondId, { id: secondId, roles: [] });
    await own(owner.id, config.DISCORD_VIP_LIFETIME_ROLE_ID);
    const session = await auth.login(owner.email, password);
    await expect(
      links.begin(session.token, session.csrfToken, password),
    ).rejects.toMatchObject({ code: "REPLACEMENT_CONFIRMATION_REQUIRED" });
    const flow = await linkStart(owner.id, owner.email, secondId, true);
    await links.complete(flow.session.token, flow.state, flow.code);
    await drain();
    const cleanup = (
      await pool.query(
        "SELECT h.preview FROM discord_sync_history h JOIN discord_sync_jobs j ON j.id=h.job_id WHERE j.reason='identity_replaced_cleanup'",
      )
    ).rows[0]!.preview;
    expect(cleanup.discordUserId).toBe(memberId);
    expect(cleanup.effectiveMembership).toBe("FREE");
    expect(cleanup.remove).toEqual([config.DISCORD_VIP_LIFETIME_ROLE_ID]);
    expect((await sync.preview(owner.id))?.discordUserId).toBe(secondId);
    expect(await memberships.activeTier(owner.id, now)).toBe("VIP_LIFETIME");
  });
  it("unlinks safely while retaining a reserved identity and a durable cleanup job", async () => {
    const owner = await user();
    await purchase(owner.id);
    adapter.members.get(memberId)!.roles = [config.DISCORD_VIP_MONTHLY_ROLE_ID];
    await own(owner.id, config.DISCORD_VIP_MONTHLY_ROLE_ID);
    const session = await auth.login(owner.email, password);
    await links.unlink(session.token, session.csrfToken, password);
    await drain();
    expect(await links.status(owner.id)).toMatchObject({ linked: false });
    expect((await latest()).preview.remove).toEqual([
      config.DISCORD_VIP_MONTHLY_ROLE_ID,
    ]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM discord_identity_reservations",
        )
      ).rows[0]?.n,
    ).toBe(1);
  });
  it("serves the authenticated same-origin OAuth callback bridge without leaking tokens", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/discord/callback?code=not-a-secret-fixture&state=fixture",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.body).not.toContain("not-a-secret-fixture");
  });
  it("enforces administrator RBAC, CSRF, allowlisted ownership input and reauthentication", async () => {
    const owner = await user();
    const admin = await user(false, "admin");
    const session = await auth.login(owner.email, password);
    const adminSession = await auth.login(admin.email, password);
    const path = `/admin/discord/users/${owner.id}/sync`;
    expect((await app.inject({ method: "POST", url: path })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/admin/discord/statistics",
          headers: { authorization: `Bearer ${session.token}` },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: path,
          headers: { authorization: `Bearer ${adminSession.token}` },
        })
      ).statusCode,
    ).toBe(401);
    const headers = {
      authorization: `Bearer ${adminSession.token}`,
      "x-csrf-token": adminSession.csrfToken,
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: path,
          headers,
          payload: { roleId: config.DISCORD_FOUNDER_ROLE_ID },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "POST", url: path, headers, payload: {} }))
        .statusCode,
    ).toBe(200);
    adapter.members.get(memberId)!.roles = [config.DISCORD_VIP_MONTHLY_ROLE_ID];
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/admin/discord/users/${owner.id}/ownership`,
          headers,
          payload: {
            password,
            roleKey: "VIP_MONTHLY",
            policy: "adopt-existing-vip-role",
            confirmation: true,
            reference: "owner-reviewed-fixture",
          },
        })
      ).statusCode,
    ).toBe(200);
    expect((await sync.preview(owner.id))?.permitted).toBe(true);
  });
  it("keeps commands private, scoped to the requester, and free of billing details", async () => {
    const owner = await user();
    await purchase(owner.id, "VIP_LIFETIME");
    const commands = new DiscordCommands(pool, memberships, config);
    const response = await commands.handle(
      config.DISCORD_GUILD_ID,
      memberId,
      "membership",
    );
    expect(response.data.flags).toBe(64);
    expect(response.data.content).not.toContain(owner.email);
    expect(response.data.content).not.toContain("EUR");
    expect(
      (await commands.handle(config.DISCORD_GUILD_ID, secondId, "membership"))
        .data.content,
    ).toContain("not linked");
    await expect(
      commands.handle("200000000000000099", memberId, "membership"),
    ).rejects.toThrow();
  });
  it("verifies signatures on the HTTP raw body before invoking a slash command", async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKey = (
      keys.publicKey.export({ format: "der", type: "spki" }) as Buffer
    )
      .subarray(-32)
      .toString("hex");
    const interactionConfig = loadDiscordConfig({
      DISCORD_INTERACTIONS_PUBLIC_KEY: publicKey,
    });
    const signedSync = new DiscordSyncService(
      pool,
      interactionConfig,
      memberships,
      adapter,
    );
    const signedApp = buildApp({
      auth,
      memberships,
      production: false,
      discord: { sync: signedSync, links },
    });
    await signedApp.ready();
    try {
      const payload = JSON.stringify({
        type: 2,
        application_id: config.DISCORD_CLIENT_ID,
        guild_id: config.DISCORD_GUILD_ID,
        member: { user: { id: memberId } },
        data: { name: "help" },
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = sign(
        null,
        Buffer.from(timestamp + payload),
        keys.privateKey,
      ).toString("hex");
      const headers = {
        "content-type": "application/json",
        "x-signature-ed25519": signature,
        "x-signature-timestamp": timestamp,
      };
      const good = await signedApp.inject({
        method: "POST",
        url: "/api/discord/interactions",
        headers,
        payload,
      });
      expect(good.statusCode).toBe(200);
      expect(good.json().data.flags).toBe(64);
      expect(
        (
          await signedApp.inject({
            method: "POST",
            url: "/api/discord/interactions",
            headers,
            payload: "{}",
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await signedApp.close();
    }
  });
});

describe("Phase 2 migration reversibility", () => {
  it("rolls back 002 and reapplies it without losing Phase 1 users or entitlements", async () => {
    const owner = await user();
    await purchase(owner.id, "VIP_LIFETIME");
    await migrateDown(pool);
    expect(await memberships.activeTier(owner.id, now)).toBe("VIP_LIFETIME");
    await migrateUp(pool);
    expect(
      (
        await pool.query(
          "SELECT user_id FROM discord_identity_reservations WHERE discord_user_id=$1",
          [memberId],
        )
      ).rows[0]?.user_id,
    ).toBe(owner.id);
    expect(await memberships.activeTier(owner.id, now)).toBe("VIP_LIFETIME");
  });
});
