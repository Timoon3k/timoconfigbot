import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "../../src/db/pool.js";
import { migrateUp } from "../../src/db/migrate.js";
import { DiscordFailure } from "../../src/discord/types.js";
import { TicketService } from "../../src/tickets/service.js";
import {
  ticketFixture,
  ticketId,
  panelId,
  customerId,
  messageId,
  supportCategory,
  vipCategory,
} from "../ticket-fixture.js";
const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  !["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
  !new URL(url).pathname.endsWith("_test")
)
  throw new Error(
    "Disposable local TEST_DATABASE_URL ending in _test required.",
  );
const pool = createPool(url);
beforeAll(async () => {
  await migrateUp(pool);
});
beforeEach(async () => {
  await pool.query(
    "TRUNCATE discord_ticket_selections,discord_ticket_welcome_jobs,discord_ticket_channels,administrative_audit_logs CASCADE",
  );
  await pool.query("DELETE FROM discord_runtime WHERE name LIKE 'tickets:%'");
});
afterAll(async () => {
  await pool.end();
});
function setup(override: NodeJS.ProcessEnv = {}) {
  const f = ticketFixture(override);
  const service = new TicketService(pool, f.config, f.rest);
  const event = {
    id: ticketId,
    guild_id: f.config.DISCORD_GUILD_ID,
    parent_id: vipCategory,
    type: 0 as const,
  };
  const selection = {
    interactionId: "200000000000000030",
    guildId: f.config.DISCORD_GUILD_ID,
    channelId: ticketId,
    memberId: customerId,
    messageId,
    customId: "tc:vip:monthly:v1",
  };
  return { ...f, service, event, selection };
}
async function jobs() {
  return (await pool.query("SELECT * FROM discord_ticket_welcome_jobs")).rows;
}
describe("Durable VIP ticket welcome", () => {
  it("never observes Support, public-panel, wrong guild or unapproved channels", async () => {
    const f = setup();
    await f.service.observe({ ...f.event, parent_id: supportCategory });
    await f.service.observe({ ...f.event, id: panelId, parent_id: null });
    await f.service.observe({ ...f.event, guild_id: "200000000000000099" });
    expect(await jobs()).toEqual([]);
    expect(f.calls).toEqual([]);
  });
  it("commits one outbox for duplicate events and publishes once across workers/restarts", async () => {
    const f = setup();
    await Promise.all([f.service.observe(f.event), f.service.observe(f.event)]);
    expect(await jobs()).toHaveLength(1);
    await Promise.all([f.service.runOne(), f.service.runOne()]);
    const restarted = new TicketService(pool, f.config, f.rest);
    await restarted.observe(f.event);
    expect(await restarted.runOne()).toBe(false);
    expect(f.messages).toHaveLength(1);
    expect((await jobs())[0]).toMatchObject({
      status: "sent",
      message_id: messageId,
    });
    const actions = (
      await pool.query(
        "SELECT action FROM administrative_audit_logs ORDER BY id",
      )
    ).rows.map((r) => r.action);
    expect(actions).toContain("VIP_TICKET_MESSAGE_INTENT");
    expect(actions).toContain("VIP_TICKET_MESSAGE_CONFIRMED");
  });
  it("recovers an ambiguous response after restart without a second POST", async () => {
    const f = setup();
    await f.service.observe(f.event);
    f.loseResponse(true);
    await f.service.runOne();
    expect((await jobs())[0]).toMatchObject({
      status: "retry",
      last_error_code: "DISCORD_TIMEOUT",
    });
    f.loseResponse(false);
    await pool.query(
      "UPDATE discord_ticket_welcome_jobs SET available_at=now()",
    );
    await new TicketService(pool, f.config, f.rest).runOne();
    expect((await jobs())[0].status).toBe("sent");
    expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
  it("retains ambiguous send evidence on recovery rate limits and refuses blind retries", async () => {
    const f = setup();
    await f.service.observe(f.event);
    f.loseResponse(true);
    await f.service.runOne();
    f.loseResponse(false);
    f.messages.length = 0; // Missing/removed evidence is not permission to resend.
    f.setFailure(new DiscordFailure("DISCORD_RATE_LIMITED", true, 60000));
    await pool.query(
      "UPDATE discord_ticket_welcome_jobs SET available_at=now()",
    );
    await f.service.runOne();
    expect((await jobs())[0].send_started_at).not.toBeNull();
    f.setFailure(undefined);
    await pool.query(
      "UPDATE discord_ticket_welcome_jobs SET available_at=now()",
    );
    await f.service.runOne();
    expect((await jobs())[0]).toMatchObject({
      status: "blocked",
      last_error_code: "TICKET_SEND_REVIEW_REQUIRED",
    });
    expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
  it("repairs missed Gateway events via scoped inventory without observing Support", async () => {
    const f = setup();
    await f.service.reconcileBatch();
    expect(await jobs()).toHaveLength(1);
    expect((await jobs())[0].channel_id).toBe(ticketId);
    await new TicketService(pool, f.config, f.rest).reconcileBatch();
    expect(f.calls.filter((c) => c.path.endsWith("/channels"))).toHaveLength(1);
  });
  it("recovers an expired pre-send lease and backs off on missing message permissions", async () => {
    const f = setup();
    await f.service.observe(f.event);
    await pool.query(
      "UPDATE discord_ticket_welcome_jobs SET status='processing',lease_token=gen_random_uuid(),lease_expires_at=now()-interval '1 second'",
    );
    f.channel.permission_overwrites.find(
      (o) => o.id === f.config.DISCORD_CLIENT_ID,
    )!.allow = "0";
    f.channel.permission_overwrites.find(
      (o) => o.id === f.config.DISCORD_CLIENT_ID,
    )!.deny = "2048";
    await f.service.runOne();
    expect((await jobs())[0]).toMatchObject({
      status: "retry",
      last_error_code: "TICKET_MESSAGE_PERMISSIONS_MISSING",
    });
    expect(f.messages).toEqual([]);
  });
  it("keeps messages and selections disabled regardless of active Free Member write flags", async () => {
    const f = setup({
      DISCORD_DRY_RUN: "false",
      DISCORD_WRITES_ENABLED: "true",
      TICKET_TOOL_WELCOME_WRITES_ENABLED: "false",
      TICKET_TOOL_SELECTIONS_ENABLED: "false",
    });
    await f.service.observe(f.event);
    expect(await f.service.runOne()).toBe(false);
    await expect(f.service.select(f.selection)).rejects.toMatchObject({
      code: "TICKET_SELECTIONS_NOT_ENABLED",
    });
    expect(f.calls).toEqual([]);
    expect(f.messages).toEqual([]);
  });
  it("does not retroactively message tickets older than the approved rollout", async () => {
    const f = setup({ TICKET_TOOL_WELCOME_NOT_BEFORE: "2026-10-11T00:00:00Z" });
    await f.service.observe(f.event);
    expect(await f.service.runOne()).toBe(false);
    expect(f.calls).toEqual([]);
  });
  it("marks an expired final lease as blocked instead of leaving processing stuck", async () => {
    const f = setup();
    await f.service.observe(f.event);
    await pool.query(
      "UPDATE discord_ticket_welcome_jobs SET status='processing',attempt_count=$1,lease_token=gen_random_uuid(),lease_expires_at=now()-interval '1 second'",
      [f.config.DISCORD_MAX_ATTEMPTS],
    );
    expect(await f.service.runOne()).toBe(false);
    expect((await jobs())[0]).toMatchObject({
      status: "blocked",
      last_error_code: "LEASE_EXPIRED_MAX_ATTEMPTS",
    });
    expect(f.messages).toEqual([]);
  });
  it("accepts a signed-handler identity with durable click deduplication and no payments or roles", async () => {
    const f = setup();
    await f.service.observe(f.event);
    await f.service.runOne();
    await Promise.all([
      f.service.select(f.selection),
      f.service.select(f.selection),
    ]);
    expect(
      (
        await pool.query(
          "SELECT product_code,discord_user_id FROM discord_ticket_selections",
        )
      ).rows,
    ).toEqual([
      { product_code: "VIP_MONTHLY_AUTO", discord_user_id: customerId },
    ]);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n,
    ).toBe(0);
    expect(
      f.calls.some((c) => ["PUT", "DELETE", "PATCH"].includes(c.method)),
    ).toBe(false);
    await expect(
      f.service.select({ ...f.selection, interactionId: "200000000000000031" }),
    ).rejects.toMatchObject({ code: "TICKET_SELECTION_RATE_LIMITED" });
  });
  it.each([
    "pending",
    "unknown-pending",
    "bot",
    "outsider",
    "other-panel",
    "support",
    "wrong-guild",
    "wrong-product",
  ])("rejects unauthorized selection: %s", async (kind) => {
    const f = setup();
    await f.service.observe(f.event);
    await f.service.runOne();
    const member = f.members.get(customerId)!;
    if (kind === "pending") member.pending = true;
    if (kind === "unknown-pending") delete member.pending;
    if (kind === "bot") member.user.bot = true;
    if (kind === "outsider")
      f.channel.permission_overwrites = f.channel.permission_overwrites.filter(
        (o) => o.id !== customerId,
      );
    if (kind === "support") f.channel.parent_id = supportCategory;
    const input = {
      ...f.selection,
      ...(kind === "other-panel" ? { messageId: "200000000000000099" } : {}),
      ...(kind === "wrong-guild" ? { guildId: "200000000000000099" } : {}),
      ...(kind === "wrong-product" ? { customId: "stripe:charge:100" } : {}),
    };
    await expect(f.service.select(input)).rejects.toThrow();
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM discord_ticket_selections",
        )
      ).rows[0].n,
    ).toBe(0);
  });
});
