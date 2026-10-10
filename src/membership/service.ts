import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseClient, DatabasePool } from '../db/pool.js';
import { inTransaction } from '../db/pool.js';
import { addCalendarMonthsUtc } from '../domain/calendar.js';
import { PRODUCT_SPEC, type EntitlementTier, type ProductCode } from '../domain/products.js';
import { ConflictError, DomainError } from '../errors.js';
import { verifiedPaymentEventSchema, type VerifiedPaymentEvent } from '../payments/types.js';

export type ProcessResult = { duplicate: boolean; tier: EntitlementTier };

type ProductRow = {
  code: ProductCode;
  price_minor: number;
  currency: string;
  entitlement_tier: 'VIP_MONTHLY' | 'VIP_LIFETIME';
  active: boolean;
};

function payloadHash(event: VerifiedPaymentEvent): string {
  return createHash('sha256').update(JSON.stringify(event)).digest('hex');
}

function errorFields(error: unknown): { code: string; message: string } {
  if (error instanceof DomainError || error instanceof ConflictError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: 'PROCESSING_FAILED', message: error.message.slice(0, 500) };
  return { code: 'PROCESSING_FAILED', message: 'Unknown processing error.' };
}

export class MembershipService {
  public constructor(public readonly pool: DatabasePool) {}

  public async createOrder(input: {
    userId: string;
    productCode: ProductCode;
    providerOrderId: string;
    idempotencyKey: string;
  }): Promise<string> {
    const spec = PRODUCT_SPEC[input.productCode];
    return inTransaction(this.pool, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO orders(user_id, product_code, provider, provider_order_id, idempotency_key, amount_minor, currency)
         VALUES ($1, $2, 'mock', $3, $4, $5, $6)
         ON CONFLICT (user_id, idempotency_key) DO UPDATE SET updated_at = orders.updated_at
         RETURNING id`,
        [input.userId, input.productCode, input.providerOrderId, input.idempotencyKey, spec.amountMinor, spec.currency],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Order creation returned no row.');
      await client.query(
        `INSERT INTO administrative_audit_logs(actor_user_id, actor_type, action, target_type, target_id, correlation_id, metadata)
         VALUES ($1, 'user', 'ORDER_CREATED', 'order', $2, $3, $4::jsonb)`,
        [input.userId, row.id, randomUUID(), JSON.stringify({ productCode: input.productCode, provider: 'mock' })],
      );
      return row.id;
    });
  }

  public async createSubscription(input: { userId: string; providerSubscriptionId: string }): Promise<string> {
    try {
      return await inTransaction(this.pool, async (client) => {
        const result = await client.query<{ id: string }>(
          `INSERT INTO billing_subscriptions(user_id, product_code, provider, provider_subscription_id)
           VALUES ($1, 'VIP_MONTHLY_AUTO', 'mock', $2) RETURNING id`,
          [input.userId, input.providerSubscriptionId],
        );
        const row = result.rows[0];
        if (!row) throw new Error('Subscription creation returned no row.');
        await client.query(
          `INSERT INTO administrative_audit_logs(actor_user_id, actor_type, action, target_type, target_id, correlation_id, metadata)
           VALUES ($1, 'user', 'SUBSCRIPTION_CREATED', 'subscription', $2, $3, '{"provider":"mock"}'::jsonb)`,
          [input.userId, row.id, randomUUID()],
        );
        return row.id;
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictError('ACTIVE_SUBSCRIPTION_EXISTS', 'The user already has a live auto-renew subscription.');
      }
      throw error;
    }
  }

  public async processVerifiedEvent(rawEvent: unknown): Promise<ProcessResult> {
    const event = verifiedPaymentEventSchema.parse(rawEvent);
    const hash = payloadHash(event);
    try {
      return await inTransaction(this.pool, async (client) => {
        const inserted = await client.query(
          `INSERT INTO payment_events(provider, provider_event_id, event_type, payload_sha256, correlation_id, status, verified_at)
           VALUES ($1, $2, $3, $4, $5, 'processing', $6)
           ON CONFLICT (provider, provider_event_id) DO NOTHING`,
          [event.provider, event.eventId, event.type, hash, event.correlationId, event.occurredAt],
        );
        const stored = await client.query<{ status: 'processing' | 'processed' | 'failed'; payload_sha256: string }>(
          'SELECT status, payload_sha256 FROM payment_events WHERE provider = $1 AND provider_event_id = $2 FOR UPDATE',
          [event.provider, event.eventId],
        );
        const current = stored.rows[0];
        if (!current) throw new Error('Payment event lock failed.');
        if (current.payload_sha256 !== hash) throw new ConflictError('EVENT_PAYLOAD_MISMATCH', 'The event ID was reused with a different payload.');
        if (inserted.rowCount === 0 && current.status === 'processed') {
          return { duplicate: true, tier: await this.activeTierWith(client, event.userId, event.occurredAt) };
        }
        if (inserted.rowCount === 0) {
          await client.query(
            `UPDATE payment_events SET status = 'processing', attempt_count = attempt_count + 1,
             last_error_code = NULL, last_error_message = NULL WHERE provider = $1 AND provider_event_id = $2`,
            [event.provider, event.eventId],
          );
        }

        const user = await client.query('SELECT id FROM app_users WHERE id = $1 FOR UPDATE', [event.userId]);
        if (user.rowCount !== 1) throw new DomainError('USER_NOT_FOUND', 'The payment event references an unknown user.', 404);

        await this.applyEvent(client, event);
        const tier = await this.activeTierWith(client, event.userId, event.occurredAt);
        await this.enqueueDiscordSync(client, event, tier);
        await this.audit(client, event, tier);
        await client.query(
          `UPDATE payment_events SET status = 'processed', processed_at = now()
           WHERE provider = $1 AND provider_event_id = $2`, [event.provider, event.eventId],
        );
        return { duplicate: false, tier };
      });
    } catch (error) {
      await this.recordFailure(event, hash, error);
      throw error;
    }
  }

  private async recordFailure(event: VerifiedPaymentEvent, hash: string, error: unknown): Promise<void> {
    const details = errorFields(error);
    await this.pool.query(
      `INSERT INTO payment_events(provider, provider_event_id, event_type, payload_sha256, correlation_id, status, verified_at,
         last_error_code, last_error_message)
       VALUES ($1, $2, $3, $4, $5, 'failed', $6, $7, $8)
       ON CONFLICT (provider, provider_event_id) DO UPDATE SET
         status = CASE WHEN payment_events.status = 'processed' THEN payment_events.status ELSE 'failed' END,
         last_error_code = CASE WHEN payment_events.status = 'processed' THEN payment_events.last_error_code ELSE EXCLUDED.last_error_code END,
         last_error_message = CASE WHEN payment_events.status = 'processed' THEN payment_events.last_error_message ELSE EXCLUDED.last_error_message END`,
      [event.provider, event.eventId, event.type, hash, event.correlationId, event.occurredAt, details.code, details.message],
    );
  }

  private async product(client: DatabaseClient, code: ProductCode): Promise<ProductRow> {
    const result = await client.query<ProductRow>(
      'SELECT code, price_minor, currency, entitlement_tier, active FROM membership_products WHERE code = $1', [code],
    );
    const product = result.rows[0];
    if (!product?.active) throw new DomainError('PRODUCT_UNAVAILABLE', 'The membership product is unavailable.');
    return product;
  }

  private async applyEvent(client: DatabaseClient, event: VerifiedPaymentEvent): Promise<void> {
    switch (event.type) {
      case 'PURCHASE_SUCCEEDED':
      case 'SUBSCRIPTION_RENEWED':
        await this.applySuccessfulPayment(client, event);
        return;
      case 'PAYMENT_FAILED':
        await this.applyFailedPayment(client, event);
        return;
      case 'SUBSCRIPTION_CANCELLED':
        await this.applyCancellation(client, event);
        return;
      case 'PAYMENT_REFUNDED':
      case 'PAYMENT_DISPUTED':
        await this.applyReversal(client, event);
        return;
    }
  }

  private async applySuccessfulPayment(
    client: DatabaseClient,
    event: Extract<VerifiedPaymentEvent, { type: 'PURCHASE_SUCCEEDED' | 'SUBSCRIPTION_RENEWED' }>,
  ): Promise<void> {
    const product = await this.product(client, event.productCode);
    if (event.amountMinor !== product.price_minor || event.currency !== product.currency) {
      throw new DomainError('PAYMENT_MISMATCH', 'Payment amount or currency does not match the product.');
    }
    const spec = PRODUCT_SPEC[event.productCode];
    if (spec.billing === 'one_time') {
      if (!event.providerOrderId) throw new DomainError('ORDER_REQUIRED', 'A one-time payment must reference an order.');
      const order = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM orders WHERE user_id = $1 AND provider = $2 AND provider_order_id = $3
         AND product_code = $4 AND amount_minor = $5 AND currency = $6 FOR UPDATE`,
        [event.userId, event.provider, event.providerOrderId, event.productCode, event.amountMinor, event.currency],
      );
      if (!order.rows[0]) throw new DomainError('ORDER_MISMATCH', 'The confirmed payment does not match an order.');
      await client.query(`UPDATE orders SET status = 'paid', paid_at = $2, updated_at = now() WHERE id = $1`, [order.rows[0].id, event.occurredAt]);
      const payment = await client.query<{ id: string }>(
        `INSERT INTO payments(user_id, order_id, provider, provider_payment_id, status, amount_minor, currency, paid_at)
         VALUES ($1, $2, $3, $4, 'succeeded', $5, $6, $7) RETURNING id`,
        [event.userId, order.rows[0].id, event.provider, event.providerPaymentId, event.amountMinor, event.currency, event.occurredAt],
      );
      const paymentId = payment.rows[0]?.id;
      if (!paymentId) throw new Error('Payment creation returned no row.');
      let validFrom = event.occurredAt;
      let validUntil: Date | null = null;
      if (event.productCode === 'VIP_MONTHLY_ONCE') {
        const previous = await client.query<{ latest: Date | null }>(
          `SELECT max(valid_until) AS latest FROM membership_entitlements
           WHERE user_id = $1 AND product_code = 'VIP_MONTHLY_ONCE' AND revoked_at IS NULL AND valid_until > $2`,
          [event.userId, event.occurredAt],
        );
        const latest = previous.rows[0]?.latest;
        if (latest && latest > validFrom) validFrom = latest;
        validUntil = addCalendarMonthsUtc(validFrom, 1);
      }
      await client.query(
        `INSERT INTO membership_entitlements(user_id, product_code, tier, payment_id, valid_from, valid_until)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [event.userId, event.productCode, product.entitlement_tier, paymentId, validFrom, validUntil],
      );
      return;
    }

    if (!event.providerSubscriptionId || !event.periodStart || !event.periodEnd || event.periodEnd <= event.periodStart) {
      throw new DomainError('INVALID_BILLING_PERIOD', 'A successful subscription payment requires a valid provider billing period.');
    }
    const subscription = await client.query<{ id: string }>(
      `SELECT id FROM billing_subscriptions WHERE user_id = $1 AND provider = $2 AND provider_subscription_id = $3 FOR UPDATE`,
      [event.userId, event.provider, event.providerSubscriptionId],
    );
    const subscriptionId = subscription.rows[0]?.id;
    if (!subscriptionId) throw new DomainError('SUBSCRIPTION_NOT_FOUND', 'The payment references an unknown subscription.');
    const payment = await client.query<{ id: string }>(
      `INSERT INTO payments(user_id, subscription_id, provider, provider_payment_id, status, amount_minor, currency, paid_at, period_start, period_end)
       VALUES ($1, $2, $3, $4, 'succeeded', $5, $6, $7, $8, $9) RETURNING id`,
      [event.userId, subscriptionId, event.provider, event.providerPaymentId, event.amountMinor, event.currency,
        event.occurredAt, event.periodStart, event.periodEnd],
    );
    await client.query(
      `UPDATE billing_subscriptions SET status = (CASE WHEN cancel_at_period_end THEN 'cancel_scheduled' ELSE 'active' END)::subscription_status,
       current_period_start = $2, current_period_end = $3, updated_at = now() WHERE id = $1`,
      [subscriptionId, event.periodStart, event.periodEnd],
    );
    await client.query(
      `INSERT INTO membership_entitlements(user_id, product_code, tier, payment_id, valid_from, valid_until)
       VALUES ($1, 'VIP_MONTHLY_AUTO', 'VIP_MONTHLY', $2, $3, $4)`,
      [event.userId, payment.rows[0]?.id, event.periodStart, event.periodEnd],
    );
  }

  private async applyFailedPayment(
    client: DatabaseClient,
    event: Extract<VerifiedPaymentEvent, { type: 'PAYMENT_FAILED' }>,
  ): Promise<void> {
    const subscription = await client.query<{ id: string }>(
      `SELECT id FROM billing_subscriptions WHERE user_id = $1 AND provider = $2 AND provider_subscription_id = $3 FOR UPDATE`,
      [event.userId, event.provider, event.providerSubscriptionId],
    );
    const id = subscription.rows[0]?.id;
    if (!id) throw new DomainError('SUBSCRIPTION_NOT_FOUND', 'The failed payment references an unknown subscription.');
    await client.query(
      `INSERT INTO payments(user_id, subscription_id, provider, provider_payment_id, status, amount_minor, currency)
       VALUES ($1, $2, $3, $4, 'failed', $5, $6)`,
      [event.userId, id, event.provider, event.providerPaymentId, event.amountMinor, event.currency],
    );
    await client.query(`UPDATE billing_subscriptions SET status = 'past_due', updated_at = now() WHERE id = $1`, [id]);
  }

  private async applyCancellation(
    client: DatabaseClient,
    event: Extract<VerifiedPaymentEvent, { type: 'SUBSCRIPTION_CANCELLED' }>,
  ): Promise<void> {
    const result = await client.query(
      `UPDATE billing_subscriptions SET status = 'cancel_scheduled', cancel_at_period_end = true,
       cancelled_at = $4, updated_at = now()
       WHERE user_id = $1 AND provider = $2 AND provider_subscription_id = $3`,
      [event.userId, event.provider, event.providerSubscriptionId, event.occurredAt],
    );
    if (result.rowCount !== 1) throw new DomainError('SUBSCRIPTION_NOT_FOUND', 'The cancellation references an unknown subscription.');
  }

  private async applyReversal(
    client: DatabaseClient,
    event: Extract<VerifiedPaymentEvent, { type: 'PAYMENT_REFUNDED' | 'PAYMENT_DISPUTED' }>,
  ): Promise<void> {
    const payment = await client.query<{ id: string; order_id: string | null }>(
      `SELECT id, order_id FROM payments WHERE user_id = $1 AND provider = $2 AND provider_payment_id = $3 FOR UPDATE`,
      [event.userId, event.provider, event.providerPaymentId],
    );
    const row = payment.rows[0];
    if (!row) throw new DomainError('PAYMENT_NOT_FOUND', 'The reversal references an unknown payment.');
    const state = event.type === 'PAYMENT_REFUNDED' ? 'refunded' : 'disputed';
    await client.query(
      `UPDATE payments SET status = $2::payment_status, refunded_at = CASE WHEN $2::text = 'refunded' THEN $3 ELSE refunded_at END,
       disputed_at = CASE WHEN $2::text = 'disputed' THEN $3 ELSE disputed_at END, updated_at = now() WHERE id = $1`,
      [row.id, state, event.occurredAt],
    );
    await client.query(
      `UPDATE membership_entitlements SET revoked_at = $2, revocation_reason = $3, updated_at = now()
       WHERE payment_id = $1 AND revoked_at IS NULL`, [row.id, event.occurredAt, state],
    );
    if (row.order_id) await client.query('UPDATE orders SET status = $2::order_status, updated_at = now() WHERE id = $1', [row.order_id, state]);
  }

  public async activeTierWith(client: DatabaseClient, userId: string, at: Date): Promise<EntitlementTier> {
    const result = await client.query<{ tier: 'VIP_MONTHLY' | 'VIP_LIFETIME' }>(
      `SELECT tier FROM membership_entitlements
       WHERE user_id = $1 AND valid_from <= $2 AND (valid_until IS NULL OR valid_until > $2)
       AND (revoked_at IS NULL OR revoked_at > $2)
       ORDER BY CASE tier WHEN 'VIP_LIFETIME' THEN 2 ELSE 1 END DESC LIMIT 1`, [userId, at],
    );
    return result.rows[0]?.tier ?? 'FREE';
  }

  public async activeTier(userId: string, at = new Date()): Promise<EntitlementTier> {
    const client = await this.pool.connect();
    try { return await this.activeTierWith(client, userId, at); }
    finally { client.release(); }
  }

  private async enqueueDiscordSync(client: DatabaseClient, event: VerifiedPaymentEvent, tier: EntitlementTier): Promise<void> {
    await client.query(
      `INSERT INTO discord_sync_jobs(user_id, desired_tier, reason, deduplication_key, dry_run)
       VALUES ($1, $2, $3, $4, true) ON CONFLICT (deduplication_key) DO NOTHING`,
      [event.userId, tier, `payment:${event.type}`, `${event.provider}:${event.eventId}:${tier}`],
    );
  }

  private async audit(client: DatabaseClient, event: VerifiedPaymentEvent, tier: EntitlementTier): Promise<void> {
    await client.query(
      `INSERT INTO administrative_audit_logs(actor_type, action, target_type, target_id, correlation_id, metadata)
       VALUES ('payment_provider', $1, 'user', $2, $3, $4::jsonb)`,
      [event.type, event.userId, event.correlationId, JSON.stringify({ provider: event.provider, eventId: event.eventId, resultingTier: tier })],
    );
  }

  public async reconcileExpired(now = new Date(), actorUserId?: string): Promise<number> {
    return inTransaction(this.pool, async (client) => {
      const rows = await client.query<{ user_id: string; boundary: Date }>(
        `SELECT user_id, max(valid_until) AS boundary FROM membership_entitlements expired
         WHERE valid_until <= $1 AND revoked_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM membership_entitlements active
           WHERE active.user_id = expired.user_id AND active.valid_from <= $1
           AND (active.valid_until IS NULL OR active.valid_until > $1)
           AND (active.revoked_at IS NULL OR active.revoked_at > $1)
         ) GROUP BY user_id`, [now],
      );
      let created = 0;
      for (const row of rows.rows) {
        const result = await client.query(
          `INSERT INTO discord_sync_jobs(user_id, desired_tier, reason, deduplication_key, dry_run)
           VALUES ($1, 'FREE', 'entitlement_expired', $2, true)
           ON CONFLICT (deduplication_key) DO NOTHING`,
          [row.user_id, `expiry:${row.user_id}:${row.boundary.toISOString()}`],
        );
        created += result.rowCount ?? 0;
      }
      await client.query(
        `INSERT INTO administrative_audit_logs(actor_user_id, actor_type, action, target_type, correlation_id, metadata)
         VALUES ($1, $2, 'EXPIRED_ENTITLEMENTS_RECONCILED', 'discord_sync_jobs', $3, $4::jsonb)`,
        [actorUserId ?? null, actorUserId ? 'admin' : 'system', randomUUID(), JSON.stringify({ asOf: now.toISOString(), jobsCreated: created })],
      );
      return created;
    });
  }
}
