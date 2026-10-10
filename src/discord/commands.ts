import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import type { DatabasePool } from "../db/pool.js";
import type { MembershipService } from "../membership/service.js";
import { snowflake, type DiscordConfig } from "./config.js";
import { DiscordFailure } from "./types.js";

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
  ) {}
  public async handle(guildId: string, discordId: string, command: string) {
    if (guildId !== this.config.DISCORD_GUILD_ID)
      throw new DiscordFailure("GUILD_IDENTITY_MISMATCH");
    snowflake.parse(discordId);
    let content: string;
    if (command === "help")
      content = `Connect your account through the authenticated TimonConfigs Discord account settings. For help, visit ${this.config.DISCORD_SUPPORT_URL} and open an existing support ticket. Commands cannot grant roles.`;
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
        content = `Account linked. Latest synchronization job: ${job?.status ?? "not requested"}. ${this.config.DISCORD_DRY_RUN ? "Dry-run mode; changes are previews." : "Controlled test guild mode."}`;
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
      guild_id: snowflake.optional(),
      member: z.object({ user: z.object({ id: snowflake }) }).optional(),
      data: z.object({ name: z.string() }).optional(),
    })
    .parse(JSON.parse(raw.toString("utf8")));
  if (interaction.application_id !== applicationId)
    throw new DiscordFailure("APPLICATION_IDENTITY_MISMATCH");
  if (interaction.type === 1) return { type: 1 };
  if (
    interaction.type !== 2 ||
    !interaction.guild_id ||
    !interaction.member ||
    !interaction.data
  )
    throw new DiscordFailure("INTERACTION_INVALID");
  return commands.handle(
    interaction.guild_id,
    interaction.member.user.id,
    interaction.data.name,
  );
}
