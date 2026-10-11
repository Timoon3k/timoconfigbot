import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import type { DatabasePool } from "../db/pool.js";
import type { MembershipService } from "../membership/service.js";
import { snowflake, type DiscordConfig } from "./config.js";
import { DiscordFailure } from "./types.js";
import type { TicketService } from "../tickets/service.js";
import type { BillingInteractions } from "../billing/interactions.js";

export const slashCommands = [
  {
    name: "membership",
    description: "Show your current membership.",
    type: 1,
    dm_permission: false,
  },
  {
    name: "sync-status",
    description: "Show your account link and synchronization status.",
    type: 1,
    dm_permission: false,
  },
  {
    name: "help",
    description: "Learn about membership account linking.",
    type: 1,
    dm_permission: false,
  },
] as const;

/** Pure handler called only after signature verification or by trusted tests. No registration side effects. */
export class DiscordCommands {
  public constructor(
    private readonly pool: DatabasePool,
    private readonly memberships: MembershipService,
    private readonly config: DiscordConfig,
    private readonly tickets?: TicketService,
    private readonly billing?: BillingInteractions,
  ) {}
  public async handleBilling(input: Parameters<BillingInteractions["enqueue"]>[0]) {
    if (!this.billing?.enabled()) throw new DiscordFailure("BILLING_NOT_ENABLED");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.billing.enqueue(input), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DiscordFailure("BILLING_QUEUE_UNAVAILABLE")), 1800);
      })]);
      return { type: 5, data: { flags: 64 } };
    } finally { clearTimeout(timer); }
  }
  public billingEnabled(): boolean { return this.billing?.enabled() ?? false; }
  public async handleTicket(input: Parameters<TicketService["select"]>[0]) {
    if (!this.tickets) throw new DiscordFailure("TICKET_SELECTIONS_NOT_ENABLED");
    // Initial ephemeral reply stays below Discord's three-second deadline even if REST stalls.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.tickets.select(input),
        new Promise<{ type: number; data: { flags: number; content: string } }>(resolve => {
          timer = setTimeout(() => resolve({ type: 4, data: { flags: 64,
            content: "Verification is taking longer than expected. Please try again. Payments are disabled; no charge or VIP access has been created." } }), 1800);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }
  public async handle(guildId: string, discordId: string, command: string) {
    if (guildId !== this.config.DISCORD_GUILD_ID)
      throw new DiscordFailure("GUILD_IDENTITY_MISMATCH");
    snowflake.parse(discordId);
    if (this.billing?.billing.config.STRIPE_WEBHOOKS_ENABLED && ["membership", "sync-status"].includes(command)) {
      const service = this.billing.billing;
      const principal = (await this.pool.query<{ id: string }>(`SELECT id FROM discord_billing_principals
        WHERE guild_id=$1 AND discord_user_id=$2 AND stripe_account_id=$3 AND mode=$4`,
        [guildId, discordId, service.config.STRIPE_ACCOUNT_ID!, service.config.STRIPE_MODE])).rows[0];
      if (principal) {
        const tier = await service.tier(this.pool, principal.id);
        const status = (await this.pool.query<{ outcome: string }>("SELECT outcome FROM stripe_vip_sync_state WHERE principal_id=$1", [principal.id])).rows[0];
        return { type: 4, data: { flags: 64, allowed_mentions: { parse: [] },
          content: `Verified Discord membership: ${tier}. VIP role synchronization: ${status?.outcome ?? "pending"}. ${service.config.STRIPE_MODE === "test" ? "Stripe TEST mode. " : ""}Use Manage Billing / Status in your private VIP ticket to manage renewals. Lifetime license terms apply.` } };
      }
    }
    let content: string;
    if (command === "help")
      content = this.billing?.enabled() ? "Open a VIP ticket using the existing Ticket Tool panel. Select Monthly or Lifetime, review the terms, and confirm to open private Stripe Checkout. No website account is required. Manage Billing / Status opens cancellation and payment status. Commands cannot grant roles." :
        `Connect your account through the authenticated TimonConfigs Discord account settings. For help, visit ${this.config.DISCORD_SUPPORT_URL} and open an existing support ticket. Commands cannot grant roles.`;
    else {
      const account = (
        await this.pool.query<{ user_id: string }>(
          `SELECT a.user_id FROM discord_accounts a JOIN app_users u ON u.id=a.user_id
        WHERE a.discord_user_id=$1 AND a.unlinked_at IS NULL AND u.disabled_at IS NULL`,
          [discordId],
        )
      ).rows[0];
      if (!account)
        content =
          "Your Discord account is not linked to an active TimonConfigs account.";
      else if (command === "membership") {
        const tier = await this.memberships.activeTier(account.user_id);
        const period = (
          await this.pool.query<{ expires: Date | null }>(
            `SELECT CASE WHEN bool_or(valid_until IS NULL) THEN NULL ELSE max(valid_until) END AS expires
          FROM membership_entitlements WHERE user_id=$1 AND tier=$2 AND valid_from<=now()
          AND (valid_until IS NULL OR valid_until>now()) AND (revoked_at IS NULL OR revoked_at>now())`,
            [account.user_id, tier],
          )
        ).rows[0];
        content = `Membership: ${tier}. ${
          tier === "VIP_LIFETIME"
            ? "No fixed expiration date; Lifetime license terms apply."
            : period?.expires
              ? `Paid access until ${period.expires.toISOString()} (UTC).`
              : "No active paid period."
        }`;
      } else if (command === "sync-status") {
        const job = (
          await this.pool.query<{ status: string }>(
            "SELECT status FROM discord_sync_jobs WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
            [account.user_id],
          )
        ).rows[0];
        content = `Account linked. Latest synchronization job: ${job?.status ?? "not requested"}. ${this.config.DISCORD_DRY_RUN ? "Dry-run mode; changes are previews." : this.config.DISCORD_ENVIRONMENT === "production" ? "Production VIP synchronization is disabled." : "Controlled test guild mode."}`;
      } else content = "Unknown command. Use /help.";
    }
    return {
      type: 4,
      data: { content, flags: 64, allowed_mentions: { parse: [] } },
    };
  }
}

export async function verifiedInteraction(
  raw: Buffer,
  signature: string,
  timestamp: string,
  publicKeyHex: string,
  commands: DiscordCommands,
  applicationId: string,
  now = Date.now(),
) {
  if (
    !/^[a-f\d]{128}$/i.test(signature) ||
    !/^[a-f\d]{64}$/i.test(publicKeyHex) ||
    !/^\d{10,12}$/.test(timestamp) ||
    Math.abs(now - Number(timestamp) * 1000) > 300_000
  )
    throw new DiscordFailure("INTERACTION_SIGNATURE_INVALID");
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(publicKeyHex, "hex"),
    ]),
    format: "der",
    type: "spki",
  });
  if (
    !verify(
      null,
      Buffer.concat([Buffer.from(timestamp), raw]),
      key,
      Buffer.from(signature, "hex"),
    )
  )
    throw new DiscordFailure("INTERACTION_SIGNATURE_INVALID");
  const interaction = z
    .object({
      type: z.number().int(),
      application_id: snowflake,
      id: snowflake.optional(),
      token: z.string().max(2048).optional(),
      guild_id: snowflake.optional(),
      channel_id: snowflake.optional(),
      message: z.object({ id: snowflake, author: z.object({ id: snowflake }) }).optional(),
      member: z.object({ user: z.object({ id: snowflake }) }).optional(),
      data: z.object({ name: z.string().optional(), custom_id: z.string().max(100).optional() }).optional(),
    })
    .parse(JSON.parse(raw.toString("utf8")));
  if (interaction.application_id !== applicationId)
    throw new DiscordFailure("APPLICATION_IDENTITY_MISMATCH");
  if (interaction.type === 1) return { type: 1 };
  if (interaction.type === 3) {
    if (!interaction.id || !interaction.guild_id || !interaction.channel_id ||
        !interaction.member || !interaction.message || !interaction.data?.custom_id ||
        interaction.message.author.id !== applicationId)
      throw new DiscordFailure("TICKET_INTERACTION_INVALID");
    const input = { interactionId: interaction.id, guildId: interaction.guild_id,
      channelId: interaction.channel_id, memberId: interaction.member.user.id,
      messageId: interaction.message.id, customId: interaction.data.custom_id };
    if (commands.billingEnabled()) {
      if (!interaction.token) throw new DiscordFailure("BILLING_INTERACTION_TOKEN_MISSING");
      return commands.handleBilling({ ...input, token: interaction.token });
    }
    return commands.handleTicket(input);
  }
  if (
    interaction.type !== 2 ||
    !interaction.guild_id ||
    !interaction.member ||
    !interaction.data?.name
  )
    throw new DiscordFailure("INTERACTION_INVALID");
  return commands.handle(
    interaction.guild_id,
    interaction.member.user.id,
    interaction.data.name,
  );
}
