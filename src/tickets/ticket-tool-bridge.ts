import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { snowflake } from "../discord/config.js";

/**
 * Ticket Tool webhook signatures follow:
 * HMAC_SHA256(secret, timestamp + "." + originalRawBody).
 * Always verify *before* parsing JSON or accepting any ticket event.
 * This module is side-effect free: never grants a role or charges a customer.
 */
const ticketToolWebhookSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.enum(["TICKET_CREATED", "TICKET_UPDATED", "TICKET_CLOSED", "TICKET_REOPENED", "TICKET_DELETED"]),
  createdAt: z.string().datetime({ offset: true }),
  data: z.object({
    ticketId: z.string().min(1).max(200),
    ticketNumber: z.number().int().positive().optional(),
  }).passthrough(),
});

export type VerifiedTicketToolEvent = z.infer<typeof ticketToolWebhookSchema>;

export function verifyTicketToolWebhook(input: {
  rawBody: Buffer;
  signature: string | undefined;
  timestamp: string | undefined;
  secret: string;
  now?: number;
}): VerifiedTicketToolEvent {
  const { rawBody, signature, timestamp, secret, now = Date.now() } = input;
  if (
    rawBody.length === 0 ||
    rawBody.length > 64 * 1024 ||
    secret.length < 32 ||
    !signature ||
    !/^[0-9a-fA-F]{64}$/.test(signature) ||
    !timestamp ||
    !/^\d{10}$/.test(timestamp) ||
    Math.abs(now - Number(timestamp) * 1000) > 5 * 60 * 1000
  ) throw new Error("TICKET_TOOL_WEBHOOK_INVALID");

  const expected = createHmac("sha256", secret)
    .update(timestamp, "utf8")
    .update(".")
    .update(rawBody)
    .digest();
  const received = Buffer.from(signature, "hex");
  if (received.length !== expected.length || !timingSafeEqual(expected, received))
    throw new Error("TICKET_TOOL_WEBHOOK_INVALID");
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new Error("TICKET_TOOL_WEBHOOK_INVALID");
  }
  const parsed = ticketToolWebhookSchema.safeParse(body);
  if (!parsed.success) throw new Error("TICKET_TOOL_WEBHOOK_INVALID");
  return parsed.data;
}

export const ticketChannel = z.object({
  id: snowflake,
  guild_id: snowflake,
  parent_id: snowflake.nullable(),
  type: z.literal(0),
});

/**
 * Guild channel creation cannot prove who opened a Ticket Tool ticket.
 * Exact allowlisting only identifies a candidate ticket channel.
 * The buyer must ALWAYS be bound to a signed Discord interaction; do not
 * infer their identity from the channel name, topic or Ticket Tool message.
 */
export function isAllowlistedTicketChannel(
  payload: unknown,
  guildId: string,
  categoryIds: ReadonlySet<string>,
): boolean {
  if (categoryIds.size === 0) return false;
  const channel = ticketChannel.safeParse(payload);
  return channel.success &&
    channel.data.guild_id === guildId &&
    channel.data.parent_id !== null &&
    categoryIds.has(channel.data.parent_id);
}
