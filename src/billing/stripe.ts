import Stripe from "stripe";
import { z } from "zod";
import { PRODUCT_SPEC } from "../domain/products.js";
import type { BillingConfig } from "./config.js";

export type BillingProduct = "VIP_MONTHLY_AUTO" | "VIP_LIFETIME";
const ref = z
  .union([z.string().min(1), z.object({ id: z.string().min(1) })])
  .transform((v) => (typeof v === "string" ? v : v.id));
const nullableRef = ref.nullable();
const live = { id: z.string().min(1), livemode: z.boolean() };
const priceSchema = z.object({
  id: z.string(),
  active: z.boolean(),
  currency: z.string(),
  unit_amount: z.number().int(),
  type: z.string(),
  livemode: z.boolean(),
  product: z.object({ id: z.string(), active: z.boolean() }),
  recurring: z
    .object({ interval: z.string(), interval_count: z.number().int() })
    .nullable(),
});
const sessionSchema = z.object({
  ...live,
  customer: ref,
  client_reference_id: z.string(),
  mode: z.enum(["payment", "subscription"]),
  status: z.enum(["open", "complete", "expired"]),
  payment_status: z.string(),
  subscription: nullableRef,
  payment_intent: nullableRef,
  amount_total: z.number().int().nullable(),
  currency: z.string().nullable(),
  expires_at: z.number().int(),
  url: z.string().nullable(),
  line_items: z.object({
    has_more: z.boolean(),
    data: z.array(z.object({ quantity: z.number(), price: ref })),
  }),
});
const subscriptionSchema = z.object({
  ...live,
  customer: ref,
  status: z.string(),
  cancel_at_period_end: z.boolean(),
  items: z.object({
    has_more: z.boolean(),
    data: z.array(z.object({ price: ref, quantity: z.number() })),
  }),
});
const invoiceSchema = z.object({
  ...live,
  customer: ref,
  status: z.string(),
  amount_paid: z.number().int(),
  currency: z.string(),
  billing_reason: z.string().nullable(),
  parent: z
    .object({
      type: z.literal("subscription_details"),
      subscription_details: z.object({ subscription: ref }),
    })
    .nullable(),
  lines: z.object({
    has_more: z.boolean(),
    data: z.array(
      z.object({
        amount: z.number().int(),
        currency: z.string(),
        quantity: z.number(),
        period: z.object({ start: z.number().int(), end: z.number().int() }),
        pricing: z.object({
          type: z.literal("price_details"),
          price_details: z.object({ price: ref }),
        }),
        parent: z.object({
          type: z.literal("subscription_item_details"),
          subscription_item_details: z.object({
            subscription: ref,
            proration: z.boolean(),
          }),
        }),
      }),
    ),
  }),
});
const intentSchema = z.object({
  ...live,
  customer: ref,
  status: z.string(),
  amount: z.number().int(),
  amount_received: z.number().int(),
  currency: z.string(),
  latest_charge: ref,
});
const chargeSchema = z.object({
  ...live,
  customer: ref,
  payment_intent: ref,
  paid: z.boolean(),
  captured: z.boolean(),
  status: z.string(),
  amount: z.number().int(),
  amount_captured: z.number().int(),
  amount_refunded: z.number().int(),
  currency: z.string(),
  disputed: z.boolean(),
  created: z.number().int(),
});
export type CheckoutSession = z.infer<typeof sessionSchema>;
export type BillingSubscription = z.infer<typeof subscriptionSchema>;
export type BillingInvoice = z.infer<typeof invoiceSchema>;
export type Charge = z.infer<typeof chargeSchema>;
export type MoneyProof = {
  intentId: string;
  charge: Charge;
  disputed: boolean;
};

export class BillingFailure extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable = false,
  ) {
    super(code);
  }
}
export function requireBilling(
  ok: unknown,
  code: string,
  retryable = false,
): asserts ok {
  if (!ok) throw new BillingFailure(code, retryable);
}
export function hostedStripeUrl(value: string, portal = false): string {
  const url = new URL(value);
  requireBilling(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.hostname === (portal ? "billing.stripe.com" : "checkout.stripe.com"),
    "STRIPE_URL_INVALID",
  );
  return value;
}
export interface StripePort {
  verifyAccount(): Promise<void>;
  verifyPrice(product: BillingProduct, priceId: string): Promise<void>;
  createCustomer(principalId: string): Promise<string>;
  createCheckout(input: {
    orderId: string;
    customerId: string;
    product: BillingProduct;
    priceId: string;
    expires: number;
  }): Promise<CheckoutSession>;
  session(id: string): Promise<CheckoutSession>;
  findCheckout(
    customerId: string,
    orderId: string,
    started: Date,
  ): Promise<CheckoutSession | null>;
  paidInvoices(subscriptionId: string): Promise<string[]>;
  subscription(id: string): Promise<BillingSubscription>;
  cancelRenewal(id: string, key: string): Promise<BillingSubscription>;
  invoice(id: string): Promise<BillingInvoice>;
  invoiceIntent(id: string): Promise<string | null>;
  money(
    intentId: string,
    customerId: string,
    amount: number,
  ): Promise<MoneyProof>;
  charge(id: string): Promise<Charge>;
  disputeCharge(id: string): Promise<string>;
  refundCharge(id: string): Promise<string>;
  portal(customerId: string, key: string): Promise<string>;
  verifyWebhook(raw: Buffer, signature: string): Stripe.Event;
}

/** Official SDK only; no live connection occurs on construction. Reads are canonical, metadata is never authority. */
export class OfficialStripe implements StripePort {
  private accountChecked = false;
  public readonly sdk: Stripe;
  public constructor(
    private readonly config: BillingConfig,
    sdk?: Stripe,
  ) {
    this.sdk =
      sdk ??
      new Stripe(config.STRIPE_SECRET_KEY ?? "sk_test_disabled", {
        apiVersion: "2026-09-30.endive",
        maxNetworkRetries: 2,
        timeout: 5000,
      });
  }
  private mode(value: { livemode: boolean }): void {
    requireBilling(
      value.livemode === (this.config.STRIPE_MODE === "live"),
      "STRIPE_MODE_MISMATCH",
    );
  }
  public async verifyAccount(): Promise<void> {
    if (this.accountChecked) return;
    const account = await this.sdk.accounts.retrieveCurrent();
    requireBilling(
      account.id === this.config.STRIPE_ACCOUNT_ID,
      "STRIPE_ACCOUNT_MISMATCH",
    );
    this.accountChecked = true;
  }
  public async verifyPrice(
    product: BillingProduct,
    priceId: string,
  ): Promise<void> {
    await this.verifyAccount();
    const price = priceSchema.parse(
      await this.sdk.prices.retrieve(priceId, { expand: ["product"] }),
    );
    this.mode(price);
    const spec = PRODUCT_SPEC[product];
    requireBilling(
      price.id === priceId &&
        price.active &&
        price.product.active &&
        price.currency === "eur" &&
        price.unit_amount === spec.amountMinor &&
        (product === "VIP_MONTHLY_AUTO"
          ? price.type === "recurring" &&
            price.recurring?.interval === "month" &&
            price.recurring.interval_count === 1
          : price.type === "one_time" && price.recurring === null),
      "STRIPE_PRICE_MISMATCH",
    );
  }
  public async createCustomer(principalId: string): Promise<string> {
    await this.verifyAccount();
    const customer = await this.sdk.customers.create(
      { metadata: { billing_principal: principalId } },
      { idempotencyKey: `tc:customer:${principalId}` },
    );
    this.mode(customer);
    return customer.id;
  }
  public async createCheckout(input: {
    orderId: string;
    customerId: string;
    product: BillingProduct;
    priceId: string;
    expires: number;
  }): Promise<CheckoutSession> {
    await this.verifyPrice(input.product, input.priceId);
    const base = this.config.PUBLIC_BILLING_BASE_URL!;
    const created = await this.sdk.checkout.sessions.create(
      {
        customer: input.customerId,
        client_reference_id: input.orderId,
        mode: input.product === "VIP_MONTHLY_AUTO" ? "subscription" : "payment",
        line_items: [{ price: input.priceId, quantity: 1 }],
        success_url: `${base}/billing/return`,
        cancel_url: `${base}/billing/cancel`,
        expires_at: input.expires,
        allow_promotion_codes: false,
        automatic_tax: { enabled: false },
        consent_collection: { terms_of_service: "required" },
        // Stripe's dynamic eligible methods remain authoritative. PayPal is excluded until explicitly approved.
        ...(!this.config.STRIPE_PAYPAL_ENABLED
          ? { excluded_payment_method_types: ["paypal" as const] }
          : {}),
        metadata: { checkout_order: input.orderId },
      },
      { idempotencyKey: `tc:checkout:${input.orderId}` },
    );
    return this.session(created.id);
  }
  public async session(id: string): Promise<CheckoutSession> {
    const session = sessionSchema.parse(
      await this.sdk.checkout.sessions.retrieve(id, { expand: ["line_items"] }),
    );
    this.mode(session);
    requireBilling(session.id === id, "STRIPE_OBJECT_MISMATCH");
    return session;
  }
  public async findCheckout(
    customerId: string,
    orderId: string,
    started: Date,
  ): Promise<CheckoutSession | null> {
    const list = await this.sdk.checkout.sessions.list({
      customer: customerId,
      created: { gte: Math.floor(started.getTime() / 1000) - 60 },
      limit: 100,
    });
    requireBilling(!list.has_more, "STRIPE_CHECKOUT_RECOVERY_REVIEW_REQUIRED");
    const matches = list.data.filter((s) => s.client_reference_id === orderId);
    requireBilling(matches.length <= 1, "STRIPE_CHECKOUT_RECOVERY_AMBIGUOUS");
    return matches[0] ? this.session(matches[0].id) : null;
  }
  public async paidInvoices(subscriptionId: string): Promise<string[]> {
    const list = await this.sdk.invoices.list({
      subscription: subscriptionId,
      status: "paid",
      limit: 100,
    });
    requireBilling(!list.has_more, "STRIPE_INVOICE_RECOVERY_REVIEW_REQUIRED");
    for (const invoice of list.data) this.mode(invoice);
    return list.data.map((i) => i.id);
  }
  public async subscription(id: string): Promise<BillingSubscription> {
    const sub = subscriptionSchema.parse(
      await this.sdk.subscriptions.retrieve(id),
    );
    this.mode(sub);
    requireBilling(sub.id === id, "STRIPE_OBJECT_MISMATCH");
    return sub;
  }
  public async cancelRenewal(
    id: string,
    key: string,
  ): Promise<BillingSubscription> {
    await this.sdk.subscriptions.update(
      id,
      { cancel_at_period_end: true },
      { idempotencyKey: key },
    );
    return this.subscription(id);
  }
  public async invoice(id: string): Promise<BillingInvoice> {
    const invoice = invoiceSchema.parse(await this.sdk.invoices.retrieve(id));
    this.mode(invoice);
    requireBilling(invoice.id === id, "STRIPE_OBJECT_MISMATCH");
    return invoice;
  }
  public async invoiceIntent(id: string): Promise<string | null> {
    const list = await this.sdk.invoicePayments.list({
      invoice: id,
      status: "paid",
      limit: 10,
    });
    requireBilling(
      !list.has_more && list.data.length <= 1,
      "STRIPE_INVOICE_SPLIT_PAYMENT_UNSUPPORTED",
    );
    const payment = list.data[0];
    if (!payment || payment.payment.type !== "payment_intent") return null;
    this.mode(payment);
    requireBilling(
      ref.parse(payment.invoice) === id &&
        payment.status === "paid" &&
        payment.amount_paid === 4000 &&
        payment.currency === "eur",
      "STRIPE_INVOICE_PAYMENT_MISMATCH",
    );
    return ref.parse(payment.payment.payment_intent);
  }
  public async charge(id: string): Promise<Charge> {
    const charge = chargeSchema.parse(await this.sdk.charges.retrieve(id));
    this.mode(charge);
    requireBilling(charge.id === id, "STRIPE_OBJECT_MISMATCH");
    return charge;
  }
  public async money(
    intentId: string,
    customerId: string,
    amount: number,
  ): Promise<MoneyProof> {
    const intent = intentSchema.parse(
      await this.sdk.paymentIntents.retrieve(intentId),
    );
    this.mode(intent);
    const charge = await this.charge(intent.latest_charge);
    requireBilling(
      intent.id === intentId &&
        intent.customer === customerId &&
        intent.status === "succeeded" &&
        intent.amount === amount &&
        intent.amount_received === amount &&
        intent.currency === "eur" &&
        charge.customer === customerId &&
        charge.payment_intent === intentId &&
        charge.paid &&
        charge.captured &&
        charge.status === "succeeded" &&
        charge.amount === amount &&
        charge.amount_captured === amount &&
        charge.currency === "eur" &&
        charge.amount_refunded <= amount,
      "STRIPE_MONEY_PROOF_INVALID",
    );
    let disputed = charge.disputed;
    if (disputed) {
      const disputes = await this.sdk.disputes.list({
        charge: charge.id,
        limit: 10,
      });
      requireBilling(!disputes.has_more, "STRIPE_DISPUTE_REVIEW_REQUIRED");
      disputed =
        !disputes.data.length ||
        disputes.data.some(
          (d) => !["won", "warning_closed"].includes(d.status),
        );
    }
    return { intentId, charge, disputed };
  }
  public async disputeCharge(id: string): Promise<string> {
    const dispute = await this.sdk.disputes.retrieve(id);
    this.mode(dispute);
    return ref.parse(dispute.charge);
  }
  public async refundCharge(id: string): Promise<string> {
    const refund = await this.sdk.refunds.retrieve(id);
    // Refund objects have no livemode; canonical Charge supplies mode/customer/payment proof.
    return ref.parse(refund.charge);
  }
  public async portal(customerId: string, key: string): Promise<string> {
    await this.verifyAccount();
    const config = await this.sdk.billingPortal.configurations.retrieve(
      this.config.STRIPE_PORTAL_CONFIGURATION_ID!,
    );
    this.mode(config);
    requireBilling(
      config.active &&
        config.features.subscription_cancel.enabled &&
        config.features.subscription_cancel.mode === "at_period_end" &&
        !config.features.subscription_update.enabled,
      "STRIPE_PORTAL_CONFIGURATION_UNSAFE",
    );
    const portal = await this.sdk.billingPortal.sessions.create(
      {
        customer: customerId,
        configuration: config.id,
        return_url: `${this.config.PUBLIC_BILLING_BASE_URL!}/billing/return`,
      },
      { idempotencyKey: key },
    );
    return hostedStripeUrl(portal.url, true);
  }
  public verifyWebhook(raw: Buffer, signature: string): Stripe.Event {
    return this.sdk.webhooks.constructEvent(
      raw,
      signature,
      this.config.STRIPE_WEBHOOK_SECRET!,
      300,
    );
  }
}
