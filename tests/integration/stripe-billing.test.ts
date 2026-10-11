import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createPool,
  inTransaction,
  type DatabasePool,
} from "../../src/db/pool.js";
import { migrateUp } from "../../src/db/migrate.js";
import {
  BillingService,
  type Order,
  type Principal,
} from "../../src/billing/service.js";
import { BillingInteractions } from "../../src/billing/interactions.js";
import {
  BillingVipSync,
  type PaidRoleAccess,
} from "../../src/billing/roles.js";
import { TicketService } from "../../src/tickets/service.js";
import { DiscordFailure } from "../../src/discord/types.js";
import {
  ticketFixture,
  guildId,
  ticketId,
  customerId,
  messageId,
  supportCategory,
} from "../ticket-fixture.js";
import { stripeFixture } from "../stripe-fixture.js";

const url = process.env.TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
    !parsed.pathname.endsWith("_test")
  )
    throw new Error(
      "Stripe integration tests require an explicitly configured disposable LOCAL *_test database.",
    );
}
describe.skipIf(!url)(
  "Discord Stripe durable ledger (disposable PostgreSQL only)",
  () => {
    let pool: DatabasePool;
    let f: ReturnType<typeof stripeFixture>;
    let service: BillingService;
    let p: Principal;
    beforeAll(async () => {
      pool = createPool(url!, {
        NODE_ENV: "test",
        DB_SSL_MODE: "disable",
        DB_CONNECTION_MODE: "direct",
      });
      await migrateUp(pool);
    });
    beforeEach(async () => {
      await pool.query(
        "TRUNCATE discord_billing_principals,stripe_webhook_events,stripe_discord_interactions CASCADE",
      );
      f = stripeFixture();
      service = new BillingService(
        pool,
        f.config,
        f.provider,
        "fixture-secret".repeat(4),
      );
      p = await service.principal(guildId, customerId);
    });
    afterAll(async () => {
      if (pool) {
        await pool.query(
          "TRUNCATE discord_billing_principals,stripe_webhook_events,stripe_discord_interactions CASCADE",
        );
        await pool.end();
      }
    });
    async function order(
      product: "VIP_MONTHLY_AUTO" | "VIP_LIFETIME" = "VIP_MONTHLY_AUTO",
    ) {
      await service.disclose(p, ticketId, product);
      const row = (
        await pool.query<Order>(
          "SELECT * FROM stripe_checkout_orders WHERE principal_id=$1 ORDER BY created_at DESC LIMIT 1",
          [p.id],
        )
      ).rows[0]!;
      await service.confirm(p, row.id, ticketId);
      return (
        await pool.query<Order>(
          "SELECT * FROM stripe_checkout_orders WHERE id=$1",
          [row.id],
        )
      ).rows[0]!;
    }
    async function event(type: string, objectId: string, eventId?: string) {
      const e = f.signed(type, objectId, eventId);
      await service.receive(e.raw, e.signature);
      await service.processOne();
      return e;
    }
    async function paidMonthly() {
      const o = await order();
      const invoice = f.monthly(o.session_id!);
      await event("invoice.paid", invoice.id);
      return { o, invoice };
    }
    async function paidLifetime() {
      const o = await order("VIP_LIFETIME");
      const s = f.lifetime(o.session_id!);
      await event("checkout.session.completed", s.id);
      return { o, s };
    }
    it("applies versioned migrations idempotently and enables browser-facing RLS", async () => {
      await migrateUp(pool);
      const versions = (
        await pool.query(
          "SELECT version FROM schema_migrations ORDER BY version",
        )
      ).rows;
      expect(versions.some((v) => String(v.version).startsWith("006"))).toBe(
        true,
      );
      expect(
        (
          await pool.query(
            "SELECT relrowsecurity FROM pg_class WHERE relname='stripe_verified_payments'",
          )
        ).rows[0].relrowsecurity,
      ).toBe(true);
    });
    it("does not invent a website account or grant access from Checkout or redirect", async () => {
      const count = (await pool.query("SELECT count(*) FROM app_users")).rows[0]
        .count;
      const o = await order();
      const invoice = f.monthly(o.session_id!);
      await event("checkout.session.completed", o.session_id!);
      expect(await service.tier(pool, p.id)).toBe("FREE");
      expect(
        (await pool.query("SELECT count(*) FROM app_users")).rows[0].count,
      ).toBe(count);
      await event("invoice.paid", invoice.id);
      expect(await service.tier(pool, p.id)).toBe("VIP_MONTHLY");
    });
    it("handles invoice-before-checkout, duplicate event IDs, and distinct events for one invoice", async () => {
      const { invoice } = await paidMonthly();
      const e = f.signed("invoice.paid", invoice.id, "evt_replay");
      await Promise.all([
        service.receive(e.raw, e.signature),
        service.receive(e.raw, e.signature),
      ]);
      await Promise.all([service.processOne(), service.processOne()]);
      await event("invoice.payment_succeeded", invoice.id);
      expect(
        (await pool.query("SELECT count(*) FROM stripe_verified_payments"))
          .rows[0].count,
      ).toBe("1");
    });
    it("serializes duplicate click races to one Customer and Checkout Session", async () => {
      await Promise.all([
        service.disclose(p, ticketId, "VIP_MONTHLY_AUTO"),
        service.disclose(p, ticketId, "VIP_MONTHLY_AUTO"),
      ]);
      const o = (
        await pool.query<Order>(
          "SELECT * FROM stripe_checkout_orders WHERE principal_id=$1",
          [p.id],
        )
      ).rows[0]!;
      await Promise.all([
        service.confirm(p, o.id, ticketId),
        service.confirm(p, o.id, ticketId),
      ]);
      expect(f.customers).toHaveBeenCalledTimes(1);
      expect(f.checkout).toHaveBeenCalledTimes(1);
      expect(
        (await pool.query("SELECT count(*) FROM stripe_checkout_orders"))
          .rows[0].count,
      ).toBe("1");
    });
    it("blocks cross-user orders, different plans with a pending session and abandoned checkout races", async () => {
      const o = await order();
      const other = await service.principal(guildId, "200000000000000088");
      await expect(service.confirm(other, o.id, ticketId)).rejects.toThrow(
        "STRIPE_ORDER_NOT_OWNED",
      );
      await expect(
        service.disclose(p, ticketId, "VIP_LIFETIME"),
      ).rejects.toThrow("STRIPE_PENDING_CHECKOUT_EXISTS");
      f.sessions.get(o.session_id!)!.status = "expired";
      await service.disclose(p, ticketId, "VIP_LIFETIME");
      expect(await service.tier(pool, p.id)).toBe("FREE");
    });
    it("recovers a failed attempt with the same server idempotency key", async () => {
      const real = f.provider.createCheckout.bind(f.provider);
      vi.spyOn(f.provider, "createCheckout").mockImplementationOnce(
        async (input) => {
          await real(input);
          throw new Error("Synthetic lost response");
        },
      );
      await service.disclose(p, ticketId, "VIP_LIFETIME");
      const o = (
        await pool.query<Order>(
          "SELECT * FROM stripe_checkout_orders WHERE principal_id=$1",
          [p.id],
        )
      ).rows[0]!;
      await expect(service.confirm(p, o.id, ticketId)).rejects.toThrow(
        "Synthetic",
      );
      await service.confirm(p, o.id, ticketId);
      expect(f.sessions.size).toBe(1);
      expect(f.checkout.mock.calls[0]![1]?.idempotencyKey).toBe(
        f.checkout.mock.calls[1]![1]?.idempotencyKey,
      );
    });
    it("rejects stale creating-order recovery beyond Stripe's idempotency retention", async () => {
      const o = await order();
      await pool.query(
        "UPDATE stripe_checkout_orders SET state='creating',started_at=now()-interval '24 hours' WHERE id=$1",
        [o.id],
      );
      await expect(service.confirm(p, o.id, ticketId)).rejects.toThrow(
        "RECOVERY_REVIEW_REQUIRED",
      );
      expect(f.checkout).toHaveBeenCalledTimes(1);
    });
    it.each([
      "currency",
      "amount_total",
      "customer",
      "client_reference_id",
      "price",
      "livemode",
    ])("rejects mismatched session %s without entitlement", async (field) => {
      const o = await order("VIP_LIFETIME");
      const s = f.lifetime(o.session_id!);
      if (field === "price") s.line_items.data[0]!.price = "price_foreign";
      else
        Object.assign(s, {
          [field]: (
            {
              currency: "usd",
              amount_total: 1,
              customer: "cus_foreign",
              client_reference_id: "forged",
              livemode: true,
            } as Record<string, unknown>
          )[field],
        });
      await event("checkout.session.completed", s.id);
      expect(await service.tier(pool, p.id)).toBe("FREE");
      expect(
        (await pool.query("SELECT status FROM stripe_webhook_events")).rows[0]
          .status,
      ).toBe("blocked");
    });
    it("renewals use exact verified UTC billing periods once under concurrency", async () => {
      const { o, invoice } = await paidMonthly();
      const start = invoice.lines.data[0]!.period.end;
      const renewal = f.monthly(o.session_id!, "in_renewal", start);
      const one = f.signed("invoice.paid", renewal.id),
        two = f.signed("invoice.payment_succeeded", renewal.id);
      await Promise.all([
        service.receive(one.raw, one.signature),
        service.receive(two.raw, two.signature),
      ]);
      await Promise.all([service.processOne(), service.processOne()]);
      await service.processOne();
      const payments = (
        await pool.query(
          "SELECT valid_until FROM stripe_verified_payments ORDER BY valid_until",
        )
      ).rows;
      expect(payments).toHaveLength(2);
      expect(payments[1].valid_until.toISOString()).toBe(
        new Date((start + 30 * 86400) * 1000).toISOString(),
      );
    });
    it("failed initial invoices and failed renewals never grant another period", async () => {
      const o = await order();
      const failed = f.monthly(o.session_id!);
      failed.status = "open";
      failed.amount_paid = 0;
      await event("invoice.payment_failed", failed.id);
      expect(await service.tier(pool, p.id)).toBe("FREE");
      failed.status = "paid";
      failed.amount_paid = 4000;
      await event("invoice.paid", failed.id);
      const renewal = f.monthly(o.session_id!, "in_failed_renewal");
      renewal.status = "open";
      renewal.amount_paid = 0;
      await event("invoice.payment_failed", renewal.id);
      expect(
        (await pool.query("SELECT count(*) FROM stripe_verified_payments"))
          .rows[0].count,
      ).toBe("1");
    });
    it("out-of-band invoices cannot grant access", async () => {
      const o = await order();
      const invoice = f.monthly(o.session_id!);
      f.invoicePayments.set(invoice.id, null);
      await event("invoice.paid", invoice.id);
      expect(await service.tier(pool, p.id)).toBe("FREE");
      expect(
        (await pool.query("SELECT last_error_code FROM stripe_webhook_events"))
          .rows[0].last_error_code,
      ).toBe("STRIPE_INVOICE_WITHOUT_REAL_PAYMENT");
    });
    it("cancellation retains paid access and actual expiration reconciles to FREE", async () => {
      const { o } = await paidMonthly();
      const sub = f.subscriptions.get(
        f.sessions.get(o.session_id!)!.subscription!,
      )!;
      sub.cancel_at_period_end = true;
      await event("customer.subscription.updated", sub.id);
      expect(await service.tier(pool, p.id)).toBe("VIP_MONTHLY");
      sub.status = "canceled";
      await event("customer.subscription.deleted", sub.id);
      expect(await service.tier(pool, p.id)).toBe("VIP_MONTHLY");
      await pool.query(
        "UPDATE stripe_verified_payments SET valid_from=now()-interval '2 months',valid_until=now()-interval '1 second'",
      );
      expect(await service.tier(pool, p.id)).toBe("FREE");
    });
    it("Lifetime has no fixed end, higher priority, and requires explicit renewal-stop upgrade consent", async () => {
      await paidMonthly();
      const disclosure = await service.disclose(p, ticketId, "VIP_LIFETIME");
      expect(disclosure.content).toContain("schedules cancellation");
      const o = (
        await pool.query<Order>(
          "SELECT * FROM stripe_checkout_orders WHERE principal_id=$1 AND state='prepared'",
          [p.id],
        )
      ).rows[0]!;
      await service.confirm(p, o.id, ticketId);
      expect(f.cancel).toHaveBeenCalledTimes(1);
      const updated = (
        await pool.query<Order>(
          "SELECT * FROM stripe_checkout_orders WHERE id=$1",
          [o.id],
        )
      ).rows[0]!;
      f.lifetime(updated.session_id!);
      await event("checkout.session.completed", updated.session_id!);
      expect(await service.tier(pool, p.id)).toBe("VIP_LIFETIME");
      expect(
        (
          await pool.query(
            "SELECT valid_until FROM stripe_verified_payments WHERE tier='VIP_LIFETIME'",
          )
        ).rows[0].valid_until,
      ).toBeNull();
      await expect(
        service.disclose(p, ticketId, "VIP_LIFETIME"),
      ).rejects.toThrow("ALREADY_ACTIVE");
    });
    it("refund and chargeback isolation preserves an unrelated Lifetime and other paid monthly invoices", async () => {
      const { o, invoice } = await paidMonthly();
      const renewal = f.monthly(o.session_id!, "in_second");
      await event("invoice.paid", renewal.id);
      const monthlyCharge = f.charges.get(
        f.intents.get(f.invoicePayments.get(invoice.id)!)!.latest_charge,
      )!;
      monthlyCharge.amount_refunded = 4000;
      await event("charge.refunded", monthlyCharge.id);
      expect(await service.tier(pool, p.id)).toBe("VIP_MONTHLY");
      await service.disclose(p, ticketId, "VIP_LIFETIME");
      const lo = (
        await pool.query<Order>(
          "SELECT * FROM stripe_checkout_orders WHERE state='prepared'",
          [],
        )
      ).rows[0]!;
      await service.confirm(p, lo.id, ticketId);
      const mapped = (
        await pool.query<Order>(
          "SELECT * FROM stripe_checkout_orders WHERE id=$1",
          [lo.id],
        )
      ).rows[0]!;
      f.lifetime(mapped.session_id!);
      await event("checkout.session.completed", mapped.session_id!);
      const charge = f.charges.get(
        f.intents.get(f.invoicePayments.get(renewal.id)!)!.latest_charge,
      )!;
      charge.disputed = true;
      f.disputes.set("dp_monthly", {
        id: "dp_monthly",
        charge: charge.id,
        status: "lost",
        livemode: false,
      });
      await event("charge.dispute.closed", "dp_monthly");
      expect(await service.tier(pool, p.id)).toBe("VIP_LIFETIME");
    });
    it("won dispute restores only its payment; partial refund suspends only that entitlement", async () => {
      const { s } = await paidLifetime();
      const charge = f.charges.get(
        f.intents.get(s.payment_intent!)!.latest_charge,
      )!;
      charge.disputed = true;
      f.disputes.set("dp_test", {
        id: "dp_test",
        charge: charge.id,
        status: "needs_response",
        livemode: false,
      });
      await event("charge.dispute.created", "dp_test");
      expect(await service.tier(pool, p.id)).toBe("FREE");
      f.disputes.get("dp_test")!.status = "won";
      await event("charge.dispute.closed", "dp_test");
      expect(await service.tier(pool, p.id)).toBe("VIP_LIFETIME");
      charge.amount_refunded = 100;
      await event("charge.refunded", charge.id);
      expect(await service.tier(pool, p.id)).toBe("FREE");
    });
    it("refund arrives before checkout payment and is reconciled without temporary access", async () => {
      const o = await order("VIP_LIFETIME");
      const s = f.lifetime(o.session_id!);
      const charge = f.charges.get(
        f.intents.get(s.payment_intent!)!.latest_charge,
      )!;
      charge.amount_refunded = 10000;
      const early = await event("charge.refunded", charge.id);
      expect(await service.tier(pool, p.id)).toBe("FREE");
      await event("checkout.session.completed", s.id);
      expect(await service.tier(pool, p.id)).toBe("FREE");
      await pool.query(
        "UPDATE stripe_webhook_events SET available_at=now() WHERE event_id=$1",
        [early.id],
      );
      await service.processOne();
      expect(
        (
          await pool.query(
            "SELECT status FROM stripe_webhook_events WHERE event_id=$1",
            [early.id],
          )
        ).rows[0].status,
      ).toBe("complete");
    });
    it.each(["price", "amount", "currency", "proration", "customer", "unpaid"])(
      "bad invoice %s cannot create an entitlement",
      async (field) => {
        const o = await order();
        const invoice = f.monthly(o.session_id!);
        const line = invoice.lines.data[0]!;
        if (field === "price")
          line.pricing.price_details.price = "price_foreign";
        if (field === "amount") invoice.amount_paid = 1;
        if (field === "currency") invoice.currency = "usd";
        if (field === "proration")
          line.parent.subscription_item_details.proration = true;
        if (field === "customer") invoice.customer = "cus_foreign";
        if (field === "unpaid") invoice.status = "open";
        await event("invoice.paid", invoice.id);
        expect(await service.tier(pool, p.id)).toBe("FREE");
      },
    );
    it("uses Stripe's end-of-month period without adding a rolling duration", async () => {
      const o = await order();
      const start = Date.parse("2026-01-31T14:00:00Z") / 1000;
      const invoice = f.monthly(o.session_id!, "in_end_of_month", start);
      invoice.lines.data[0]!.period.end =
        Date.parse("2026-02-28T14:00:00Z") / 1000;
      await event("invoice.paid", invoice.id);
      const row = (
        await pool.query("SELECT valid_until FROM stripe_verified_payments")
      ).rows[0];
      expect(row.valid_until.toISOString()).toBe("2026-02-28T14:00:00.000Z");
    });
    it("recovers an orphaned paid Checkout after token expiry without creating another payment", async () => {
      const o = await order("VIP_LIFETIME");
      f.lifetime(o.session_id!);
      await pool.query(
        "UPDATE stripe_checkout_orders SET state='creating',session_id=NULL,checkout_url_ciphertext=NULL WHERE id=$1",
        [o.id],
      );
      // Simulate a restarted worker with Checkout disabled: canonical reads still recover existing money.
      const recovery = new BillingService(
        pool,
        { ...f.config, STRIPE_CHECKOUT_ENABLED: false },
        f.provider,
        "fixture-secret".repeat(4),
      );
      await recovery.recoverOrder();
      expect(await recovery.tier(pool, p.id)).toBe("VIP_LIFETIME");
      expect(f.checkout).toHaveBeenCalledTimes(1);
      expect(f.customers).toHaveBeenCalledTimes(1);
    });
    it("recovers a paid monthly invoice from canonical Stripe objects after missing delivery", async () => {
      const o = await order();
      f.monthly(o.session_id!);
      await service.recoverOrder();
      await service.processOne();
      expect(await service.tier(pool, p.id)).toBe("VIP_MONTHLY");
      expect(
        (await pool.query("SELECT source FROM stripe_webhook_events")).rows[0]
          .source,
      ).toBe("canonical_reconciliation");
    });
    it("Portal is principal-owned and never takes another Customer ID", async () => {
      const { o } = await paidMonthly();
      const owner = await service.principal(guildId, customerId);
      const foreign = await service.principal(guildId, "200000000000000088");
      await expect(
        service.portal(foreign, o.id, ticketId, "fixture"),
      ).rejects.toThrow("NOT_OWNED");
      const response = await service.portal(owner, o.id, ticketId, "fixture");
      expect(response.content).toContain("VIP_MONTHLY");
      expect(f.portal.mock.calls[0]![0]?.customer).toBe(owner.customer_id);
    });
    it.each([true, undefined])(
      "a ticket member with pending=%s cannot select billing",
      async (pending) => {
        const t = ticketFixture();
        const tickets = new TicketService(pool, t.config, t.rest);
        await tickets.observe({ ...t.channel, type: 0 });
        await tickets.runOne();
        const member = t.members.get(customerId)!;
        if (pending === undefined) delete member.pending;
        else member.pending = pending;
        await expect(
          tickets.authorizeBuyer({
            guildId,
            channelId: ticketId,
            memberId: customerId,
            messageId,
          }),
        ).rejects.toThrow("BUYER_NOT_ELIGIBLE");
        expect(f.checkout).not.toHaveBeenCalled();
      },
    );
    it("bots and humans without private-ticket visibility cannot select billing", async () => {
      const t = ticketFixture();
      const tickets = new TicketService(pool, t.config, t.rest);
      await tickets.observe({ ...t.channel, type: 0 });
      await tickets.runOne();
      t.members.get(customerId)!.user.bot = true;
      await expect(
        tickets.authorizeBuyer({
          guildId,
          channelId: ticketId,
          memberId: customerId,
          messageId,
        }),
      ).rejects.toThrow();
      t.members.get(customerId)!.user.bot = false;
      t.channel.permission_overwrites = t.channel.permission_overwrites.filter(
        (o) => o.id !== customerId,
      );
      await expect(
        tickets.authorizeBuyer({
          guildId,
          channelId: ticketId,
          memberId: customerId,
          messageId,
        }),
      ).rejects.toThrow();
    });
    it("an explicitly rejected role request retries safely with a fresh journal intent", async () => {
      await paidLifetime();
      const t = ticketFixture();
      let roles: string[] = [];
      const mutate = vi.fn(async (_id: string, role: string) => {
        roles = [role];
      });
      mutate.mockRejectedValueOnce(
        new DiscordFailure("DISCORD_RATE_LIMITED", true, 100),
      );
      const access: PaidRoleAccess = {
        reader: {
          getMember: async () => ({ id: customerId, roles, pending: false }),
          inspectGuild: async () => ({
            id: guildId,
            ownerId: t.config.DISCORD_GUILD_OWNER_ID!,
            roles: t.roles,
            bot: {
              id: t.config.DISCORD_CLIENT_ID,
              roles: ["100000000000000007"],
              bot: true,
            },
          }),
        },
        mutate,
      };
      const c = {
        ...f.config,
        DISCORD_BILLING_VIP_WRITES_ENABLED: true,
        DISCORD_BILLING_VIP_APPROVAL_REFERENCE: "fixture-vip-only",
        DISCORD_BILLING_VIP_CANARY_IDS: [customerId],
      };
      const sync = new BillingVipSync(
        new BillingService(pool, c, f.provider, "fixture-secret".repeat(4)),
        t.config,
        access,
      );
      await sync.runOne();
      await pool.query(
        "UPDATE stripe_vip_sync_state SET checked_at='-infinity'",
      );
      await sync.runOne();
      expect(mutate).toHaveBeenCalledTimes(2);
      expect(
        (await pool.query("SELECT count(*) FROM stripe_vip_role_ownership"))
          .rows[0].count,
      ).toBe("1");
    });
    it("financial transaction rollback and worker restart retry leave no partial payment", async () => {
      const o = await order("VIP_LIFETIME");
      f.lifetime(o.session_id!);
      await pool.query(
        `CREATE FUNCTION stripe_test_rollback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic rollback'; END $$`,
      );
      await pool.query(
        "CREATE TRIGGER stripe_test_rollback BEFORE INSERT ON stripe_vip_sync_state FOR EACH ROW EXECUTE FUNCTION stripe_test_rollback()",
      );
      const e = await event("checkout.session.completed", o.session_id!);
      expect(
        (await pool.query("SELECT count(*) FROM stripe_verified_payments"))
          .rows[0].count,
      ).toBe("0");
      await pool.query(
        "DROP TRIGGER stripe_test_rollback ON stripe_vip_sync_state",
      );
      await pool.query("DROP FUNCTION stripe_test_rollback()");
      await pool.query(
        "UPDATE stripe_webhook_events SET available_at=now() WHERE event_id=$1",
        [e.id],
      );
      const restarted = new BillingService(
        pool,
        f.config,
        f.provider,
        "fixture-secret".repeat(4),
      );
      await restarted.processOne();
      expect(await restarted.tier(pool, p.id)).toBe("VIP_LIFETIME");
    });
    it("rejects signed foreign mode/account/API version and event ID payload collisions", async () => {
      for (const change of [
        { livemode: true },
        { account: "acct_foreign" },
        { api_version: "old" },
      ]) {
        const e = f.signed("invoice.paid", "in_fixture", undefined, change);
        await expect(service.receive(e.raw, e.signature)).rejects.toThrow();
      }
      const e = f.signed("invoice.paid", "in_fixture", "evt_collision");
      await service.receive(e.raw, e.signature);
      const other = f.signed("invoice.paid", "in_other", "evt_collision");
      await expect(service.receive(other.raw, other.signature)).rejects.toThrow(
        "COLLISION",
      );
    });
    it("private interactions survive restarts, deduplicate, erase tokens and reject Support/other ticket buyers", async () => {
      const t = ticketFixture();
      const tickets = new TicketService(pool, t.config, t.rest);
      await tickets.observe({ ...t.channel, type: 0 });
      await tickets.runOne();
      const edit = vi.fn().mockResolvedValue(undefined);
      const interactions = new BillingInteractions(service, t.config, tickets, {
        edit,
      });
      const id = (
        (BigInt(Date.now() - 1000) - 1420070400000n) <<
        22n
      ).toString();
      const input = {
        interactionId: id,
        guildId,
        channelId: ticketId,
        memberId: customerId,
        messageId,
        customId: "tc:vip:monthly:v1",
        token: "fixture_private_token",
      };
      await Promise.all([
        interactions.enqueue(input),
        interactions.enqueue(input),
      ]);
      await interactions.runOne();
      expect(edit).toHaveBeenCalledTimes(1);
      expect(f.checkout).not.toHaveBeenCalled();
      expect(edit.mock.calls[0]![1].content).toContain("EUR 40/month");
      const stored = (
        await pool.query(
          "SELECT token_ciphertext,state FROM stripe_discord_interactions WHERE interaction_id=$1",
          [id],
        )
      ).rows[0];
      expect(stored).toMatchObject({
        token_ciphertext: null,
        state: "complete",
      });
      t.channel.parent_id = supportCategory;
      await interactions.enqueue({
        ...input,
        interactionId: (BigInt(id) + 1n).toString(),
      });
      await interactions.runOne();
      expect(edit.mock.calls[1]![1].content).toContain("NOT_AUTHORIZED");
    });
    it("VIP writes preview by default; canary mutation is serialized, bot-owned only and Free/Staff/Founder survive", async () => {
      await paidLifetime();
      const t = ticketFixture();
      let roles = [
        t.config.DISCORD_FREE_MEMBER_ROLE_ID,
        t.config.DISCORD_STAFF_ROLE_ID,
        t.config.DISCORD_FOUNDER_ROLE_ID,
        t.config.DISCORD_VIP_MONTHLY_ROLE_ID,
      ];
      const access: PaidRoleAccess = {
        reader: {
          getMember: async () => ({ id: customerId, roles, pending: false }),
          inspectGuild: async () => ({
            id: guildId,
            ownerId: t.config.DISCORD_GUILD_OWNER_ID!,
            roles: t.roles,
            bot: {
              id: t.config.DISCORD_CLIENT_ID,
              roles: ["100000000000000007"],
              bot: true,
            },
          }),
        },
        mutate: vi.fn(async (_id, role, op) => {
          roles =
            op === "add" ? [...roles, role] : roles.filter((r) => r !== role);
        }),
      };
      const preview = new BillingVipSync(service, t.config, access);
      await preview.runOne();
      expect(access.mutate).not.toHaveBeenCalled();
      const c = {
        ...f.config,
        DISCORD_BILLING_VIP_WRITES_ENABLED: true,
        DISCORD_BILLING_VIP_APPROVAL_REFERENCE: "fixture-vip-only",
        DISCORD_BILLING_VIP_CANARY_IDS: [customerId],
      };
      const live = new BillingService(
        pool,
        c,
        f.provider,
        "fixture-secret".repeat(4),
      );
      const sync = new BillingVipSync(live, t.config, access);
      await pool.query(
        "UPDATE stripe_vip_sync_state SET checked_at='-infinity'",
      );
      await Promise.all([sync.runOne(), sync.runOne()]);
      expect(access.mutate).toHaveBeenCalledTimes(1);
      expect(roles).toContain(t.config.DISCORD_VIP_LIFETIME_ROLE_ID);
      // Manually assigned Monthly, Free, Founder and Staff are never adopted or removed.
      expect(roles).toContain(t.config.DISCORD_VIP_MONTHLY_ROLE_ID);
      expect(roles).toContain(t.config.DISCORD_FREE_MEMBER_ROLE_ID);
      const payment = (
        await pool.query("SELECT charge_id FROM stripe_verified_payments")
      ).rows[0];
      f.charges.get(payment.charge_id)!.amount_refunded = 10000;
      await event("charge.refunded", payment.charge_id);
      await sync.runOne();
      expect(roles).not.toContain(t.config.DISCORD_VIP_LIFETIME_ROLE_ID);
      expect(roles).toHaveLength(4);
    });
    it("unknown VIP write outcome is journalled, never repeated or adopted", async () => {
      await paidLifetime();
      const t = ticketFixture();
      let roles: string[] = [];
      const access: PaidRoleAccess = {
        reader: {
          getMember: async () => ({ id: customerId, roles, pending: false }),
          inspectGuild: async () => ({
            id: guildId,
            ownerId: t.config.DISCORD_GUILD_OWNER_ID!,
            roles: t.roles,
            bot: {
              id: t.config.DISCORD_CLIENT_ID,
              roles: ["100000000000000007"],
              bot: true,
            },
          }),
        },
        mutate: vi.fn(async (_id, role) => {
          roles = [role];
          throw new DiscordFailure("DISCORD_TIMEOUT", true);
        }),
      };
      const c = {
        ...f.config,
        DISCORD_BILLING_VIP_WRITES_ENABLED: true,
        DISCORD_BILLING_VIP_APPROVAL_REFERENCE: "fixture-vip-only",
        DISCORD_BILLING_VIP_CANARY_IDS: [customerId],
      };
      const sync = new BillingVipSync(
        new BillingService(pool, c, f.provider, "fixture-secret".repeat(4)),
        t.config,
        access,
      );
      await sync.runOne();
      await pool.query(
        "UPDATE stripe_vip_sync_state SET checked_at='-infinity'",
      );
      await sync.runOne();
      expect(access.mutate).toHaveBeenCalledTimes(1);
      expect(
        (await pool.query("SELECT count(*) FROM stripe_vip_role_ownership"))
          .rows[0].count,
      ).toBe("0");
      expect(
        (
          await pool.query(
            "SELECT status FROM discord_role_operations WHERE billing_principal_id=$1",
            [p.id],
          )
        ).rows[0].status,
      ).toBe("uncertain");
    });
    it("recovers paid-role ownership after commit failure and restores access on rejoin", async () => {
      await paidLifetime();
      const t = ticketFixture();
      let roles: string[] = [];
      let present = true;
      const access: PaidRoleAccess = {
        reader: {
          getMember: async () =>
            present ? { id: customerId, roles, pending: false } : null,
          inspectGuild: async () => ({
            id: guildId,
            ownerId: t.config.DISCORD_GUILD_OWNER_ID!,
            roles: t.roles,
            bot: {
              id: t.config.DISCORD_CLIENT_ID,
              roles: ["100000000000000007"],
              bot: true,
            },
          }),
        },
        mutate: vi.fn(async (_id, role, action) => {
          roles =
            action === "add"
              ? [...roles, role]
              : roles.filter((r) => r !== role);
        }),
      };
      const c = {
        ...f.config,
        DISCORD_BILLING_VIP_WRITES_ENABLED: true,
        DISCORD_BILLING_VIP_APPROVAL_REFERENCE: "fixture-vip-only",
        DISCORD_BILLING_VIP_CANARY_IDS: [customerId],
      };
      const sync = new BillingVipSync(
        new BillingService(pool, c, f.provider, "fixture-secret".repeat(4)),
        t.config,
        access,
      );
      await pool.query(
        `CREATE FUNCTION stripe_role_rollback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic ownership failure'; END $$`,
      );
      await pool.query(
        "CREATE TRIGGER stripe_role_rollback BEFORE INSERT ON stripe_vip_role_ownership FOR EACH ROW EXECUTE FUNCTION stripe_role_rollback()",
      );
      try {
        await expect(sync.runOne()).rejects.toThrow();
      } finally {
        await pool.query(
          "DROP TRIGGER stripe_role_rollback ON stripe_vip_role_ownership",
        );
        await pool.query("DROP FUNCTION stripe_role_rollback()");
      }
      expect(
        (
          await pool.query(
            "SELECT status FROM discord_role_operations WHERE billing_principal_id=$1",
            [p.id],
          )
        ).rows[0].status,
      ).toBe("confirmed");
      await sync.runOne();
      expect(access.mutate).toHaveBeenCalledTimes(1);
      expect(
        (await pool.query("SELECT count(*) FROM stripe_vip_role_ownership"))
          .rows[0].count,
      ).toBe("1");
      present = false;
      roles = [];
      await pool.query(
        "UPDATE stripe_vip_sync_state SET checked_at='-infinity'",
      );
      await sync.runOne();
      expect(access.mutate).toHaveBeenCalledTimes(1);
      present = true;
      await pool.query(
        "UPDATE stripe_vip_sync_state SET checked_at='-infinity'",
      );
      await sync.runOne();
      expect(access.mutate).toHaveBeenCalledTimes(2);
      expect(roles).toContain(t.config.DISCORD_VIP_LIFETIME_ROLE_ID);
    });
    it("does not change entitlements on a rolled back database transaction", async () => {
      await paidMonthly();
      await expect(
        inTransaction(pool, async (db) => {
          await db.query(
            "UPDATE stripe_verified_payments SET refunded_minor=4000 WHERE principal_id=$1",
            [p.id],
          );
          throw new Error("rollback");
        }),
      ).rejects.toThrow();
      expect(await service.tier(pool, p.id)).toBe("VIP_MONTHLY");
    });
  },
);
