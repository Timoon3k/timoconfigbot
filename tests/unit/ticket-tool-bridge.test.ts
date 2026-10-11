import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isAllowlistedTicketChannel, verifyTicketToolWebhook } from "../../src/tickets/ticket-tool-bridge.js";

const secret = "fixture-not-a-secret-long-enough-for-test";
const now = Date.parse("2026-10-11T10:00:00Z");
const timestamp = String(Math.floor(now / 1000));
const valid = Buffer.from(JSON.stringify({
  id: "test-event-123",
  type: "TICKET_CREATED",
  createdAt: "2026-10-11T10:00:00.000Z",
  data: { ticketId: "tt-123", ticketNumber: 42 },
}));
const sign = (data: Buffer = valid, ts = timestamp) =>
  createHmac("sha256", secret).update(ts + ".").update(data).digest("hex");

describe("Ticket Tool event authentication (pure, no network)", () => {
  it("accepts an authentic signed TICKET_CREATED event", () => {
    expect(verifyTicketToolWebhook({
      rawBody: valid, signature: sign(), timestamp, secret, now,
    })).toMatchObject({ type: "TICKET_CREATED", data: { ticketId: "tt-123" } });
  });
  it("rejects tampering, replay, missing secret and malformed body", () => {
    const input = { rawBody: valid, signature: sign(), timestamp, secret, now };
    expect(() => verifyTicketToolWebhook({ ...input, rawBody: Buffer.from(valid.toString("utf8") + " ") })).toThrow();
    expect(() => verifyTicketToolWebhook({ ...input, now: now + 301_000 })).toThrow();
    expect(() => verifyTicketToolWebhook({ ...input, secret: "x" })).toThrow();
    expect(() => verifyTicketToolWebhook({ ...input, signature: "abcd" })).toThrow();
    const malformed = Buffer.from("{");
    expect(() => verifyTicketToolWebhook({ ...input, rawBody: malformed, signature: sign(malformed) })).toThrow();
  });
  it("rejects validly signed events without required ticket data", () => {
    const rawBody = Buffer.from(JSON.stringify({ id: "x", type: "TICKET_CREATED", createdAt: "2026-10-11T10:00:00Z", data: {} }));
    expect(() => verifyTicketToolWebhook({ rawBody, signature: sign(rawBody), timestamp, secret, now })).toThrow();
  });
});

describe("Ticket Tool candidate channel filtering (no mutations)", () => {
  const guildId = "1557854161805115402";
  // Verified Support category selected by the guild owner for Ticket Tool.
  const categoryId = "1557857668964687913";
  const channelId = "200000000000000002";
  const channel = { id: channelId, guild_id: guildId, parent_id: categoryId, type: 0 };
  it("requires an exact guild and ticket category allowlist", () => {
    expect(isAllowlistedTicketChannel(channel, guildId, new Set([categoryId]))).toBe(true);
    expect(isAllowlistedTicketChannel(channel, guildId, new Set())).toBe(false);
    expect(isAllowlistedTicketChannel(channel, "200000000000000003", new Set([categoryId]))).toBe(false);
    expect(isAllowlistedTicketChannel({ ...channel, parent_id: "200000000000000004" }, guildId, new Set([categoryId]))).toBe(false);
  });
  it("rejects DM, threads and spoofed/non-snowflake channels", () => {
    expect(isAllowlistedTicketChannel({ ...channel, type: 11 }, guildId, new Set([categoryId]))).toBe(false);
    expect(isAllowlistedTicketChannel({ ...channel, parent_id: null }, guildId, new Set([categoryId]))).toBe(false);
    expect(isAllowlistedTicketChannel({ ...channel, id: "malformed" }, guildId, new Set([categoryId]))).toBe(false);
  });
});
