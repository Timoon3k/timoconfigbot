import { z } from "zod";
import { snowflake, type DiscordConfig } from "../discord/config.js";
import { discordResponse, assertTestGuildNetwork } from "../discord/rest.js";
import { PostgresDiscordRateGate } from "../discord/transport.js";
import type { TicketService } from "../tickets/service.js";
import { BillingFailure, requireBilling } from "./stripe.js";
import { BillingService, type PrivateResponse } from "./service.js";

const inputSchema = z.object({
  interactionId: snowflake,
  guildId: snowflake,
  channelId: snowflake,
  memberId: snowflake,
  messageId: snowflake,
  customId: z.string().max(100),
  token: z.string().regex(/^[A-Za-z0-9._-]{1,2048}$/),
});
export type BillingInteraction = z.infer<typeof inputSchema>;
type Job = {
  interaction_id: string;
  guild_id: string;
  channel_id: string;
  discord_user_id: string;
  message_id: string;
  custom_id: string;
  token_ciphertext: string;
  response_ciphertext: string | null;
  expires_at: Date;
  attempt_count: number;
};
export interface PrivateDiscordReply {
  edit(token: string, response: PrivateResponse): Promise<void>;
}

/** Token-scoped edit of an already acknowledged EPHEMERAL original; never posts channel messages or DMs. */
export class EphemeralDiscordReply implements PrivateDiscordReply {
  public constructor(
    private readonly discord: DiscordConfig,
    private readonly gate: PostgresDiscordRateGate,
    private readonly request: typeof fetch = fetch,
  ) {}
  public async edit(token: string, response: PrivateResponse): Promise<void> {
    assertTestGuildNetwork(this.discord);
    inputSchema.shape.token.parse(token);
    const wait = await this.gate.reserve();
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    const result = await this.request(
      `https://discord.com/api/v10/webhooks/${this.discord.DISCORD_CLIENT_ID}/${encodeURIComponent(token)}/messages/@original`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...response, allowed_mentions: { parse: [] } }),
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      },
    );
    try {
      await discordResponse(result);
    } catch (error) {
      if (result.status === 429) await this.gate.defer(5000);
      throw error;
    }
  }
}
export class BillingInteractions {
  public constructor(
    public readonly billing: BillingService,
    private readonly discord: DiscordConfig,
    private readonly tickets: TicketService,
    private readonly reply: PrivateDiscordReply,
  ) {}
  public enabled(): boolean {
    return (
      this.billing.config.STRIPE_CHECKOUT_ENABLED ||
      this.billing.config.STRIPE_PORTAL_ENABLED
    );
  }
  /** Called only from verifiedInteraction, before any provider request. */
  public async enqueue(input: BillingInteraction): Promise<void> {
    input = inputSchema.parse(input);
    requireBilling(
      this.enabled() &&
        input.guildId === this.discord.DISCORD_GUILD_ID &&
        /^(tc:vip:(monthly|lifetime):v1|tc:bill:(confirm|portal):[0-9a-f-]{36})$/.test(
          input.customId,
        ),
      "STRIPE_INTERACTION_INVALID",
    );
    const created = Number(
      (BigInt(input.interactionId) >> 22n) + 1420070400000n,
    );
    requireBilling(
      created <= Date.now() + 5000 && Date.now() - created < 10 * 60_000,
      "STRIPE_INTERACTION_EXPIRED",
    );
    await this.billing.pool.query(
      `INSERT INTO stripe_discord_interactions
      (interaction_id,guild_id,channel_id,discord_user_id,message_id,custom_id,token_ciphertext,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [
        input.interactionId,
        input.guildId,
        input.channelId,
        input.memberId,
        input.messageId,
        input.customId,
        this.billing.secrets.seal(input.token),
        new Date(created + 14 * 60_000),
      ],
    );
  }
  public async runOne(): Promise<boolean> {
    if (!this.enabled()) return false;
    await this.billing.pool
      .query(`UPDATE stripe_discord_interactions SET state='expired',token_ciphertext=NULL,response_ciphertext=NULL,
      last_error_code='INTERACTION_EXPIRED' WHERE state='queued' AND expires_at<=now()`);
    const job = (
      await this.billing.pool.query<Job>(
        "SELECT * FROM stripe_discord_interactions WHERE state='queued' AND available_at<=now() AND guild_id=$1 ORDER BY available_at,interaction_id LIMIT 1",
        [this.discord.DISCORD_GUILD_ID],
      )
    ).rows[0];
    if (!job) return false;
    return this.billing.locked(
      `interaction:${job.interaction_id}`,
      async () => {
        const current = (
          await this.billing.pool.query<Job>(
            "SELECT * FROM stripe_discord_interactions WHERE interaction_id=$1 AND state='queued' AND available_at<=now() AND expires_at>now()",
            [job.interaction_id],
          )
        ).rows[0];
        if (!current) return true;
        try {
          let response: PrivateResponse;
          if (current.response_ciphertext)
            response = JSON.parse(
              this.billing.secrets.open(current.response_ciphertext),
            ) as PrivateResponse;
          else {
            try {
              response = await this.handle(current);
            } catch (error) {
              if (!(error instanceof BillingFailure) || error.retryable)
                throw error;
              response = {
                content: `Billing request could not be completed safely (${error.code}). No new VIP entitlement was granted. Please contact Staff if a payment is awaiting verification.`,
              };
            }
            await this.billing.pool.query(
              "UPDATE stripe_discord_interactions SET response_ciphertext=$2 WHERE interaction_id=$1",
              [
                current.interaction_id,
                this.billing.secrets.seal(JSON.stringify(response)),
              ],
            );
          }
          requireBilling(
            current.expires_at.getTime() > Date.now(),
            "STRIPE_INTERACTION_EXPIRED",
          );
          await this.reply.edit(
            this.billing.secrets.open(current.token_ciphertext),
            response,
          );
          await this.billing.pool.query(
            "UPDATE stripe_discord_interactions SET state='complete',token_ciphertext=NULL,response_ciphertext=NULL WHERE interaction_id=$1",
            [current.interaction_id],
          );
        } catch {
          await this.billing.pool.query(
            `UPDATE stripe_discord_interactions SET attempt_count=attempt_count+1,
          last_error_code='PRIVATE_BILLING_REPLY_RETRY',available_at=now()+$2*interval '1 second' WHERE interaction_id=$1`,
            [
              current.interaction_id,
              Math.min(60, 2 ** Math.min(current.attempt_count + 1, 6)),
            ],
          );
        }
        return true;
      },
    );
  }
  private async handle(job: Job): Promise<PrivateResponse> {
    const input = {
      interactionId: job.interaction_id,
      guildId: job.guild_id,
      channelId: job.channel_id,
      memberId: job.discord_user_id,
      messageId: job.message_id,
      customId: job.custom_id,
    };
    const initial = job.custom_id.startsWith("tc:vip:");
    try {
      await this.tickets.authorizeBuyer(input, initial);
    } catch {
      throw new BillingFailure("STRIPE_BUYER_NOT_AUTHORIZED");
    }
    const principal = await this.billing.principal(
      job.guild_id,
      job.discord_user_id,
    );
    if (initial) {
      // Reuse selection ledger/rate limits and exact recorded welcome identity.
      try {
        await this.tickets.select(input);
      } catch {
        throw new BillingFailure("STRIPE_SELECTION_REJECTED");
      }
      return this.billing.disclose(
        principal,
        job.channel_id,
        job.custom_id === "tc:vip:monthly:v1"
          ? "VIP_MONTHLY_AUTO"
          : "VIP_LIFETIME",
      );
    }
    const [, , action, id] = job.custom_id.split(":");
    requireBilling(
      id && ["confirm", "portal"].includes(action ?? ""),
      "STRIPE_ACTION_INVALID",
    );
    return action === "confirm"
      ? this.billing.confirm(principal, id, job.channel_id)
      : this.billing.portal(principal, id, job.channel_id, job.interaction_id);
  }
}
