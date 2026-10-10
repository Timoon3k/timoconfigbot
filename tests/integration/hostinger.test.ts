import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { createPool } from "../../src/db/pool.js";
import { migrateUp } from "../../src/db/migrate.js";
import {
  DiscordSupervisor,
  type ManagedTasks,
} from "../../src/discord/supervisor.js";
import { AuthService } from "../../src/auth/service.js";
import { MembershipService } from "../../src/membership/service.js";
import { MockPaymentProvider } from "../../src/payments/mock.js";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Disposable test database required.");
const pool = createPool(url);
const supervisors: Array<{
  supervisor: DiscordSupervisor;
  run: Promise<void>;
}> = [];
beforeAll(async () => migrateUp(pool));
beforeEach(async () => {
  await pool.query(`TRUNCATE administrative_audit_logs,discord_sync_jobs,payment_events,membership_entitlements,
  payments,billing_subscriptions,orders,discord_accounts,user_sessions,app_users RESTART IDENTITY CASCADE`);
});
afterEach(async () => {
  for (const s of supervisors) s.supervisor.stop();
  await Promise.all(supervisors.map((s) => s.run));
  supervisors.length = 0;
});
afterAll(async () => pool.end());
function background() {
  let starts = 0,
    stops = 0;
  const factory = (): ManagedTasks => {
    const task = () => {
      let finish: () => void = () => undefined;
      return {
        run: () => {
          starts++;
          return new Promise<void>((r) => {
            finish = r;
          });
        },
        stop: () => {
          stops++;
          finish();
        },
      };
    };
    return {
      worker: { ...task(), lastCompletedAt: Date.now() },
      gateway: { ...task(), connected: true },
    };
  };
  return { factory, starts: () => starts, stops: () => stops };
}
function start(factory: () => ManagedTasks) {
  const supervisor = new DiscordSupervisor(
    pool,
    "900000000000000001",
    factory,
    20,
  );
  supervisors.push({ supervisor, run: supervisor.run() });
  return supervisor;
}
describe("managed runtime leadership and recovery", () => {
  it("prevents duplicate Gateway sessions and hands off after a managed process shutdown", async () => {
    const a = background(),
      b = background();
    const first = start(a.factory);
    await vi.waitFor(() => expect(first.state).toBe("leader"));
    const second = start(b.factory);
    await vi.waitFor(() => expect(second.state).toBe("standby"));
    expect(a.starts()).toBe(2);
    expect(b.starts()).toBe(0);
    expect(first.health().ready).toBe(true);
    first.stop();
    await supervisors[0]!.run;
    await vi.waitFor(() => expect(second.state).toBe("leader"));
    expect(b.starts()).toBe(2);
    expect(a.stops()).toBeGreaterThanOrEqual(2);
  });
  it("stops worker/Gateway on a real PostgreSQL connection loss and recovers with a fresh session", async () => {
    const tasks = background();
    const runtime = start(tasks.factory);
    await vi.waitFor(() => expect(runtime.state).toBe("leader"));
    const pid = (
      await pool.query<{
        pid: number;
      }>(`SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted
      AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) LIMIT 1`)
    ).rows[0]!.pid;
    await pool.query("SELECT pg_terminate_backend($1)", [pid]);
    await vi.waitFor(() => expect(tasks.starts()).toBeGreaterThanOrEqual(4));
    expect(tasks.stops()).toBeGreaterThanOrEqual(2);
    expect(runtime.health().ready).toBe(true);
  });
  it("marks disconnected Gateway/stale worker unready", async () => {
    const tasks = background();
    let group: ManagedTasks;
    const runtime = start(() => {
      group = tasks.factory();
      return group;
    });
    await vi.waitFor(() => expect(runtime.state).toBe("leader"));
    group!.gateway!.connected = false;
    expect(runtime.health().ready).toBe(false);
    group!.gateway!.connected = true;
    group!.worker.lastCompletedAt = Date.now() - 61000;
    expect(runtime.health().ready).toBe(false);
  });
});
describe("production simulation isolation", () => {
  it("rejects mock writes and ignores mock entitlements without modifying the existing membership engine", async () => {
    const auth = new AuthService(
      pool,
      "test-password-pepper-32-characters",
      "test-session-pepper-32-characters!",
    );
    const user = await auth.createUser(
      `${randomUUID()}@example.test`,
      "Strong-test-password-12345!",
    );
    const mock = new MockPaymentProvider();
    const sandbox = new MembershipService(pool);
    const production = new MembershipService(pool, false);
    const id = randomUUID();
    await sandbox.createOrder({
      userId: user.id,
      productCode: "VIP_LIFETIME",
      providerOrderId: id,
      idempotencyKey: id,
    });
    const event = mock.createPurchase({
      userId: user.id,
      productCode: "VIP_LIFETIME",
      providerOrderId: id,
      providerPaymentId: id,
      eventId: id,
      occurredAt: new Date(),
      correlationId: randomUUID(),
    });
    await sandbox.processVerifiedEvent(event);
    expect(await sandbox.activeTier(user.id)).toBe("VIP_LIFETIME");
    expect(await production.activeTier(user.id)).toBe("FREE");
    await expect(
      production.processVerifiedEvent({ ...event, eventId: randomUUID() }),
    ).rejects.toMatchObject({ code: "MOCK_PAYMENTS_DISABLED" });
    await expect(
      production.createOrder({
        userId: user.id,
        productCode: "VIP_LIFETIME",
        providerOrderId: "blocked",
        idempotencyKey: "blocked",
      }),
    ).rejects.toThrow();
    expect(
      (await pool.query("SELECT count(*)::int AS count FROM payment_events"))
        .rows[0].count,
    ).toBe(1);
  });
});
describe.skipIf(!process.env.TEST_DB_CA_CERT_FILE)(
  "verified PostgreSQL TLS",
  () => {
    it("uses certificate-verified TLS when a disposable TLS fixture is configured", async () => {
      const path = process.env.TEST_DB_CA_CERT_FILE;
      if (!path)
        throw new Error(
          "TEST_DB_CA_CERT_FILE is required for the TLS integration check.",
        );
      const ca = await readFile(path, "utf8");
      const tlsPool = createPool(url!, {
        DB_SSL_MODE: "require",
        DB_CA_CERT: ca,
      });
      try {
        expect(
          (
            await tlsPool.query(
              "SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()",
            )
          ).rows[0].ssl,
        ).toBe(true);
      } finally {
        await tlsPool.end();
      }
      const untrusted = createPool(url!, { DB_SSL_MODE: "require" });
      try {
        await expect(untrusted.query("SELECT 1")).rejects.toThrow();
      } finally {
        await untrusted.end();
      }
    });
  },
);
