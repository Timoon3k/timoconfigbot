import type { DiscordConfig } from "./config.js";
import { snowflake } from "./config.js";
import type { EntitlementTier } from "../domain/products.js";
import { DiscordFailure, type GuildState } from "./types.js";

export function managedRoles(config: DiscordConfig): string[] {
  return [
    config.DISCORD_VIP_MONTHLY_ROLE_ID,
    config.DISCORD_VIP_LIFETIME_ROLE_ID,
  ];
}
export function assertRole(config: DiscordConfig, roleId: string): void {
  if (
    ![
      ...managedRoles(config),
      ...(config.DISCORD_VERIFICATION_ENABLED
        ? [config.DISCORD_FREE_MEMBER_ROLE_ID]
        : []),
    ].includes(roleId)
  )
    throw new DiscordFailure("ROLE_NOT_ALLOWLISTED");
}
export function verifyGuild(config: DiscordConfig, guild: GuildState): void {
  if (
    guild.id !== config.DISCORD_GUILD_ID ||
    guild.bot.id !== config.DISCORD_CLIENT_ID ||
    (config.DISCORD_ENVIRONMENT === "test-guild" &&
      guild.ownerId !== config.DISCORD_GUILD_OWNER_ID)
  )
    throw new DiscordFailure("GUILD_IDENTITY_MISMATCH");
  const everyone = guild.roles.find((role) => role.id === guild.id);
  const botRoles = guild.roles.filter((role) =>
    guild.bot.roles.includes(role.id),
  );
  if (!everyone || !botRoles.length)
    throw new DiscordFailure("BOT_ROLE_MISSING");
  const permissions = botRoles.reduce(
    (bits, role) => bits | BigInt(role.permissions),
    BigInt(everyone.permissions),
  );
  if ((permissions & 8n) !== 0n || guild.ownerId === guild.bot.id)
    throw new DiscordFailure("ADMINISTRATOR_NOT_ALLOWED");
  if ((permissions & 268435456n) === 0n)
    throw new DiscordFailure("MANAGE_ROLES_MISSING");
  const highest = Math.max(...botRoles.map((role) => role.position));
  for (const id of [
    config.DISCORD_FOUNDER_ROLE_ID,
    config.DISCORD_STAFF_ROLE_ID,
  ]) {
    const role = guild.roles.find((item) => item.id === id);
    if (!role || role.position <= highest)
      throw new DiscordFailure("PROTECTED_HIERARCHY_INVALID");
  }
  for (const id of [
    ...managedRoles(config),
    ...(config.DISCORD_VERIFICATION_ENABLED
      ? [config.DISCORD_FREE_MEMBER_ROLE_ID]
      : []),
  ]) {
    const role = guild.roles.find((item) => item.id === id);
    if (!role || role.managed || role.id === guild.id)
      throw new DiscordFailure("MANAGED_ROLE_INVALID");
    if (role.position >= highest)
      throw new DiscordFailure("VIP_HIERARCHY_INVALID");
    if (
      id !== config.DISCORD_FREE_MEMBER_ROLE_ID &&
      role.name.toLowerCase() === "free member"
    )
      throw new DiscordFailure("PROTECTED_ROLE_CONFIGURED_AS_VIP");
    // Names are only an additional misconfiguration guard; authorization uses IDs.
    if (
      ["founder", "staff", "bot integrations", "dyno", "ticket tool"].includes(
        role.name.toLowerCase(),
      )
    ) {
      throw new DiscordFailure("PROTECTED_ROLE_CONFIGURED_AS_VIP");
    }
    if ((BigInt(role.permissions) & (8n | 268435456n)) !== 0n)
      throw new DiscordFailure("VIP_ROLE_PRIVILEGED");
  }
}
export function roleDiff(
  config: DiscordConfig,
  current: string[],
  tier: EntitlementTier,
) {
  current.forEach((id) => snowflake.parse(id));
  const desired =
    tier === "FREE"
      ? []
      : [
          tier === "VIP_LIFETIME"
            ? config.DISCORD_VIP_LIFETIME_ROLE_ID
            : config.DISCORD_VIP_MONTHLY_ROLE_ID,
        ];
  return {
    desired,
    add: desired.filter((id) => !current.includes(id)),
    remove: managedRoles(config).filter(
      (id) => current.includes(id) && !desired.includes(id),
    ),
  };
}
