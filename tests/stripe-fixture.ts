import Stripe from "stripe";
import { vi } from "vitest";
import { loadBillingConfig } from "../src/billing/config.js";
import { OfficialStripe } from "../src/billing/stripe.js";

// Synthetic SDK responses only. Every network-facing SDK method used by billing is mocked.
export const stripeFixtureEnv: NodeJS.ProcessEnv = {
  STRIPE_MODE: "test",
  STRIPE_ACCOUNT_ID: "acct_fixture",
  STRIPE_SECRET_KEY: "sk_test_fixture",
  STRIPE_WEBHOOK_SECRET: "whsec_fixture_only",
  STRIPE_CHECKOUT_ENABLED: "true",
  STRIPE_WEBHOOKS_ENABLED: "true",
  STRIPE_PORTAL_ENABLED: "true",
  STRIPE_PORTAL_CONFIGURATION_ID: "bpc_fixture",
  STRIPE_VIP_MONTHLY_PRICE_ID: "price_monthly",
  STRIPE_VIP_LIFETIME_PRICE_ID: "price_lifetime",
  PUBLIC_BILLING_BASE_URL: "https://billing.example.test",
  BILLING_ALLOWED_ORIGINS: "https://billing.example.test",
  BILLING_TERMS_URL: "https://billing.example.test/terms",
  BILLING_PRIVACY_URL: "https://billing.example.test/privacy",
  BILLING_REFUND_POLICY_URL: "https://billing.example.test/refunds",
  BILLING_LIFETIME_TERMS_URL: "https://billing.example.test/lifetime",
  BILLING_LEGAL_REVISION: "fixture-2026-10-11",
};
export function stripeFixture(overrides: NodeJS.ProcessEnv = {}) {
  const config = loadBillingConfig({ ...stripeFixtureEnv, ...overrides });
  const sdk = new Stripe("sk_test_fixture");
  const prices = new Map<string, Record<string, unknown>>([
    [
      "price_monthly",
      {
        id: "price_monthly",
        active: true,
        currency: "eur",
        unit_amount: 4000,
        type: "recurring",
        livemode: false,
        product: { id: "prod_monthly", active: true },
        recurring: { interval: "month", interval_count: 1 },
      },
    ],
    [
      "price_lifetime",
      {
        id: "price_lifetime",
        active: true,
        currency: "eur",
        unit_amount: 10000,
        type: "one_time",
        livemode: false,
        product: { id: "prod_lifetime", active: true },
        recurring: null,
      },
    ],
  ]);
  type Session = {
    id: string;
    customer: string;
    client_reference_id: string;
    mode: string;
    status: string;
    payment_status: string;
    subscription: string | null;
    payment_intent: string | null;
    amount_total: number;
    currency: string;
    expires_at: number;
    url: string;
    livemode: boolean;
    line_items: {
      has_more: boolean;
      data: Array<{ quantity: number; price: string }>;
    };
  };
  const sessions = new Map<string, Session>();
  const subscriptions = new Map<
    string,
    {
      id: string;
      customer: string;
      status: string;
      cancel_at_period_end: boolean;
      livemode: boolean;
      items: {
        has_more: boolean;
        data: Array<{ quantity: number; price: string }>;
      };
    }
  >();
  const intents = new Map<
    string,
    {
      id: string;
      customer: string;
      status: string;
      amount: number;
      amount_received: number;
      currency: string;
      latest_charge: string;
      livemode: boolean;
    }
  >();
  const charges = new Map<
    string,
    {
      id: string;
      customer: string;
      payment_intent: string;
      paid: boolean;
      captured: boolean;
      status: string;
      amount: number;
      amount_captured: number;
      amount_refunded: number;
      currency: string;
      disputed: boolean;
      livemode: boolean;
      created: number;
    }
  >();
  const invoices = new Map<
    string,
    {
      id: string;
      customer: string;
      status: string;
      amount_paid: number;
      currency: string;
      livemode: boolean;
      billing_reason: string;
      parent: { type: string; subscription_details: { subscription: string } };
      lines: {
        has_more: boolean;
        data: Array<{
          amount: number;
          currency: string;
          quantity: number;
          period: { start: number; end: number };
          pricing: { type: string; price_details: { price: string } };
          parent: {
            type: string;
            subscription_item_details: {
              subscription: string;
              proration: boolean;
            };
          };
        }>;
      };
    }
  >();
  const invoicePayments = new Map<string, string | null>();
  const disputes = new Map<
    string,
    { id: string; charge: string; status: string; livemode: boolean }
  >();
  const refunds = new Map<string, { id: string; charge: string }>();
  const idempotency = new Map<string, string>();
  let next = 0;
  const account = vi
    .spyOn(sdk.accounts, "retrieveCurrent")
    .mockResolvedValue({ id: "acct_fixture" } as never);
  vi.spyOn(sdk.prices, "retrieve").mockImplementation(
    async (id) => prices.get(id) as never,
  );
  const customers = vi
    .spyOn(sdk.customers, "create")
    .mockImplementation(async (_params, options) => {
      const key = options?.idempotencyKey ?? "";
      if (!idempotency.has(key)) idempotency.set(key, `cus_${++next}`);
      return { id: idempotency.get(key), livemode: false } as never;
    });
  const checkout = vi
    .spyOn(sdk.checkout.sessions, "create")
    .mockImplementation(async (params, options) => {
      const key = options?.idempotencyKey ?? "";
      if (idempotency.has(key))
        return sessions.get(idempotency.get(key)!) as never;
      const id = `cs_test_${++next}`;
      const price = params!.line_items![0]!.price!;
      sessions.set(id, {
        id,
        customer: params!.customer!,
        client_reference_id: params!.client_reference_id!,
        mode: params!.mode!,
        status: "open",
        payment_status: "unpaid",
        subscription: null,
        payment_intent: null,
        amount_total: price === "price_monthly" ? 4000 : 10000,
        currency: "eur",
        expires_at: params!.expires_at!,
        url: `https://checkout.stripe.com/c/pay/${id}`,
        livemode: false,
        line_items: { has_more: false, data: [{ quantity: 1, price }] },
      });
      idempotency.set(key, id);
      return sessions.get(id) as never;
    });
  vi.spyOn(sdk.checkout.sessions, "retrieve").mockImplementation(
    async (id) => sessions.get(id) as never,
  );
  vi.spyOn(sdk.checkout.sessions, "list").mockImplementation(
    (params) =>
      Promise.resolve({
        has_more: false,
        data: [...sessions.values()].filter(
          (s) => s.customer === params?.customer,
        ),
      }) as never,
  );
  vi.spyOn(sdk.subscriptions, "retrieve").mockImplementation(
    async (id) => subscriptions.get(id) as never,
  );
  const cancel = vi
    .spyOn(sdk.subscriptions, "update")
    .mockImplementation(async (id) => {
      const sub = subscriptions.get(id)!;
      sub.cancel_at_period_end = true;
      return sub as never;
    });
  vi.spyOn(sdk.invoices, "retrieve").mockImplementation(
    async (id) => invoices.get(id) as never,
  );
  vi.spyOn(sdk.invoices, "list").mockImplementation(
    (params) =>
      Promise.resolve({
        has_more: false,
        data: [...invoices.values()].filter(
          (i) =>
            i.parent.subscription_details.subscription ===
              params?.subscription && i.status === "paid",
        ),
      }) as never,
  );
  vi.spyOn(sdk.invoicePayments, "list").mockImplementation((params) => {
    const intent = invoicePayments.get(params!.invoice!);
    return Promise.resolve({
      has_more: false,
      data: intent
        ? [
            {
              id: `inpay_${intent}`,
              invoice: params!.invoice,
              livemode: false,
              status: "paid",
              amount_paid: 4000,
              currency: "eur",
              payment: { type: "payment_intent", payment_intent: intent },
            },
          ]
        : [],
    }) as never;
  });
  vi.spyOn(sdk.paymentIntents, "retrieve").mockImplementation(
    async (id) => intents.get(id) as never,
  );
  vi.spyOn(sdk.charges, "retrieve").mockImplementation(
    async (id) => charges.get(id) as never,
  );
  vi.spyOn(sdk.disputes, "retrieve").mockImplementation(
    async (id) => disputes.get(id) as never,
  );
  vi.spyOn(sdk.disputes, "list").mockImplementation(
    (params) =>
      Promise.resolve({
        has_more: false,
        data: [...disputes.values()].filter((d) => d.charge === params!.charge),
      }) as never,
  );
  vi.spyOn(sdk.refunds, "retrieve").mockImplementation(
    async (id) => refunds.get(id) as never,
  );
  const portalConfig = {
    id: "bpc_fixture",
    active: true,
    livemode: false,
    features: {
      subscription_cancel: { enabled: true, mode: "at_period_end" },
      subscription_update: { enabled: false },
    },
  };
  vi.spyOn(sdk.billingPortal.configurations, "retrieve").mockImplementation(
    async () => portalConfig as never,
  );
  const portal = vi
    .spyOn(sdk.billingPortal.sessions, "create")
    .mockResolvedValue({
      url: "https://billing.stripe.com/p/session/fixture",
    } as never);
  function money(customer: string, amount: number) {
    const id = `pi_${++next}`,
      charge = `ch_${next}`;
    intents.set(id, {
      id,
      customer,
      status: "succeeded",
      amount,
      amount_received: amount,
      currency: "eur",
      latest_charge: charge,
      livemode: false,
    });
    charges.set(charge, {
      id: charge,
      customer,
      payment_intent: id,
      paid: true,
      captured: true,
      status: "succeeded",
      amount,
      amount_captured: amount,
      amount_refunded: 0,
      currency: "eur",
      disputed: false,
      livemode: false,
      created: Math.floor(Date.now() / 1000),
    });
    return id;
  }
  function lifetime(sessionId: string) {
    const s = sessions.get(sessionId)!;
    s.status = "complete";
    s.payment_status = "paid";
    s.payment_intent = money(s.customer, 10000);
    return s;
  }
  function monthly(
    sessionId: string,
    invoiceId = `in_${++next}`,
    start = Math.floor(Date.now() / 1000) - 30,
  ) {
    const s = sessions.get(sessionId)!;
    s.status = "complete";
    s.payment_status = "paid";
    const subId = s.subscription ?? `sub_${++next}`;
    s.subscription = subId;
    subscriptions.set(subId, {
      id: subId,
      customer: s.customer,
      status: "active",
      cancel_at_period_end: false,
      livemode: false,
      items: {
        has_more: false,
        data: [{ quantity: 1, price: "price_monthly" }],
      },
    });
    const intent = money(s.customer, 4000);
    invoicePayments.set(invoiceId, intent);
    invoices.set(invoiceId, {
      id: invoiceId,
      customer: s.customer,
      status: "paid",
      amount_paid: 4000,
      currency: "eur",
      livemode: false,
      billing_reason: "subscription_cycle",
      parent: {
        type: "subscription_details",
        subscription_details: { subscription: subId },
      },
      lines: {
        has_more: false,
        data: [
          {
            amount: 4000,
            currency: "eur",
            quantity: 1,
            period: { start, end: start + 30 * 86400 },
            pricing: {
              type: "price_details",
              price_details: { price: "price_monthly" },
            },
            parent: {
              type: "subscription_item_details",
              subscription_item_details: {
                subscription: subId,
                proration: false,
              },
            },
          },
        ],
      },
    });
    return invoices.get(invoiceId)!;
  }
  function signed(
    type: string,
    objectId: string,
    eventId = `evt_${++next}`,
    change: Record<string, unknown> = {},
  ) {
    const payload = JSON.stringify({
      id: eventId,
      object: "event",
      type,
      livemode: false,
      api_version: "2026-09-30.endive",
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: objectId } },
      ...change,
    });
    return {
      raw: Buffer.from(payload),
      signature: sdk.webhooks.generateTestHeaderString({
        payload,
        secret: "whsec_fixture_only",
      }),
      id: eventId,
    };
  }
  return {
    config,
    sdk,
    provider: new OfficialStripe(config, sdk),
    prices,
    sessions,
    subscriptions,
    intents,
    charges,
    invoices,
    invoicePayments,
    disputes,
    refunds,
    account,
    customers,
    checkout,
    cancel,
    portal,
    portalConfig,
    money,
    lifetime,
    monthly,
    signed,
  };
}
