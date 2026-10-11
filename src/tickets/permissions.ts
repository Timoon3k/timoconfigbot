import { z } from "zod";
import { snowflake, type DiscordConfig } from "../discord/config.js";
import { DiscordFailure } from "../discord/types.js";

export const VIEW = 1n << 10n;
export const SEND = 1n << 11n;
export const EMBED = 1n << 14n;
export const HISTORY = 1n << 16n;
export const MANAGE_ROLES = 1n << 28n;
export const REQUIRED = VIEW | SEND | EMBED | HISTORY;
export const permissionNames = [
  [VIEW, "View Channel"],
  [SEND, "Send Messages"],
  [EMBED, "Embed Links"],
  [HISTORY, "Read Message History"],
] as const;
const bits = z.string().regex(/^\d{1,24}$/);
export const overwriteSchema = z.object({
  id: snowflake,
  type: z.union([z.literal(0), z.literal(1)]),
  allow: bits,
  deny: bits,
});
export const channelSchema = z.object({
  id: snowflake,
  guild_id: snowflake,
  parent_id: snowflake.nullable(),
  type: z.number().int(),
  name: z.string().optional(),
  permission_overwrites: z.array(overwriteSchema),
});
export const roleSchema = z.object({
  id: snowflake,
  name: z.string(),
  position: z.number().int(),
  permissions: bits,
  managed: z.boolean(),
});
export const memberSchema = z.object({
  user: z.object({ id: snowflake, bot: z.boolean().optional() }),
  roles: z.array(snowflake),
  pending: z.boolean().optional(),
});
export type Channel = z.infer<typeof channelSchema>;
export type Role = z.infer<typeof roleSchema>;
export type GuildMember = z.infer<typeof memberSchema>;

export function guildPermissions(
  guildId: string,
  roles: Role[],
  member: GuildMember,
): bigint {
  return roles
    .filter((r) => r.id === guildId || member.roles.includes(r.id))
    .reduce((p, r) => p | BigInt(r.permissions), 0n);
}
/** Discord order: everyone overwrite, aggregate role overwrites, member overwrite. */
export function channelPermissions(
  channel: Channel,
  roles: Role[],
  member: GuildMember,
): bigint {
  let p = guildPermissions(channel.guild_id, roles, member);
  if (p & 8n) return (1n << 64n) - 1n;
  const everyone = channel.permission_overwrites.find(
    (o) => o.type === 0 && o.id === channel.guild_id,
  );
  if (everyone) p = (p & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  const roleOverwrites = channel.permission_overwrites.filter(
    (o) => o.type === 0 && member.roles.includes(o.id),
  );
  const denied = roleOverwrites.reduce((v, o) => v | BigInt(o.deny), 0n);
  const allowed = roleOverwrites.reduce((v, o) => v | BigInt(o.allow), 0n);
  p = (p & ~denied) | allowed;
  const own = channel.permission_overwrites.find(
    (o) => o.type === 1 && o.id === member.user.id,
  );
  if (own) p = (p & ~BigInt(own.deny)) | BigInt(own.allow);
  // Without visibility, other text permissions cannot be used.
  if (!(p & VIEW)) p &= ~REQUIRED;
  if (!(p & SEND)) p &= ~EMBED;
  return p;
}
export function missingPermissions(p: bigint): string[] {
  return permissionNames.filter(([bit]) => !(p & bit)).map(([, name]) => name);
}

/** Fail closed: customer roles may not expose every ticket. Individual ticket members remain allowed. */
export function assertPrivateTicket(
  config: DiscordConfig,
  channel: Channel,
  roles: Role[],
  bot: GuildMember,
  ticketTool: GuildMember,
): void {
  if (
    channel.guild_id !== config.DISCORD_GUILD_ID ||
    channel.type !== 0 ||
    channel.parent_id === config.TICKET_TOOL_SUPPORT_DISCORD_CATEGORY_ID ||
    !channel.parent_id ||
    !config.TICKET_TOOL_DISCORD_CATEGORY_IDS.includes(channel.parent_id)
  )
    throw new DiscordFailure("VIP_TICKET_SCOPE_INVALID");
  const everyone = channel.permission_overwrites.find(
    (o) => o.type === 0 && o.id === channel.guild_id,
  );
  if (
    !everyone ||
    !(BigInt(everyone.deny) & VIEW) ||
    BigInt(everyone.allow) & VIEW
  )
    throw new DiscordFailure("VIP_TICKET_NOT_PRIVATE");
  const staff = [config.DISCORD_STAFF_ROLE_ID, config.DISCORD_FOUNDER_ROLE_ID];
  const permittedRoles = new Set([...staff, ...bot.roles, ...ticketTool.roles]);
  const customers = [
    config.DISCORD_FREE_MEMBER_ROLE_ID,
    config.DISCORD_VIP_MONTHLY_ROLE_ID,
    config.DISCORD_VIP_LIFETIME_ROLE_ID,
  ];
  for (const id of customers) {
    const member = { user: { id: "role-only-probe" }, roles: [id] };
    if (channelPermissions(channel, roles, member) & VIEW)
      throw new DiscordFailure("VIP_TICKET_CUSTOMER_ROLE_VISIBLE");
  }
  if (
    channel.permission_overwrites.some(
      (o) =>
        o.type === 0 && BigInt(o.allow) & VIEW && !permittedRoles.has(o.id),
    )
  )
    throw new DiscordFailure("VIP_TICKET_UNREVIEWED_ROLE_VISIBLE");
  // Multiple unrelated individual customer grants require human review.
  const customersWithView = channel.permission_overwrites.filter(
    (o) =>
      o.type === 1 &&
      BigInt(o.allow) & VIEW &&
      ![bot.user.id, ticketTool.user.id].includes(o.id),
  );
  if (customersWithView.length > 1)
    throw new DiscordFailure("VIP_TICKET_MULTIPLE_MEMBERS_REVIEW_REQUIRED");
}

export function botOverwriteCorrection(
  config: DiscordConfig,
  channel: Channel,
  roles: Role[],
  bot: GuildMember,
) {
  if (
    channel.guild_id !== config.DISCORD_GUILD_ID ||
    !(
      (channel.id === config.TICKET_TOOL_DISCORD_CATEGORY_IDS[0] &&
        channel.type === 4) ||
      (channel.type === 0 &&
        channel.parent_id === config.TICKET_TOOL_DISCORD_CATEGORY_IDS[0])
    ) ||
    channel.id === config.TICKET_TOOL_SUPPORT_DISCORD_CATEGORY_ID
  )
    throw new DiscordFailure("PERMISSION_REPAIR_SCOPE_INVALID");
  const before =
    channel.permission_overwrites.find(
      (o) => o.type === 1 && o.id === bot.user.id,
    ) ?? null;
  const after = {
    id: bot.user.id,
    type: 1 as const,
    allow: ((before ? BigInt(before.allow) : 0n) | REQUIRED).toString(),
    deny: ((before ? BigInt(before.deny) : 0n) & ~REQUIRED).toString(),
  };
  const missing = missingPermissions(channelPermissions(channel, roles, bot));
  const base = guildPermissions(channel.guild_id, roles, bot);
  const effective = channelPermissions(channel, roles, bot);
  const canApply =
    bot.user.id === config.DISCORD_CLIENT_ID &&
    !(base & 8n) &&
    (base & REQUIRED) === REQUIRED &&
    Boolean(effective & MANAGE_ROLES);
  return {
    channelId: channel.id,
    before,
    after,
    missing,
    canApply,
    needsChange: missing.length > 0,
  };
}
