import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type Stripe from "stripe";
import {
  inTransaction,
  type DatabaseClient,
  type DatabasePool,
} from "../db/pool.js";
import { discordAudit } from "../discord/audit.js";
import { PRODUCT_SPEC } from "../domain/products.js";
import type { BillingConfig } from "./config.js";
import { BillingSecrets } from "./secrets.js";
import {
  BillingFailure,
  hostedStripeUrl,
  requireBilling,
  type BillingProduct,
  type BillingSubscription,
  type CheckoutSession,
  type MoneyProof,
  type StripePort,
} from "./stripe.js";

export const STRIPE_EVENT_TYPES = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "invoice.paid",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "charge.refunded",
  "refund.created",
  "refund.updated",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
] as const;
export type Principal = {
  id: string;
  guild_id: string;
  discord_user_id: string;
  customer_id: string | null;
  customer_started_at: Date | null;
  mode: "test" | "live";
  stripe_account_id: string;
};
export type Order = {
  id: string;
  principal_id: string;
  channel_id: string;
  product_code: BillingProduct;
  price_id: string;
  legal_revision: string;
  state: "prepared" | "creating" | "open" | "paid" | "expired";
  upgrade_consent: boolean;
  session_id: string | null;
  subscription_id: string | null;
  payment_intent_id: string | null;
  checkout_url_ciphertext: string | null;
  expires_at: Date;
  started_at: Date | null;
};
type EventRow = {
  event_id: string;
  object_id: string;
  event_type: string;
  attempt_count: number;
};
export type PrivateResponse = {
  content: string;
  components?: Array<{
    type: number;
    components: Array<{
      type: number;
      style: number;
      label: string;
      custom_id?: string;
      url?: string;
    }>;
  }>;
};
export const actionButton = (label: string, customId: string) => ({
  type: 2,
  style: 1,
  label,
  custom_id: customId,
});

/** Separate Discord financial ledger. No mock payment or website account changes. */
export class BillingService {
  public readonly secrets: BillingSecrets;
  public constructor(
    public readonly pool: DatabasePool,
    public readonly config: BillingConfig,
    public readonly stripe: StripePort,
    encryptionSecret: string,
  ) {
    this.secrets = new BillingSecrets(encryptionSecret);
  }

  public async locked<T>(
    key: string,
    work: (db: DatabaseClient) => Promise<T>,
  ): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
        `stripe:${key}`,
      ]);
      return await work(db);
    } finally {
      await db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
        `stripe:${key}`,
      ]);
      db.release();
    }
  }
  public async principal(
    guildId: string,
    discordId: string,
  ): Promise<Principal> {
    requireBilling(this.config.STRIPE_ACCOUNT_ID, "STRIPE_DISABLED");
    return (
      await this.pool.query<Principal>(
        `INSERT INTO discord_billing_principals
      (id,guild_id,discord_user_id,stripe_account_id,mode) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(guild_id,discord_user_id,stripe_account_id,mode) DO UPDATE SET guild_id=EXCLUDED.guild_id RETURNING *`,
        [
          randomUUID(),
          guildId,
          discordId,
          this.config.STRIPE_ACCOUNT_ID,
          this.config.STRIPE_MODE,
        ],
      )
    ).rows[0]!;
  }
  public async tier(
    db: DatabaseClient | DatabasePool,
    principalId: string,
  ): Promise<"FREE" | "VIP_MONTHLY" | "VIP_LIFETIME"> {
    const result = await db.query<{ tier: "VIP_MONTHLY" | "VIP_LIFETIME" }>(
      `SELECT tier FROM stripe_verified_payments
      WHERE principal_id=$1 AND valid_from<=now() AND (valid_until IS NULL OR valid_until>now())
      AND refunded_minor=0 AND NOT disputed ORDER BY CASE tier WHEN 'VIP_LIFETIME' THEN 2 ELSE 1 END DESC LIMIT 1`,
      [principalId],
    );
    return result.rows[0]?.tier ?? "FREE";
  }
  private price(product: BillingProduct): string {
    const price =
      product === "VIP_MONTHLY_AUTO"
        ? this.config.STRIPE_VIP_MONTHLY_PRICE_ID
        : this.config.STRIPE_VIP_LIFETIME_PRICE_ID;
    requireBilling(price, "STRIPE_PRICE_NOT_CONFIGURED");
    return price;
  }
  private async principalById(id: string): Promise<Principal> {
    const p = (
      await this.pool.query<Principal>(
        `SELECT * FROM discord_billing_principals WHERE id=$1
      AND stripe_account_id=$2 AND mode=$3`,
        [id, this.config.STRIPE_ACCOUNT_ID, this.config.STRIPE_MODE],
      )
    ).rows[0];
    requireBilling(p, "STRIPE_PRINCIPAL_NOT_FOUND");
    return p;
  }
  private async customer(p: Principal): Promise<string> {
    if (p.customer_id) return p.customer_id;
    requireBilling(
      !p.customer_started_at ||
        Date.now() - p.customer_started_at.getTime() < 23 * 3600_000,
      "STRIPE_CUSTOMER_RECOVERY_REVIEW_REQUIRED",
    );
    await this.pool.query(
      "UPDATE discord_billing_principals SET customer_started_at=COALESCE(customer_started_at,now()) WHERE id=$1",
      [p.id],
    );
    const id = await this.stripe.createCustomer(p.id);
    await this.pool.query(
      "UPDATE discord_billing_principals SET customer_id=$2 WHERE id=$1",
      [p.id, id],
    );
    return id;
  }
  public async disclose(
    p: Principal,
    channelId: string,
    product: BillingProduct,
  ): Promise<PrivateResponse> {
    requireBilling(
      this.config.STRIPE_CHECKOUT_ENABLED,
      "STRIPE_CHECKOUT_DISABLED",
    );
    const order = await this.locked(p.id, async () => {
      p = await this.principalById(p.id);
      requireBilling(
        (await this.tier(this.pool, p.id)) !== "VIP_LIFETIME",
        "STRIPE_LIFETIME_ALREADY_ACTIVE",
      );
      await this.refreshSubscriptions(p);
      const active = await this.pool.query(
        "SELECT 1 FROM stripe_billing_subscriptions WHERE principal_id=$1 AND status NOT IN ('canceled','incomplete_expired')",
        [p.id],
      );
      requireBilling(
        product !== "VIP_MONTHLY_AUTO" || !active.rowCount,
        "STRIPE_SUBSCRIPTION_ALREADY_ACTIVE",
      );
      let existing = (
        await this.pool.query<Order>(
          "SELECT * FROM stripe_checkout_orders WHERE principal_id=$1 AND state IN ('prepared','creating','open')",
          [p.id],
        )
      ).rows[0];
      if (
        existing?.state === "prepared" &&
        existing.expires_at.getTime() <= Date.now()
      ) {
        await this.pool.query(
          "UPDATE stripe_checkout_orders SET state='expired' WHERE id=$1",
          [existing.id],
        );
        existing = undefined;
      }
      if (existing?.session_id && existing.state === "open") {
        const session = await this.stripe.session(existing.session_id);
        this.verifySession(existing, p, session);
        if (session.status === "expired") {
          await this.pool.query(
            "UPDATE stripe_checkout_orders SET state='expired',checkout_url_ciphertext=NULL WHERE id=$1",
            [existing.id],
          );
          existing = undefined;
        } else if (session.status === "complete")
          throw new BillingFailure("STRIPE_PAYMENT_PROCESSING");
      }
      if (existing) {
        requireBilling(
          existing.product_code === product &&
            existing.channel_id === channelId,
          "STRIPE_PENDING_CHECKOUT_EXISTS",
        );
        return existing;
      }
      const id = randomUUID();
      const created = (
        await this.pool.query<Order>(
          `INSERT INTO stripe_checkout_orders
        (id,principal_id,channel_id,product_code,price_id,legal_revision,upgrade_consent) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [
            id,
            p.id,
            channelId,
            product,
            this.price(product),
            this.config.BILLING_LEGAL_REVISION!,
            product === "VIP_LIFETIME" && Boolean(active.rowCount),
          ],
        )
      ).rows[0]!;
      await discordAudit(this.pool, "STRIPE_CHECKOUT_DISCLOSED", null, {
        principalId: p.id,
        orderId: id,
        product,
        legalRevision: created.legal_revision,
      });
      return created;
    });
    return {
      content: `${
        product === "VIP_MONTHLY_AUTO"
          ? "VIP Monthly — EUR 40/month. Automatically renews until cancelled. Cancel future renewals in Manage Billing; paid access continues through the paid period."
          : "VIP Lifetime — EUR 100, one-time payment. Access for the lifetime of the covered service under the published license; infinite updates are not guaranteed."
      }
VIP access covers the TimonConfigs digital membership described in the terms.
${order.upgrade_consent ? "Upgrade: confirming schedules cancellation of your existing Monthly renewal before opening Lifetime Checkout. Already-paid Monthly access remains valid. Cancellation is not automatically reversed if Checkout is abandoned.\n" : ""}Terms: ${this.config.BILLING_TERMS_URL}
Privacy: ${this.config.BILLING_PRIVACY_URL}
Refunds and consumer withdrawal: ${this.config.BILLING_REFUND_POLICY_URL}
Lifetime license: ${this.config.BILLING_LIFETIME_TERMS_URL}
${this.config.STRIPE_MODE === "test" ? "Stripe TEST mode: use sandbox payment details only. " : ""}Confirm to accept these terms and open private Stripe Checkout. No VIP is granted by a redirect.`,
      components: [
        {
          type: 1,
          components: [
            actionButton(
              order.upgrade_consent
                ? "Confirm upgrade and stop renewal"
                : "Accept terms and open Checkout",
              `tc:bill:confirm:${order.id}`,
            ),
            actionButton(
              "Manage Billing / Status",
              `tc:bill:portal:${order.id}`,
            ),
          ],
        },
      ],
    };
  }
  public async ownedOrder(
    p: Principal,
    orderId: string,
    channelId: string,
  ): Promise<Order> {
    z.string().uuid().parse(orderId);
    const order = (
      await this.pool.query<Order>(
        "SELECT * FROM stripe_checkout_orders WHERE id=$1 AND principal_id=$2 AND channel_id=$3",
        [orderId, p.id, channelId],
      )
    ).rows[0];
    requireBilling(order, "STRIPE_ORDER_NOT_OWNED");
    return order;
  }
  public verifySession(
    order: Order,
    p: Principal,
    session: CheckoutSession,
  ): void {
    requireBilling(
      session.livemode === (p.mode === "live") &&
        session.customer === p.customer_id &&
        session.client_reference_id === order.id &&
        (!order.session_id || session.id === order.session_id) &&
        session.mode ===
          (order.product_code === "VIP_MONTHLY_AUTO"
            ? "subscription"
            : "payment") &&
        !session.line_items.has_more &&
        session.line_items.data.length === 1 &&
        session.line_items.data[0]?.price === order.price_id &&
        session.line_items.data[0].quantity === 1 &&
        session.currency === "eur" &&
        session.amount_total === PRODUCT_SPEC[order.product_code].amountMinor,
      "STRIPE_SESSION_MISMATCH",
    );
  }
  public async confirm(
    p: Principal,
    orderId: string,
    channelId: string,
  ): Promise<PrivateResponse> {
    requireBilling(
      this.config.STRIPE_CHECKOUT_ENABLED,
      "STRIPE_CHECKOUT_DISABLED",
    );
    return this.locked(p.id, async () => {
      let order = await this.ownedOrder(p, orderId, channelId);
      p = await this.principalById(p.id);
      requireBilling(
        order.legal_revision === this.config.BILLING_LEGAL_REVISION,
        "STRIPE_TERMS_CHANGED",
      );
      requireBilling(
        ["prepared", "creating", "open"].includes(order.state),
        "STRIPE_CHECKOUT_NOT_OPEN",
      );
      requireBilling(
        (await this.tier(this.pool, p.id)) !== "VIP_LIFETIME",
        "STRIPE_LIFETIME_ALREADY_ACTIVE",
      );
      if (order.state === "prepared") {
        requireBilling(
          order.expires_at.getTime() > Date.now(),
          "STRIPE_CONFIRMATION_EXPIRED",
        );
        await this.refreshSubscriptions(p);
        const subscriptions = (
          await this.pool.query<{ subscription_id: string }>(
            "SELECT subscription_id FROM stripe_billing_subscriptions WHERE principal_id=$1 AND status NOT IN ('canceled','incomplete_expired')",
            [p.id],
          )
        ).rows;
        requireBilling(
          !subscriptions.length ||
            (order.product_code === "VIP_LIFETIME" && order.upgrade_consent),
          "STRIPE_UPGRADE_CONFIRMATION_REQUIRED",
        );
        for (const sub of subscriptions) {
          const cancelled = await this.stripe.cancelRenewal(
            sub.subscription_id,
            `tc:upgrade:${order.id}:${sub.subscription_id}`,
          );
          this.verifySubscription(p, order.price_id, cancelled, false);
          requireBilling(
            cancelled.cancel_at_period_end || cancelled.status === "canceled",
            "STRIPE_RENEWAL_CANCELLATION_UNCONFIRMED",
          );
          await this.saveSubscription(this.pool, p, cancelled);
          await discordAudit(
            this.pool,
            "STRIPE_UPGRADE_RENEWAL_CANCELLED",
            null,
            {
              principalId: p.id,
              orderId: order.id,
              subscriptionId: sub.subscription_id,
            },
          );
        }
        order = (
          await this.pool.query<Order>(
            `UPDATE stripe_checkout_orders SET state='creating',started_at=now(),consent_at=now(),
          expires_at=now()+interval '35 minutes' WHERE id=$1 RETURNING *`,
            [order.id],
          )
        ).rows[0]!;
      }
      if (order.state === "creating") {
        requireBilling(
          order.started_at &&
            Date.now() - order.started_at.getTime() < 23 * 3600_000,
          "STRIPE_CHECKOUT_RECOVERY_REVIEW_REQUIRED",
        );
        // Reuse exact expires_at and idempotency key after a process crash.
        const customerId = await this.customer(p);
        p = { ...p, customer_id: customerId };
        await this.stripe.verifyPrice(order.product_code, order.price_id);
        const session = await this.stripe.createCheckout({
          orderId: order.id,
          customerId,
          product: order.product_code,
          priceId: order.price_id,
          expires: Math.floor(order.expires_at.getTime() / 1000),
        });
        this.verifySession(order, p, session);
        requireBilling(
          session.status !== "open" || session.url,
          "STRIPE_CHECKOUT_NOT_OPEN",
        );
        const url =
          session.status === "open"
            ? this.secrets.seal(hostedStripeUrl(session.url!))
            : null;
        order = (
          await this.pool.query<Order>(
            `UPDATE stripe_checkout_orders SET state='open',session_id=$2,
          checkout_url_ciphertext=$3,expires_at=to_timestamp($4) WHERE id=$1 RETURNING *`,
            [order.id, session.id, url, session.expires_at],
          )
        ).rows[0]!;
        await discordAudit(this.pool, "STRIPE_CHECKOUT_CREATED", null, {
          principalId: p.id,
          orderId: order.id,
          sessionId: session.id,
        });
        if (session.status !== "open")
          return {
            content:
              "Checkout has already completed or expired. Use Manage Billing / Status after server payment verification.",
            components: [
              {
                type: 1,
                components: [
                  actionButton(
                    "Manage Billing / Status",
                    `tc:bill:portal:${order.id}`,
                  ),
                ],
              },
            ],
          };
      }
      requireBilling(
        order.session_id &&
          order.checkout_url_ciphertext &&
          order.expires_at.getTime() > Date.now(),
        "STRIPE_CHECKOUT_EXPIRED",
      );
      const session = await this.stripe.session(order.session_id);
      this.verifySession(order, p, session);
      requireBilling(session.status === "open", "STRIPE_PAYMENT_PROCESSING");
      return {
        content: `${this.config.STRIPE_MODE === "test" ? "TEST Checkout. " : ""}Your private Checkout link expires shortly. Payment verification and VIP role confirmation are separate.`,
        components: [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 5,
                label: "Open Stripe Checkout",
                url: hostedStripeUrl(
                  this.secrets.open(order.checkout_url_ciphertext),
                ),
              },
              actionButton(
                "Manage Billing / Status",
                `tc:bill:portal:${order.id}`,
              ),
            ],
          },
        ],
      };
    });
  }
  private verifySubscription(
    p: Principal,
    priceId: string,
    sub: BillingSubscription,
    comparePrice = true,
  ): void {
    requireBilling(
      sub.customer === p.customer_id &&
        sub.livemode === (p.mode === "live") &&
        !sub.items.has_more &&
        sub.items.data.length === 1 &&
        sub.items.data[0]?.quantity === 1 &&
        (!comparePrice || sub.items.data[0].price === priceId),
      "STRIPE_SUBSCRIPTION_MISMATCH",
    );
  }
  private async saveSubscription(
    db: DatabasePool | DatabaseClient,
    p: Principal,
    sub: BillingSubscription,
  ): Promise<void> {
    const order = (
      await db.query<Order>(
        "SELECT * FROM stripe_checkout_orders WHERE principal_id=$1 AND subscription_id=$2",
        [p.id, sub.id],
      )
    ).rows[0];
    requireBilling(
      order && order.product_code === "VIP_MONTHLY_AUTO",
      "STRIPE_SUBSCRIPTION_MAPPING_PENDING",
      true,
    );
    this.verifySubscription(p, order.price_id, sub);
    await db.query(
      `INSERT INTO stripe_billing_subscriptions(subscription_id,principal_id,order_id,price_id,status,cancel_at_period_end)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(subscription_id) DO UPDATE SET status=EXCLUDED.status,
      cancel_at_period_end=EXCLUDED.cancel_at_period_end,updated_at=now()`,
      [
        sub.id,
        p.id,
        order.id,
        order.price_id,
        sub.status,
        sub.cancel_at_period_end,
      ],
    );
  }
  private async refreshSubscriptions(p: Principal): Promise<void> {
    const rows = (
      await this.pool.query<{ subscription_id: string }>(
        "SELECT subscription_id FROM stripe_billing_subscriptions WHERE principal_id=$1 AND status NOT IN ('canceled','incomplete_expired')",
        [p.id],
      )
    ).rows;
    for (const row of rows)
      await this.saveSubscription(
        this.pool,
        p,
        await this.stripe.subscription(row.subscription_id),
      );
  }
  public async portal(
    p: Principal,
    orderId: string,
    channelId: string,
    interactionId: string,
  ): Promise<PrivateResponse> {
    await this.ownedOrder(p, orderId, channelId);
    const tier = await this.tier(this.pool, p.id);
    const sync = (
      await this.pool.query<{ outcome: string }>(
        "SELECT outcome FROM stripe_vip_sync_state WHERE principal_id=$1",
        [p.id],
      )
    ).rows[0];
    const status = `Verified paid membership: ${tier}. VIP role synchronization: ${sync?.outcome ?? "pending"}.`;
    if (!this.config.STRIPE_PORTAL_ENABLED || !p.customer_id)
      return { content: `${status} Manage Billing is currently unavailable.` };
    const url = await this.stripe.portal(
      p.customer_id,
      `tc:portal:${interactionId}`,
    );
    await discordAudit(this.pool, "STRIPE_PORTAL_CREATED", null, {
      principalId: p.id,
      interactionId,
    });
    return {
      content: `${status} Cancel future Monthly renewals in the Stripe Customer Portal. Already-paid access is retained.`,
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 5,
              label: "Open private Billing Portal",
              url: hostedStripeUrl(url, true),
            },
          ],
        },
      ],
    };
  }
  public async receive(raw: Buffer, signature: string): Promise<void> {
    requireBilling(
      this.config.STRIPE_WEBHOOKS_ENABLED,
      "STRIPE_WEBHOOKS_DISABLED",
    );
    let event: Stripe.Event;
    try {
      event = this.stripe.verifyWebhook(raw, signature);
    } catch {
      throw new BillingFailure("STRIPE_SIGNATURE_INVALID");
    }
    requireBilling(
      event.livemode === (this.config.STRIPE_MODE === "live") &&
        (!event.account || event.account === this.config.STRIPE_ACCOUNT_ID),
      "STRIPE_EVENT_SCOPE_MISMATCH",
    );
    requireBilling(
      event.api_version === "2026-09-30.endive",
      "STRIPE_EVENT_API_VERSION_MISMATCH",
    );
    if (!(STRIPE_EVENT_TYPES as readonly string[]).includes(event.type)) return;
    const objectId = z
      .object({ id: z.string().min(1).max(255) })
      .parse(event.data.object).id;
    const hash = createHash("sha256").update(raw).digest("hex");
    await inTransaction(this.pool, async (db) => {
      const saved = await db.query(
        `INSERT INTO stripe_webhook_events(event_id,account_id,mode,event_type,object_id,payload_hash)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [
          event.id,
          this.config.STRIPE_ACCOUNT_ID!,
          this.config.STRIPE_MODE,
          event.type,
          objectId,
          hash,
        ],
      );
      const existing = (
        await db.query<{ payload_hash: string }>(
          "SELECT payload_hash FROM stripe_webhook_events WHERE event_id=$1",
          [event.id],
        )
      ).rows[0]!;
      requireBilling(existing.payload_hash === hash, "STRIPE_EVENT_COLLISION");
      if (saved.rowCount)
        await discordAudit(db, "STRIPE_WEBHOOK_RECEIVED", null, {
          eventId: event.id,
          type: event.type,
          mode: this.config.STRIPE_MODE,
        });
    });
  }
  private async orderForSession(
    db: DatabaseClient,
    sessionId: string,
  ): Promise<{ p: Principal; order: Order; session: CheckoutSession } | null> {
    const order = (
      await db.query<Order>(
        `SELECT o.* FROM stripe_checkout_orders o JOIN discord_billing_principals p ON p.id=o.principal_id
      WHERE o.session_id=$1 AND p.stripe_account_id=$2 AND p.mode=$3`,
        [sessionId, this.config.STRIPE_ACCOUNT_ID!, this.config.STRIPE_MODE],
      )
    ).rows[0];
    if (!order) {
      // A crash can leave a canonical session before its mapping commit. Retry owned customers; ignore unrelated purchases.
      const session = await this.stripe.session(sessionId);
      const known = await db.query(
        "SELECT 1 FROM discord_billing_principals WHERE customer_id=$1 AND stripe_account_id=$2 AND mode=$3",
        [
          session.customer,
          this.config.STRIPE_ACCOUNT_ID!,
          this.config.STRIPE_MODE,
        ],
      );
      requireBilling(!known.rowCount, "STRIPE_SESSION_MAPPING_PENDING", true);
      return null;
    }
    await db.query(
      "SELECT 1 FROM discord_billing_principals WHERE id=$1 FOR NO KEY UPDATE",
      [order.principal_id],
    );
    const p = await this.principalById(order.principal_id);
    const session = await this.stripe.session(sessionId);
    this.verifySession(order, p, session);
    return { p, order, session };
  }
  private async mapSession(
    db: DatabaseClient,
    order: Order,
    p: Principal,
    session: CheckoutSession,
  ): Promise<void> {
    if (session.status === "expired") {
      await db.query(
        "UPDATE stripe_checkout_orders SET state='expired',checkout_url_ciphertext=NULL WHERE id=$1 AND state!='paid'",
        [order.id],
      );
      return;
    }
    if (session.status !== "complete") return;
    if (order.product_code === "VIP_MONTHLY_AUTO") {
      requireBilling(session.subscription, "STRIPE_SUBSCRIPTION_MISSING", true);
      await db.query(
        "UPDATE stripe_checkout_orders SET subscription_id=$2 WHERE id=$1",
        [order.id, session.subscription],
      );
      await this.saveSubscription(
        db,
        p,
        await this.stripe.subscription(session.subscription),
      );
    } else if (session.payment_status === "paid") {
      requireBilling(
        session.payment_intent,
        "STRIPE_PAYMENT_INTENT_MISSING",
        true,
      );
      const proof = await this.stripe.money(
        session.payment_intent,
        p.customer_id!,
        10000,
      );
      await this.saveMoney(
        db,
        p,
        order,
        proof,
        null,
        new Date(proof.charge.created * 1000),
        null,
      );
    }
  }
  private async saveMoney(
    db: DatabaseClient,
    p: Principal,
    order: Order,
    proof: MoneyProof,
    invoiceId: string | null,
    from: Date,
    until: Date | null,
  ): Promise<void> {
    const amount = PRODUCT_SPEC[order.product_code].amountMinor;
    const existing = (
      await db.query<{
        principal_id: string;
        order_id: string;
        invoice_id: string | null;
        charge_id: string;
      }>(
        "SELECT principal_id,order_id,invoice_id,charge_id FROM stripe_verified_payments WHERE payment_intent_id=$1",
        [proof.intentId],
      )
    ).rows[0];
    if (existing)
      requireBilling(
        existing.principal_id === p.id &&
          existing.order_id === order.id &&
          existing.invoice_id === invoiceId &&
          existing.charge_id === proof.charge.id,
        "STRIPE_PAYMENT_REUSE_REJECTED",
      );
    await db.query(
      `INSERT INTO stripe_verified_payments(id,principal_id,order_id,invoice_id,payment_intent_id,charge_id,amount_minor,currency,tier,
      valid_from,valid_until,refunded_minor,disputed) VALUES($1,$2,$3,$4,$5,$6,$7,'eur',$8,$9,$10,$11,$12)
      ON CONFLICT(payment_intent_id) DO UPDATE SET refunded_minor=EXCLUDED.refunded_minor,disputed=EXCLUDED.disputed,updated_at=now()`,
      [
        randomUUID(),
        p.id,
        order.id,
        invoiceId,
        proof.intentId,
        proof.charge.id,
        amount,
        PRODUCT_SPEC[order.product_code].tier,
        from,
        until,
        proof.charge.amount_refunded,
        proof.disputed,
      ],
    );
    await db.query(
      "UPDATE stripe_checkout_orders SET state='paid',payment_intent_id=COALESCE(payment_intent_id,$2),checkout_url_ciphertext=NULL WHERE id=$1",
      [order.id, proof.intentId],
    );
    await db.query(
      "INSERT INTO stripe_vip_sync_state(principal_id) VALUES($1) ON CONFLICT(principal_id) DO UPDATE SET checked_at='-infinity',outcome='pending'",
      [p.id],
    );
    await discordAudit(db, "STRIPE_PAYMENT_VERIFIED", null, {
      principalId: p.id,
      orderId: order.id,
      invoiceId,
      paymentIntentId: proof.intentId,
      refundedMinor: proof.charge.amount_refunded,
      disputed: proof.disputed,
    });
  }
  private async mapSubscription(
    db: DatabaseClient,
    subId: string,
    customerId: string,
  ): Promise<{ p: Principal; order: Order } | null> {
    const p = (
      await db.query<Principal>(
        `SELECT * FROM discord_billing_principals WHERE customer_id=$1
      AND stripe_account_id=$2 AND mode=$3 FOR NO KEY UPDATE`,
        [customerId, this.config.STRIPE_ACCOUNT_ID!, this.config.STRIPE_MODE],
      )
    ).rows[0];
    if (!p) return null;
    let order = (
      await db.query<Order>(
        "SELECT * FROM stripe_checkout_orders WHERE principal_id=$1 AND subscription_id=$2",
        [p.id, subId],
      )
    ).rows[0];
    if (!order) {
      const candidates = (
        await db.query<Order>(
          "SELECT * FROM stripe_checkout_orders WHERE principal_id=$1 AND product_code='VIP_MONTHLY_AUTO' AND session_id IS NOT NULL ORDER BY created_at DESC LIMIT 10",
          [p.id],
        )
      ).rows;
      for (const candidate of candidates) {
        const session = await this.stripe.session(candidate.session_id!);
        this.verifySession(candidate, p, session);
        if (session.status === "complete" && session.subscription === subId) {
          await this.mapSession(db, candidate, p, session);
          order = { ...candidate, subscription_id: subId };
          break;
        }
      }
    }
    requireBilling(order, "STRIPE_SUBSCRIPTION_MAPPING_PENDING", true);
    return { p, order };
  }
  private async applyEvent(db: DatabaseClient, event: EventRow): Promise<void> {
    await this.stripe.verifyAccount();
    if (event.event_type.startsWith("checkout.session.")) {
      const mapping = await this.orderForSession(db, event.object_id);
      if (mapping)
        await this.mapSession(db, mapping.order, mapping.p, mapping.session);
    } else if (event.event_type.startsWith("customer.subscription.")) {
      const sub = await this.stripe.subscription(event.object_id);
      const mapping = await this.mapSubscription(db, sub.id, sub.customer);
      if (mapping) {
        await this.saveSubscription(db, mapping.p, sub);
        await discordAudit(db, "STRIPE_SUBSCRIPTION_RECONCILED", null, {
          principalId: mapping.p.id,
          subscriptionId: sub.id,
          status: sub.status,
          cancelAtPeriodEnd: sub.cancel_at_period_end,
        });
      }
    } else if (event.event_type.startsWith("invoice.")) {
      const invoice = await this.stripe.invoice(event.object_id);
      if (!invoice.parent) return;
      const subId = invoice.parent.subscription_details.subscription;
      const mapping = await this.mapSubscription(db, subId, invoice.customer);
      if (!mapping) return;
      const { p, order } = mapping;
      await this.saveSubscription(db, p, await this.stripe.subscription(subId));
      // Failed or out-of-band paid invoices cannot create a paid period.
      if (invoice.status !== "paid") return;
      const line = invoice.lines.data[0];
      requireBilling(
        invoice.livemode === (p.mode === "live") &&
          invoice.currency === "eur" &&
          invoice.amount_paid === 4000 &&
          ["subscription_create", "subscription_cycle"].includes(
            invoice.billing_reason ?? "",
          ) &&
          !invoice.lines.has_more &&
          invoice.lines.data.length === 1 &&
          line &&
          line.quantity === 1 &&
          line.amount === 4000 &&
          line.currency === "eur" &&
          line.pricing.price_details.price === order.price_id &&
          line.parent.subscription_item_details.subscription === subId &&
          !line.parent.subscription_item_details.proration &&
          line.period.end - line.period.start >= 27 * 86400 &&
          line.period.end - line.period.start <= 32 * 86400,
        "STRIPE_INVOICE_MISMATCH",
      );
      await this.stripe.verifyPrice(order.product_code, order.price_id);
      const intent = await this.stripe.invoiceIntent(invoice.id);
      requireBilling(intent, "STRIPE_INVOICE_WITHOUT_REAL_PAYMENT");
      const proof = await this.stripe.money(intent, p.customer_id!, 4000);
      await this.saveMoney(
        db,
        p,
        order,
        proof,
        invoice.id,
        new Date(line.period.start * 1000),
        new Date(line.period.end * 1000),
      );
    } else {
      const chargeId = event.event_type.startsWith("charge.dispute.")
        ? await this.stripe.disputeCharge(event.object_id)
        : event.event_type.startsWith("refund.")
          ? await this.stripe.refundCharge(event.object_id)
          : event.object_id;
      const charge = await this.stripe.charge(chargeId);
      const p = (
        await db.query<Principal>(
          "SELECT * FROM discord_billing_principals WHERE customer_id=$1 AND stripe_account_id=$2 AND mode=$3 FOR NO KEY UPDATE",
          [
            charge.customer,
            this.config.STRIPE_ACCOUNT_ID!,
            this.config.STRIPE_MODE,
          ],
        )
      ).rows[0];
      if (!p) return;
      const payment = (
        await db.query<{ order_id: string; amount_minor: number }>(
          "SELECT order_id,amount_minor FROM stripe_verified_payments WHERE principal_id=$1 AND charge_id=$2",
          [p.id, chargeId],
        )
      ).rows[0];
      requireBilling(payment, "STRIPE_PAYMENT_MAPPING_PENDING", true);
      const proof = await this.stripe.money(
        charge.payment_intent,
        p.customer_id!,
        payment.amount_minor,
      );
      await db.query(
        "UPDATE stripe_verified_payments SET refunded_minor=$2,disputed=$3,updated_at=now() WHERE principal_id=$1 AND charge_id=$4",
        [p.id, proof.charge.amount_refunded, proof.disputed, chargeId],
      );
      await db.query(
        "INSERT INTO stripe_vip_sync_state(principal_id) VALUES($1) ON CONFLICT(principal_id) DO UPDATE SET checked_at='-infinity',outcome='pending'",
        [p.id],
      );
      await discordAudit(db, "STRIPE_PAYMENT_REVERSAL_RECONCILED", null, {
        principalId: p.id,
        chargeId,
        refundedMinor: proof.charge.amount_refunded,
        disputed: proof.disputed,
      });
    }
  }
  public async processOne(): Promise<boolean> {
    if (!this.config.STRIPE_WEBHOOKS_ENABLED) return false;
    const event = (
      await this.pool.query<EventRow>(
        `SELECT * FROM stripe_webhook_events WHERE status='queued' AND available_at<=now()
      AND account_id=$1 AND mode=$2 ORDER BY available_at,event_id LIMIT 1`,
        [this.config.STRIPE_ACCOUNT_ID!, this.config.STRIPE_MODE],
      )
    ).rows[0];
    if (!event) return false;
    return this.locked(`event:${event.event_id}`, async () => {
      const current = (
        await this.pool.query<EventRow>(
          "SELECT * FROM stripe_webhook_events WHERE event_id=$1 AND status='queued' AND available_at<=now()",
          [event.event_id],
        )
      ).rows[0];
      if (!current) return true;
      try {
        await inTransaction(this.pool, async (db) => {
          await this.applyEvent(db, current);
          await db.query(
            "UPDATE stripe_webhook_events SET status='complete',processed_at=now(),last_error_code=NULL WHERE event_id=$1",
            [current.event_id],
          );
          await discordAudit(db, "STRIPE_EVENT_PROCESSED", null, {
            eventId: current.event_id,
          });
        });
      } catch (error) {
        const code =
          error instanceof BillingFailure
            ? error.code
            : "STRIPE_PROCESSING_RETRY";
        const retry = !(error instanceof BillingFailure) || error.retryable;
        await this.pool.query(
          `UPDATE stripe_webhook_events SET attempt_count=attempt_count+1,status=$2,last_error_code=$3,
          available_at=now()+$4*interval '1 second' WHERE event_id=$1`,
          [
            current.event_id,
            retry && current.attempt_count < 24 ? "queued" : "blocked",
            code,
            Math.min(3600, 2 ** Math.min(current.attempt_count + 1, 12)),
          ],
        );
        await discordAudit(this.pool, "STRIPE_EVENT_PROCESSING_FAILED", null, {
          eventId: current.event_id,
          code,
        });
      }
      return true;
    });
  }
  /** Recovers an orphaned SDK response after restart, even after the Discord response token expires.
   * Only reads Stripe. It never creates a replacement customer/session/charge while recovering. */
  public async recoverOrder(): Promise<boolean> {
    if (!this.config.STRIPE_WEBHOOKS_ENABLED) return false;
    const candidate = (
      await this.pool.query<Order>(
        `SELECT o.* FROM stripe_checkout_orders o
      JOIN discord_billing_principals p ON p.id=o.principal_id WHERE p.stripe_account_id=$1 AND p.mode=$2
      AND o.state IN ('creating','open') AND o.recovery_at<=now() ORDER BY o.recovery_at LIMIT 1`,
        [this.config.STRIPE_ACCOUNT_ID!, this.config.STRIPE_MODE],
      )
    ).rows[0];
    if (!candidate) return false;
    return this.locked(candidate.principal_id, async () => {
      const order = (
        await this.pool.query<Order>(
          "SELECT * FROM stripe_checkout_orders WHERE id=$1 AND state IN ('creating','open') AND recovery_at<=now()",
          [candidate.id],
        )
      ).rows[0];
      if (!order) return true;
      await this.pool.query(
        "UPDATE stripe_checkout_orders SET recovery_at=now()+interval '60 seconds' WHERE id=$1",
        [order.id],
      );
      await this.stripe.verifyAccount();
      const p = await this.principalById(order.principal_id);
      if (!p.customer_id) return true; // A customer-only ambiguity cannot grant access; deliberate retry reuses its key.
      const session = order.session_id
        ? await this.stripe.session(order.session_id)
        : order.started_at
          ? await this.stripe.findCheckout(
              p.customer_id,
              order.id,
              order.started_at,
            )
          : null;
      if (!session) return true;
      this.verifySession(order, p, session);
      await inTransaction(this.pool, async (db) => {
        await db.query(
          "SELECT 1 FROM discord_billing_principals WHERE id=$1 FOR NO KEY UPDATE",
          [p.id],
        );
        await db.query(
          "UPDATE stripe_checkout_orders SET session_id=$2,state='open',checkout_url_ciphertext=$3 WHERE id=$1",
          [
            order.id,
            session.id,
            session.status === "open" && session.url
              ? this.secrets.seal(hostedStripeUrl(session.url))
              : null,
          ],
        );
        await this.mapSession(
          db,
          { ...order, session_id: session.id },
          p,
          session,
        );
        if (session.status === "complete" && session.subscription) {
          for (const id of await this.stripe.paidInvoices(session.subscription))
            await db.query(
              `INSERT INTO stripe_webhook_events(event_id,account_id,mode,event_type,object_id,payload_hash,source)
              VALUES($1,$2,$3,'invoice.paid',$4,$5,'canonical_reconciliation') ON CONFLICT DO NOTHING`,
              [
                `reconcile:${id}`,
                p.stripe_account_id,
                p.mode,
                id,
                createHash("sha256").update(`canonical:${id}`).digest("hex"),
              ],
            );
        }
        await discordAudit(db, "STRIPE_ORDER_RECOVERY_CHECKED", null, {
          principalId: p.id,
          orderId: order.id,
          sessionId: session.id,
          status: session.status,
        });
      });
      return true;
    });
  }
}
