import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { inTransaction, type DatabasePool } from "../db/pool.js";
import { discordAudit } from "../discord/audit.js";
import { snowflake, type DiscordConfig } from "../discord/config.js";
import { DiscordFailure } from "../discord/types.js";
import {
  isAllowlistedTicketChannel,
  type TicketChannel,
} from "./ticket-tool-bridge.js";
import { channelPermissions, channelSchema, VIEW } from "./permissions.js";
import { TicketRest } from "./rest.js";

type Job = {
  guild_id: string;
  channel_id: string;
  nonce: string;
  lease_token: string;
  attempt_count: number;
  send_started_at: Date | null;
};
export class TicketService {
  public constructor(
    private readonly pool: DatabasePool,
    private readonly config: DiscordConfig,
    private readonly rest: TicketRest,
  ) {}
  public async observe(
    channel: TicketChannel,
    source: "gateway" | "reconcile" = "gateway",
  ): Promise<void> {
    if (
      !this.config.TICKET_TOOL_CHANNEL_OBSERVATION_ENABLED ||
      !isAllowlistedTicketChannel(
        channel,
        this.config.DISCORD_GUILD_ID,
        new Set(this.config.TICKET_TOOL_DISCORD_CATEGORY_IDS),
      )
    )
      return;
    await inTransaction(this.pool, async (db) => {
      await db.query(
        `INSERT INTO discord_ticket_channels(guild_id,channel_id,discord_category_id,source)
        VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [channel.guild_id, channel.id, channel.parent_id, source],
      );
      const created = await db.query(
        `INSERT INTO discord_ticket_welcome_jobs(guild_id,channel_id,nonce)
        VALUES($1,$2,$3) ON CONFLICT(guild_id,channel_id) DO NOTHING`,
        [channel.guild_id, channel.id, randomBytes(12).toString("hex")],
      );
      if (created.rowCount)
        await discordAudit(db, "VIP_TICKET_OBSERVED", null, {
          channelId: channel.id,
          categoryId: channel.parent_id,
          source,
        });
    });
  }
  public async reconcileBatch(): Promise<void> {
    if (!this.config.TICKET_TOOL_CHANNEL_OBSERVATION_ENABLED) return;
    // Guild channels are returned as one bounded Discord list, not a paginated message inventory.
    const key = `tickets:${this.config.DISCORD_GUILD_ID}`;
    const claim = await this.pool.query(
      `INSERT INTO discord_runtime(name,next_scan_at) VALUES($1,now()+interval '5 minutes')
      ON CONFLICT(name) DO UPDATE SET next_scan_at=now()+interval '5 minutes'
      WHERE discord_runtime.next_scan_at<=now() RETURNING name`,
      [key],
    );
    if (!claim.rowCount) return;
    try {
      const channels = z
        .array(channelSchema)
        .max(500)
        .parse(
          await this.rest.request(
            `/api/v10/guilds/${this.config.DISCORD_GUILD_ID}/channels`,
          ),
        );
      for (const channel of channels)
        if (channel.type === 0)
          await this.observe({ ...channel, type: 0 }, "reconcile");
    } catch (error) {
      await this.pool.query(
        "UPDATE discord_runtime SET next_scan_at=now()+interval '30 seconds' WHERE name=$1",
        [key],
      );
      throw error;
    }
  }
  public async runOne(): Promise<boolean> {
    if (!this.config.TICKET_TOOL_WELCOME_WRITES_ENABLED) return false;
    await this.pool.query(
      `UPDATE discord_ticket_welcome_jobs SET status='blocked',last_error_code='LEASE_EXPIRED_MAX_ATTEMPTS',
      lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE guild_id=$1 AND status='processing'
      AND lease_expires_at<now() AND attempt_count>=$2`,
      [this.config.DISCORD_GUILD_ID, this.config.DISCORD_MAX_ATTEMPTS],
    );
    const job = (
      await this.pool.query<Job>(
        `WITH candidate AS (
      SELECT guild_id,channel_id FROM discord_ticket_welcome_jobs WHERE guild_id=$1 AND
      channel_id::numeric >= $4::numeric AND
      ((status IN ('queued','retry') AND available_at<=now()) OR (status='processing' AND lease_expires_at<now()))
      AND attempt_count<$3 ORDER BY available_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      UPDATE discord_ticket_welcome_jobs j SET status='processing',lease_token=$2,lease_expires_at=now()+interval '120 seconds',
      attempt_count=attempt_count+1,updated_at=now() FROM candidate c
      WHERE j.guild_id=c.guild_id AND j.channel_id=c.channel_id RETURNING j.*`,
        [
          this.config.DISCORD_GUILD_ID,
          randomUUID(),
          this.config.DISCORD_MAX_ATTEMPTS,
          (
            (BigInt(Date.parse(this.config.TICKET_TOOL_WELCOME_NOT_BEFORE!)) -
              1420070400000n) <<
            22n
          ).toString(),
        ],
      )
    ).rows[0];
    if (!job) return false;
    const db = await this.pool.connect();
    const lock = `vip-ticket:${job.guild_id}:${job.channel_id}`;
    let locked = false;
    let attemptedThisRun = false;
    try {
      locked = Boolean(
        (
          await db.query<{ ok: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok",
            [lock],
          )
        ).rows[0]?.ok,
      );
      if (!locked) return true;
      const valid = await db.query(
        "SELECT 1 FROM discord_ticket_welcome_jobs WHERE guild_id=$1 AND channel_id=$2 AND lease_token=$3",
        [job.guild_id, job.channel_id, job.lease_token],
      );
      if (!valid.rowCount) return true;
      await this.rest.inspect(job.channel_id);
      let messageId: string;
      if (job.send_started_at) {
        const recovered = await this.rest.findPanel(job.channel_id, job.nonce);
        // Discord nonce deduplication expires; never blindly resend an ambiguous old POST.
        if (!recovered) throw new DiscordFailure("TICKET_SEND_REVIEW_REQUIRED");
        messageId = recovered;
      } else {
        await discordAudit(this.pool, "VIP_TICKET_MESSAGE_INTENT", null, {
          channelId: job.channel_id,
          nonce: job.nonce,
          approval: this.config.TICKET_TOOL_WELCOME_APPROVAL_REFERENCE,
        });
        const intent = await this.pool.query(
          `UPDATE discord_ticket_welcome_jobs SET send_started_at=now()
          WHERE guild_id=$1 AND channel_id=$2 AND lease_token=$3 RETURNING channel_id`,
          [job.guild_id, job.channel_id, job.lease_token],
        );
        if (!intent.rowCount) return true;
        attemptedThisRun = true;
        messageId = await this.rest.publish(job.channel_id, job.nonce);
      }
      await inTransaction(this.pool, async (tx) => {
        const saved = await tx.query(
          `UPDATE discord_ticket_welcome_jobs SET status='sent',message_id=$4,lease_token=NULL,
          lease_expires_at=NULL,last_error_code=NULL,updated_at=now() WHERE guild_id=$1 AND channel_id=$2 AND lease_token=$3 RETURNING channel_id`,
          [job.guild_id, job.channel_id, job.lease_token, messageId],
        );
        if (saved.rowCount)
          await discordAudit(tx, "VIP_TICKET_MESSAGE_CONFIRMED", null, {
            channelId: job.channel_id,
            messageId,
          });
      });
    } catch (error) {
      const failure =
        error instanceof DiscordFailure
          ? error
          : new DiscordFailure("TICKET_PROCESSING_FAILED", true);
      const retry =
        failure.retryable &&
        job.attempt_count < this.config.DISCORD_MAX_ATTEMPTS;
      // A 429/403 response proves that Discord rejected the request, unlike a timeout.
      await this.pool.query(
        `UPDATE discord_ticket_welcome_jobs SET status=$4,last_error_code=$5,lease_token=NULL,lease_expires_at=NULL,
        send_started_at=CASE WHEN $7 THEN NULL ELSE send_started_at END,available_at=now()+$6*interval '1 millisecond',updated_at=now()
        WHERE guild_id=$1 AND channel_id=$2 AND lease_token=$3`,
        [
          job.guild_id,
          job.channel_id,
          job.lease_token,
          retry ? "retry" : "blocked",
          failure.code,
          Math.max(
            failure.retryAfterMs,
            1000 * 2 ** Math.min(job.attempt_count, 8),
          ),
          attemptedThisRun &&
            [
              "DISCORD_RATE_LIMITED",
              "DISCORD_PERMISSION_DENIED",
              "DISCORD_INVALID_REQUEST",
            ].includes(failure.code),
        ],
      );
      await discordAudit(this.pool, "VIP_TICKET_MESSAGE_FAILED", null, {
        channelId: job.channel_id,
        code: failure.code,
      });
    } finally {
      if (locked)
        await db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
          lock,
        ]);
      db.release();
    }
    return true;
  }
  public async select(input: {
    interactionId: string;
    guildId: string;
    channelId: string;
    memberId: string;
    messageId: string;
    customId: string;
  }) {
    if (!this.config.TICKET_TOOL_SELECTIONS_ENABLED)
      throw new DiscordFailure("TICKET_SELECTIONS_NOT_ENABLED");
    if (input.guildId !== this.config.DISCORD_GUILD_ID)
      throw new DiscordFailure("GUILD_IDENTITY_MISMATCH");
    [
      input.interactionId,
      input.channelId,
      input.memberId,
      input.messageId,
    ].forEach((id) => snowflake.parse(id));
    const product =
      input.customId === "tc:vip:monthly:v1"
        ? "VIP_MONTHLY_AUTO"
        : input.customId === "tc:vip:lifetime:v1"
          ? "VIP_LIFETIME"
          : null;
    if (!product) throw new DiscordFailure("TICKET_PRODUCT_INVALID");
    await this.authorizeBuyer(input);
    await inTransaction(this.pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `ticket-buyer:${input.memberId}`,
      ]);
      const duplicate = await db.query(
        "SELECT 1 FROM discord_ticket_selections WHERE interaction_id=$1",
        [input.interactionId],
      );
      if (duplicate.rowCount) return;
      const recent = await db.query(
        "SELECT 1 FROM discord_ticket_selections WHERE discord_user_id=$1 AND created_at>now()-interval '5 seconds'",
        [input.memberId],
      );
      if (recent.rowCount)
        throw new DiscordFailure("TICKET_SELECTION_RATE_LIMITED");
      await db.query(
        `INSERT INTO discord_ticket_selections(interaction_id,guild_id,channel_id,discord_user_id,product_code) VALUES($1,$2,$3,$4,$5)`,
        [input.interactionId,input.guildId,input.channelId,input.memberId,product],
      );
      await discordAudit(db, "VIP_TICKET_PRODUCT_SELECTED", null, {
        channelId: input.channelId, discordUserId: input.memberId, product,
        interactionId: input.interactionId,
      });
    });
    return {
      type: 4,
      data: {
        flags: 64,
        allowed_mentions: { parse: [] },
        content: `${product === "VIP_MONTHLY_AUTO" ? "VIP Monthly — EUR 40/month, auto-renewal." : "VIP Lifetime — EUR 100, one-time payment."} Selection recorded. Payments are not enabled. No charge or VIP role has been created.`,
      },
    };
  }
  /** Fresh ticket and member proof shared by selection, confirmation and principal-owned Portal. */
  public async authorizeBuyer(input: {
    guildId: string; channelId: string; memberId: string; messageId: string;
  }, requirePanel = true): Promise<void> {
    if (!this.config.TICKET_TOOL_SELECTIONS_ENABLED || input.guildId !== this.config.DISCORD_GUILD_ID)
      throw new DiscordFailure("TICKET_SELECTIONS_NOT_ENABLED");
    [input.channelId, input.memberId, input.messageId].forEach(id => snowflake.parse(id));
    const job = (
      await this.pool.query<{ message_id: string }>(
        "SELECT message_id FROM discord_ticket_welcome_jobs WHERE guild_id=$1 AND channel_id=$2 AND status='sent'",
        [input.guildId, input.channelId],
      )
    ).rows[0];
    if (!job || (requirePanel && job.message_id !== input.messageId))
      throw new DiscordFailure("TICKET_PANEL_IDENTITY_MISMATCH");
    const { channel, roles } = await this.rest.inspect(input.channelId);
    const member = await this.rest.member(input.memberId);
    if (
      member.user.bot ||
      member.user.id === this.config.DISCORD_CLIENT_ID ||
      member.pending !== false ||
      !(channelPermissions(channel, roles, member) & VIEW)
    )
      throw new DiscordFailure("TICKET_BUYER_NOT_ELIGIBLE");
  }
}
