import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../../src/auth/service.js';
import { migrateUp } from '../../src/db/migrate.js';
import { createPool, type DatabasePool } from '../../src/db/pool.js';
import { buildApp } from '../../src/http/app.js';
import { MembershipService } from '../../src/membership/service.js';
import { MockPaymentProvider } from '../../src/payments/mock.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required for integration tests.');

const passwordPepper = 'integration-password-pepper-32-characters';
const sessionPepper = 'integration-session-pepper-32-characters!';
const mock = new MockPaymentProvider();
let pool: DatabasePool;
let auth: AuthService;
let memberships: MembershipService;
let app: FastifyInstance;

const at = (iso: string): Date => new Date(iso);

async function customer(email = `${randomUUID()}@example.test`) {
  return auth.createUser(email, 'Correct-Horse-Battery-Staple-123!');
}

async function oneTimePurchase(input: {
  userId: string;
  productCode?: 'VIP_MONTHLY_ONCE' | 'VIP_LIFETIME';
  occurredAt?: Date;
  eventId?: string;
  paymentId?: string;
  orderId?: string;
}) {
  const productCode = input.productCode ?? 'VIP_MONTHLY_ONCE';
  const providerOrderId = input.orderId ?? `order-${randomUUID()}`;
  await memberships.createOrder({ userId: input.userId, productCode, providerOrderId, idempotencyKey: providerOrderId });
  const event = mock.createPurchase({
    userId: input.userId,
    productCode,
    providerOrderId,
    providerPaymentId: input.paymentId ?? `payment-${randomUUID()}`,
    eventId: input.eventId ?? `event-${randomUUID()}`,
    occurredAt: input.occurredAt ?? at('2026-01-10T12:00:00Z'),
    correlationId: randomUUID(),
  });
  return { event, result: await memberships.processVerifiedEvent(event) };
}

async function subscriptionFixture(userId: string, providerSubscriptionId = `subscription-${randomUUID()}`) {
  await memberships.createSubscription({ userId, providerSubscriptionId });
  return providerSubscriptionId;
}

beforeAll(async () => {
  pool = createPool(databaseUrl);
  await migrateUp(pool);
  auth = new AuthService(pool, passwordPepper, sessionPepper);
  memberships = new MembershipService(pool);
  app = buildApp({ auth, memberships, production: false });
  await app.ready();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE administrative_audit_logs, discord_sync_jobs, payment_events, membership_entitlements,
    payments, billing_subscriptions, orders, discord_accounts, user_sessions, app_users RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('membership event processing', () => {
  it('grants an initial monthly purchase and expires at the exact calendar-month boundary', async () => {
    const user = await customer();
    const { result } = await oneTimePurchase({ userId: user.id, occurredAt: at('2026-01-31T12:00:00Z') });
    expect(result).toEqual({ duplicate: false, tier: 'VIP_MONTHLY' });
    expect(await memberships.activeTier(user.id, at('2026-02-28T11:59:59.999Z'))).toBe('VIP_MONTHLY');
    expect(await memberships.activeTier(user.id, at('2026-02-28T12:00:00Z'))).toBe('FREE');
    expect((await pool.query('SELECT count(*)::int AS count FROM discord_sync_jobs WHERE dry_run = true')).rows[0]?.count).toBe(1);
  });

  it('deduplicates the same event under concurrent delivery', async () => {
    const user = await customer();
    const providerOrderId = `order-${randomUUID()}`;
    await memberships.createOrder({ userId: user.id, productCode: 'VIP_LIFETIME', providerOrderId, idempotencyKey: providerOrderId });
    const event = mock.createPurchase({ userId: user.id, productCode: 'VIP_LIFETIME', providerOrderId,
      providerPaymentId: `payment-${randomUUID()}`, eventId: `event-${randomUUID()}`,
      occurredAt: at('2026-02-01T00:00:00Z'), correlationId: randomUUID() });
    const results = await Promise.all([memberships.processVerifiedEvent(event), memberships.processVerifiedEvent(event)]);
    expect(results.filter((item) => item.duplicate)).toHaveLength(1);
    expect((await pool.query('SELECT count(*)::int AS count FROM membership_entitlements')).rows[0]?.count).toBe(1);
  });

  it('rejects a duplicate provider payment delivered under a different event ID', async () => {
    const user = await customer();
    await oneTimePurchase({ userId: user.id, productCode: 'VIP_LIFETIME', paymentId: 'provider-payment-once' });
    const providerOrderId = 'second-order-for-duplicate-payment';
    await memberships.createOrder({ userId: user.id, productCode: 'VIP_LIFETIME', providerOrderId, idempotencyKey: providerOrderId });
    const duplicatePurchase = mock.createPurchase({ userId: user.id, productCode: 'VIP_LIFETIME', providerOrderId,
      providerPaymentId: 'provider-payment-once', eventId: 'different-event-id', occurredAt: at('2026-02-02T00:00:00Z'),
      correlationId: randomUUID() });
    await expect(memberships.processVerifiedEvent(duplicatePurchase)).rejects.toMatchObject({ code: '23505' });
    expect((await pool.query('SELECT count(*)::int AS count FROM membership_entitlements')).rows[0]?.count).toBe(1);
    expect((await pool.query("SELECT status FROM payment_events WHERE provider_event_id = 'different-event-id'")).rows[0]?.status).toBe('failed');
  });

  it('extends access only for successful subscription periods and preserves paid access after cancellation', async () => {
    const user = await customer();
    const subscriptionId = await subscriptionFixture(user.id);
    const first = mock.createPurchase({ userId: user.id, productCode: 'VIP_MONTHLY_AUTO', providerOrderId: 'unused-order',
      providerPaymentId: 'subscription-payment-1', eventId: 'subscription-event-1', occurredAt: at('2026-03-01T00:00:00Z'),
      correlationId: randomUUID(), providerSubscriptionId: subscriptionId,
      periodStart: at('2026-03-01T00:00:00Z'), periodEnd: at('2026-04-01T00:00:00Z') });
    await memberships.processVerifiedEvent(first);
    await memberships.processVerifiedEvent(mock.createCancellation({ userId: user.id, providerSubscriptionId: subscriptionId,
      eventId: 'cancel-1', occurredAt: at('2026-03-15T00:00:00Z'), correlationId: randomUUID() }));
    expect(await memberships.activeTier(user.id, at('2026-03-31T23:59:59Z'))).toBe('VIP_MONTHLY');
    expect(await memberships.activeTier(user.id, at('2026-04-01T00:00:00Z'))).toBe('FREE');
    const state = await pool.query('SELECT status, cancel_at_period_end FROM billing_subscriptions');
    expect(state.rows[0]).toMatchObject({ status: 'cancel_scheduled', cancel_at_period_end: true });
  });

  it('adds a confirmed renewal but failed renewal grants no extra entitlement', async () => {
    const user = await customer();
    const subscriptionId = await subscriptionFixture(user.id);
    for (const [index, start, end] of [
      ['1', '2026-04-01T00:00:00Z', '2026-05-01T00:00:00Z'],
      ['2', '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z'],
    ] as const) {
      await memberships.processVerifiedEvent(mock.createPurchase({ userId: user.id, productCode: 'VIP_MONTHLY_AUTO',
        providerOrderId: `unused-${index}`, providerPaymentId: `renewal-payment-${index}`, eventId: `renewal-event-${index}`,
        occurredAt: at(start), correlationId: randomUUID(), providerSubscriptionId: subscriptionId,
        periodStart: at(start), periodEnd: at(end) }));
    }
    await memberships.processVerifiedEvent(mock.createFailedRenewal({ userId: user.id, providerSubscriptionId: subscriptionId,
      providerPaymentId: 'failed-payment-3', eventId: 'failed-event-3', occurredAt: at('2026-06-01T00:00:00Z'), correlationId: randomUUID() }));
    expect(await memberships.activeTier(user.id, at('2026-05-31T23:59:59Z'))).toBe('VIP_MONTHLY');
    expect(await memberships.activeTier(user.id, at('2026-06-01T00:00:00Z'))).toBe('FREE');
    expect((await pool.query('SELECT count(*)::int AS count FROM membership_entitlements')).rows[0]?.count).toBe(2);
  });

  it('gives Lifetime priority and preserves it when an unrelated Monthly payment is refunded', async () => {
    const user = await customer();
    const monthly = await oneTimePurchase({ userId: user.id, paymentId: 'monthly-payment' });
    await oneTimePurchase({ userId: user.id, productCode: 'VIP_LIFETIME', paymentId: 'lifetime-payment', occurredAt: at('2026-01-11T00:00:00Z') });
    expect(await memberships.activeTier(user.id, at('2035-01-01T00:00:00Z'))).toBe('VIP_LIFETIME');
    await memberships.processVerifiedEvent(mock.createReversal({ userId: user.id, providerPaymentId: 'monthly-payment',
      eventId: 'refund-monthly', occurredAt: at('2026-01-12T00:00:00Z'), correlationId: randomUUID() }));
    expect(monthly.result.tier).toBe('VIP_MONTHLY');
    expect(await memberships.activeTier(user.id, at('2035-01-01T00:00:00Z'))).toBe('VIP_LIFETIME');
  });

  it('isolates a Lifetime chargeback and retains a separate valid Monthly purchase', async () => {
    const user = await customer();
    await oneTimePurchase({ userId: user.id, paymentId: 'monthly-isolated' });
    await oneTimePurchase({ userId: user.id, productCode: 'VIP_LIFETIME', paymentId: 'lifetime-isolated' });
    await memberships.processVerifiedEvent(mock.createReversal({ userId: user.id, providerPaymentId: 'lifetime-isolated',
      eventId: 'dispute-lifetime', occurredAt: at('2026-01-15T00:00:00Z'), correlationId: randomUUID(), dispute: true }));
    expect(await memberships.activeTier(user.id, at('2026-01-20T00:00:00Z'))).toBe('VIP_MONTHLY');
    const revoked = await pool.query('SELECT count(*)::int AS count FROM membership_entitlements WHERE revoked_at IS NOT NULL');
    expect(revoked.rows[0]?.count).toBe(1);
  });

  it('serializes concurrent one-time purchases into non-overlapping calendar months', async () => {
    const user = await customer();
    const events = await Promise.all(['a', 'b'].map(async (suffix) => {
      const providerOrderId = `concurrent-order-${suffix}`;
      await memberships.createOrder({ userId: user.id, productCode: 'VIP_MONTHLY_ONCE', providerOrderId, idempotencyKey: providerOrderId });
      return mock.createPurchase({ userId: user.id, productCode: 'VIP_MONTHLY_ONCE', providerOrderId,
        providerPaymentId: `concurrent-payment-${suffix}`, eventId: `concurrent-event-${suffix}`,
        occurredAt: at('2026-01-31T12:00:00Z'), correlationId: randomUUID() });
    }));
    await Promise.all(events.map((event) => memberships.processVerifiedEvent(event)));
    const periods = await pool.query<{ valid_from: Date; valid_until: Date }>(
      'SELECT valid_from, valid_until FROM membership_entitlements ORDER BY valid_from',
    );
    expect(periods.rows.map((row) => [row.valid_from.toISOString(), row.valid_until.toISOString()])).toEqual([
      ['2026-01-31T12:00:00.000Z', '2026-02-28T12:00:00.000Z'],
      ['2026-02-28T12:00:00.000Z', '2026-03-28T12:00:00.000Z'],
    ]);
  });

  it('rolls back domain writes on failure and recovers the same event after its prerequisite is fixed', async () => {
    const user = await customer();
    const event = mock.createPurchase({ userId: user.id, productCode: 'VIP_LIFETIME', providerOrderId: 'late-order',
      providerPaymentId: 'recoverable-payment', eventId: 'recoverable-event', occurredAt: at('2026-07-01T00:00:00Z'),
      correlationId: randomUUID() });
    await expect(memberships.processVerifiedEvent(event)).rejects.toMatchObject({ code: 'ORDER_MISMATCH' });
    expect((await pool.query('SELECT count(*)::int AS count FROM payments')).rows[0]?.count).toBe(0);
    expect((await pool.query("SELECT status FROM payment_events WHERE provider_event_id = 'recoverable-event'")).rows[0]?.status).toBe('failed');
    await memberships.createOrder({ userId: user.id, productCode: 'VIP_LIFETIME', providerOrderId: 'late-order', idempotencyKey: 'late-order' });
    await expect(memberships.processVerifiedEvent(event)).resolves.toEqual({ duplicate: false, tier: 'VIP_LIFETIME' });
    expect((await pool.query("SELECT status, attempt_count FROM payment_events WHERE provider_event_id = 'recoverable-event'")).rows[0])
      .toMatchObject({ status: 'processed', attempt_count: 2 });
  });

  it('queues a safe FREE reconciliation only after all overlapping access has expired', async () => {
    const user = await customer();
    await oneTimePurchase({ userId: user.id, occurredAt: at('2026-01-01T00:00:00Z') });
    await oneTimePurchase({ userId: user.id, occurredAt: at('2026-01-15T00:00:00Z') });
    expect(await memberships.reconcileExpired(at('2026-02-02T00:00:00Z'))).toBe(0);
    expect(await memberships.reconcileExpired(at('2026-03-02T00:00:00Z'))).toBe(1);
    expect(await memberships.reconcileExpired(at('2026-03-02T00:00:00Z'))).toBe(0);
  });
});

describe('authentication and administrative authorization', () => {
  it('rejects unauthenticated and customer access to the administrative endpoint', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/memberships' })).statusCode).toBe(401);
    await auth.createUser('customer@example.test', 'Correct-Horse-Battery-Staple-123!');
    const session = await auth.login('customer@example.test', 'Correct-Horse-Battery-Staple-123!');
    const response = await app.inject({ method: 'GET', url: '/admin/memberships', headers: { authorization: `Bearer ${session.token}` } });
    expect(response.statusCode).toBe(403);
  });

  it('allows an authenticated administrator and enforces CSRF on mutating administration', async () => {
    await auth.createUser('admin@example.test', 'Correct-Horse-Battery-Staple-123!', 'admin');
    const session = await auth.login('admin@example.test', 'Correct-Horse-Battery-Staple-123!');
    const headers = { authorization: `Bearer ${session.token}` };
    expect((await app.inject({ method: 'GET', url: '/admin/memberships', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/admin/reconciliation/expired', headers })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/admin/reconciliation/expired', headers: { ...headers, 'x-csrf-token': session.csrfToken } })).statusCode).toBe(200);
  });
});

describe('migration lifecycle', () => {
  it('has recorded the versioned migration with a checksum', async () => {
    const result = await pool.query('SELECT version, length(checksum) AS checksum_length FROM schema_migrations');
    expect(result.rows).toEqual(expect.arrayContaining([{ version: '001_membership_backend', checksum_length: 64 }]));
  });

  it('enforces append-only administrative audit records', async () => {
    const user = await customer();
    await oneTimePurchase({ userId: user.id });
    await expect(pool.query('DELETE FROM administrative_audit_logs')).rejects.toThrow(/append-only/);
  });
});
