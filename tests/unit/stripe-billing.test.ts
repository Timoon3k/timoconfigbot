import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import {
  loadBillingConfig,
  assertPaidRolePolicy,
} from "../../src/billing/config.js";
import { BillingSecrets } from "../../src/billing/secrets.js";
import { hostedStripeUrl } from "../../src/billing/stripe.js";
import { registerBillingRoutes } from "../../src/billing/http.js";
import { BillingService } from "../../src/billing/service.js";
import {
  verifiedInteraction,
  DiscordCommands,
} from "../../src/discord/commands.js";
import type { BillingInteractions } from "../../src/billing/interactions.js";
import type { DatabasePool } from "../../src/db/pool.js";
import type { MembershipService } from "../../src/membership/service.js";
import { stripeFixture, stripeFixtureEnv } from "../stripe-fixture.js";
import { PaidRoleRest } from "../../src/billing/roles.js";
import type { RestDiscordAdapter } from "../../src/discord/rest.js";
import type { PostgresDiscordRateGate } from "../../src/discord/transport.js";
import { DiscordWorker } from "../../src/discord/worker.js";
import type { DiscordSyncService } from "../../src/discord/sync.js";
import type { MemberVerification } from "../../src/discord/verification.js";
import type { BillingWorker } from "../../src/billing/roles.js";
import {
  ticketFixture,
  customerId,
  guildId,
  ticketId,
  messageId,
} from "../ticket-fixture.js";

describe("Discord-first Stripe security contracts", () => {
  it("slow Stripe work never delays Free Member jobs or readiness and starts only once", async () => {
    let finish: (() => void) | undefined;
    const tick = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          finish = () => resolve(0);
        }),
    );
    const sync = {
      pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
      config: ticketFixture().config,
      reconcileBatch: vi.fn().mockResolvedValue(undefined),
      runOne: vi.fn().mockResolvedValue(false),
    } as unknown as DiscordSyncService;
    const verification = {
      reconcileBatch: vi.fn().mockResolvedValue(undefined),
      runOne: vi.fn().mockResolvedValue(false),
    } as unknown as MemberVerification;
    const worker = new DiscordWorker(sync, verification, undefined, {
      tick,
    } as unknown as BillingWorker);
    await worker.tick();
    await worker.tick();
    expect(verification.runOne).toHaveBeenCalledTimes(2);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(worker.lastCompletedAt).not.toBeNull();
    finish!();
    await worker.drainBilling();
    worker.stop();
  });
  it("defaults every new payment and paid-role write gate to OFF", () => {
    const c = loadBillingConfig({});
    expect(c.STRIPE_MODE).toBe("test");
    for (const flag of [
      c.STRIPE_CHECKOUT_ENABLED,
      c.STRIPE_WEBHOOKS_ENABLED,
      c.STRIPE_PORTAL_ENABLED,
      c.STRIPE_LIVE_PAYMENTS_ENABLED,
      c.DISCORD_BILLING_VIP_WRITES_ENABLED,
      c.STRIPE_PAYPAL_ENABLED,
    ])
      expect(flag).toBe(false);
  });
  it.each([true, undefined, "bot"])(
    "VIP REST preflight rejects ineligible member %s before any write",
    async (value) => {
      const d = ticketFixture();
      const f = stripeFixture({
        DISCORD_BILLING_VIP_WRITES_ENABLED: "true",
        DISCORD_BILLING_VIP_APPROVAL_REFERENCE: "fixture-paid-approval",
        DISCORD_BILLING_VIP_CANARY_IDS: customerId,
      });
      const reader = {
        inspectGuild: async () => ({
          id: guildId,
          ownerId: d.config.DISCORD_GUILD_OWNER_ID!,
          roles: d.roles,
          bot: {
            id: d.config.DISCORD_CLIENT_ID,
            roles: ["100000000000000007"],
          },
        }),
        getMember: async () => ({
          id: customerId,
          roles: [],
          ...(value === undefined
            ? {}
            : { pending: value === "bot" ? false : value }),
          bot: value === "bot",
        }),
      } as unknown as RestDiscordAdapter;
      const request = vi.fn();
      const gate = {
        reserve: async () => 0,
        defer: async () => undefined,
      } as unknown as PostgresDiscordRateGate;
      const rest = new PaidRoleRest(
        reader,
        d.config,
        f.config,
        "fixture-only",
        gate,
        request,
      );
      await expect(
        rest.mutate(customerId, d.config.DISCORD_VIP_LIFETIME_ROLE_ID, "add"),
      ).rejects.toThrow("NOT_ELIGIBLE");
      expect(request).not.toHaveBeenCalled();
    },
  );
  it("canary REST writes use only the configured VIP endpoint and require readback confirmation", async () => {
    const d = ticketFixture();
    const f = stripeFixture({
      DISCORD_BILLING_VIP_WRITES_ENABLED: "true",
      DISCORD_BILLING_VIP_APPROVAL_REFERENCE: "fixture-paid-approval",
      DISCORD_BILLING_VIP_CANARY_IDS: customerId,
    });
    let roles: string[] = [];
    const reader = {
      inspectGuild: async () => ({
        id: guildId,
        ownerId: d.config.DISCORD_GUILD_OWNER_ID!,
        roles: d.roles,
        bot: { id: d.config.DISCORD_CLIENT_ID, roles: ["100000000000000007"] },
      }),
      getMember: async () => ({ id: customerId, roles, pending: false }),
    } as unknown as RestDiscordAdapter;
    const request = vi.fn(async () => {
      roles = [d.config.DISCORD_VIP_LIFETIME_ROLE_ID];
      return new Response(null, { status: 204 });
    });
    const gate = {
      reserve: async () => 0,
      defer: async () => undefined,
    } as unknown as PostgresDiscordRateGate;
    const rest = new PaidRoleRest(
      reader,
      d.config,
      f.config,
      "fixture-only",
      gate,
      request,
    );
    await expect(
      rest.mutate(customerId, d.config.DISCORD_FREE_MEMBER_ROLE_ID, "remove"),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    await rest.mutate(customerId, d.config.DISCORD_VIP_LIFETIME_ROLE_ID, "add");
    expect(request).toHaveBeenCalledWith(
      `https://discord.com/api/v10/guilds/${guildId}/members/${customerId}/roles/${d.config.DISCORD_VIP_LIFETIME_ROLE_ID}`,
      expect.objectContaining({ method: "PUT", redirect: "error" }),
    );
  });
  it.each([
    { STRIPE_MODE: "live", STRIPE_SECRET_KEY: "sk_live_fixture" },
    { STRIPE_WEBHOOKS_ENABLED: "false" },
    { BILLING_TERMS_URL: "" },
    { BILLING_REFUND_POLICY_URL: "https://evil.example/terms" },
    { PUBLIC_BILLING_BASE_URL: "http://billing.example.test" },
    { STRIPE_VIP_LIFETIME_PRICE_ID: "price_monthly" },
    { STRIPE_PAYPAL_ENABLED: "true" },
    { DISCORD_BILLING_VIP_WRITES_ENABLED: "true" },
  ])("fails closed for invalid enablement %j", (overrides) => {
    expect(() =>
      loadBillingConfig({ ...stripeFixtureEnv, ...overrides }),
    ).toThrow();
  });
  it("never accepts public or credential-bearing Stripe links", () => {
    for (const url of [
      "https://evil.example/pay",
      "https://checkout.stripe.com.evil.example/pay",
      "http://checkout.stripe.com/pay",
      "https://user:pass@checkout.stripe.com/pay",
    ])
      expect(() => hostedStripeUrl(url)).toThrow();
  });
  it("encrypts ephemeral tokens with tamper detection and domain-separated keys", () => {
    const s = new BillingSecrets("a".repeat(32));
    const encrypted = s.seal("private-test-token");
    expect(encrypted).not.toContain("private-test-token");
    expect(s.open(encrypted)).toBe("private-test-token");
    expect(() => new BillingSecrets("b".repeat(32)).open(encrypted)).toThrow();
  });
  it("uses genuine SDK HMAC verification including missing, wrong and stale signatures", () => {
    const f = stripeFixture();
    const e = f.signed("invoice.paid", "in_fixture");
    expect(f.provider.verifyWebhook(e.raw, e.signature).id).toBe(e.id);
    expect(() => f.provider.verifyWebhook(e.raw, "")).toThrow();
    expect(() =>
      f.provider.verifyWebhook(Buffer.from("{}"), e.signature),
    ).toThrow();
    const old = f.sdk.webhooks.generateTestHeaderString({
      payload: e.raw.toString(),
      secret: "whsec_fixture_only",
      timestamp: Math.floor(Date.now() / 1000) - 600,
    });
    expect(() => f.provider.verifyWebhook(e.raw, old)).toThrow();
  });
  it.each(["unit_amount", "currency", "livemode", "active", "interval"])(
    "rejects incorrect catalog %s",
    async (field) => {
      const f = stripeFixture();
      const price = f.prices.get("price_monthly")!;
      if (field === "interval")
        price.recurring = { interval: "year", interval_count: 1 };
      else
        price[field] = (
          {
            unit_amount: 3999,
            currency: "usd",
            livemode: true,
            active: false,
          } as Record<string, unknown>
        )[field];
      await expect(
        f.provider.verifyPrice("VIP_MONTHLY_AUTO", "price_monthly"),
      ).rejects.toThrow();
    },
  );
  it.each([
    "status",
    "currency",
    "customer",
    "amount_received",
    "captured",
    "paid",
    "amount_captured",
  ])("requires genuine paid-money proof: %s", async (field) => {
    const f = stripeFixture();
    const id = f.money("cus_fixture", 4000);
    const intent = f.intents.get(id)!;
    const charge = f.charges.get(intent.latest_charge)!;
    if (field === "captured" || field === "paid") charge[field] = false;
    else if (field === "amount_captured") charge.amount_captured = 100;
    else
      Object.assign(intent, {
        [field]: (
          {
            status: "processing",
            currency: "usd",
            customer: "cus_foreign",
            amount_received: 0,
          } as Record<string, unknown>
        )[field],
      });
    await expect(f.provider.money(id, "cus_fixture", 4000)).rejects.toThrow();
  });
  it("rejects an account mismatch before creating customer or checkout", async () => {
    const f = stripeFixture();
    f.account.mockResolvedValue({ id: "acct_foreign" } as never);
    await expect(f.provider.createCustomer("principal")).rejects.toThrow(
      "STRIPE_ACCOUNT_MISMATCH",
    );
    expect(f.customers).not.toHaveBeenCalled();
  });
  it("never forces PayPal and excludes it while unapproved", async () => {
    const f = stripeFixture();
    await f.provider.createCheckout({
      orderId: "order",
      customerId: "cus_fixture",
      product: "VIP_MONTHLY_AUTO",
      priceId: "price_monthly",
      expires: Math.floor(Date.now() / 1000) + 2100,
    });
    expect(f.checkout.mock.calls[0]![0]).toMatchObject({
      excluded_payment_method_types: ["paypal"],
      mode: "subscription",
      line_items: [{ price: "price_monthly", quantity: 1 }],
    });
    expect(f.checkout.mock.calls[0]![0]).not.toHaveProperty(
      "payment_method_types",
    );
  });
  it("Portal cannot enable plan changes or immediate cancellation", async () => {
    const f = stripeFixture();
    f.portalConfig.features.subscription_cancel.mode = "immediately";
    await expect(f.provider.portal("cus_fixture", "key")).rejects.toThrow(
      "STRIPE_PORTAL_CONFIGURATION_UNSAFE",
    );
    expect(f.portal).not.toHaveBeenCalled();
  });
  it("paid role policy protects Free/Founder/Staff and other users, separate approvals and test/live segregation", () => {
    const d = ticketFixture().config;
    const c = loadBillingConfig({
      ...stripeFixtureEnv,
      DISCORD_BILLING_VIP_WRITES_ENABLED: "true",
      DISCORD_BILLING_VIP_APPROVAL_REFERENCE: "fixture-paid-approval",
      DISCORD_BILLING_VIP_CANARY_IDS: customerId,
    });
    expect(() =>
      assertPaidRolePolicy(c, d, customerId, d.DISCORD_VIP_MONTHLY_ROLE_ID),
    ).not.toThrow();
    for (const role of [
      d.DISCORD_FREE_MEMBER_ROLE_ID,
      d.DISCORD_STAFF_ROLE_ID,
      d.DISCORD_FOUNDER_ROLE_ID,
    ])
      expect(() => assertPaidRolePolicy(c, d, customerId, role)).toThrow();
    expect(() =>
      assertPaidRolePolicy(
        c,
        d,
        "200000000000000099",
        d.DISCORD_VIP_MONTHLY_ROLE_ID,
      ),
    ).toThrow();
    expect(() =>
      assertPaidRolePolicy(
        {
          ...c,
          DISCORD_BILLING_VIP_APPROVAL_REFERENCE: d.DISCORD_APPROVAL_REFERENCE!,
        },
        d,
        customerId,
        d.DISCORD_VIP_MONTHLY_ROLE_ID,
      ),
    ).toThrow();
    expect(() =>
      assertPaidRolePolicy(
        c,
        { ...d, DISCORD_ENVIRONMENT: "production" },
        customerId,
        d.DISCORD_VIP_MONTHLY_ROLE_ID,
      ),
    ).toThrow();
  });
  it("webhook parser preserves raw bytes; redirects are neutral and no-store", async () => {
    const f = stripeFixture();
    const billing = new BillingService(
      {} as DatabasePool,
      f.config,
      f.provider,
      "s".repeat(32),
    );
    const receive = vi.spyOn(billing, "receive").mockResolvedValue();
    const app = Fastify();
    registerBillingRoutes(app, billing);
    const raw = '{ "not": "normalized" }';
    const res = await app.inject({
      method: "POST",
      url: "/api/payments/stripe/webhook",
      payload: raw,
      headers: {
        "content-type": "application/json",
        "stripe-signature": "fixture-signature",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(receive.mock.calls[0]![0].toString()).toBe(raw);
    const missing = await app.inject({
      method: "POST",
      url: "/api/payments/stripe/webhook",
      payload: raw,
      headers: { "content-type": "application/json" },
    });
    expect(missing.statusCode).toBe(400);
    const redirect = await app.inject({
      url: "/billing/return?paid=true&customer=cus_foreign",
    });
    expect(redirect.headers["cache-control"]).toBe("no-store");
    expect(redirect.body).toContain("does not confirm payment");
    await app.close();
  });
  it("signed buyer identity is enqueued and acknowledged ephemerally before any Stripe work", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pub = publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("hex");
    const d = ticketFixture().config;
    const billing = {
      enabled: () => true,
      enqueue: vi.fn().mockResolvedValue(undefined),
    } as unknown as BillingInteractions;
    const commands = new DiscordCommands(
      {} as DatabasePool,
      {} as MembershipService,
      d,
      undefined,
      billing,
    );
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const raw = Buffer.from(
      JSON.stringify({
        type: 3,
        id: "200000000000000032",
        token: "fixture_private_token",
        application_id: d.DISCORD_CLIENT_ID,
        guild_id: guildId,
        channel_id: ticketId,
        message: { id: messageId, author: { id: d.DISCORD_CLIENT_ID } },
        member: { user: { id: customerId } },
        data: { custom_id: "tc:vip:monthly:v1" },
      }),
    );
    const signature = sign(
      null,
      Buffer.concat([Buffer.from(timestamp), raw]),
      createPrivateKey(privateKey.export({ type: "pkcs8", format: "pem" })),
    ).toString("hex");
    expect(
      await verifiedInteraction(
        raw,
        signature,
        timestamp,
        pub,
        commands,
        d.DISCORD_CLIENT_ID,
      ),
    ).toEqual({ type: 5, data: { flags: 64 } });
    expect(billing.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        memberId: customerId,
        token: "fixture_private_token",
      }),
    );
    await expect(
      verifiedInteraction(
        raw,
        "0".repeat(128),
        timestamp,
        pub,
        commands,
        d.DISCORD_CLIENT_ID,
      ),
    ).rejects.toThrow();
  });
});
