import type { DiscordConfig } from "./config.js";
import { assertTestGuildNetwork } from "./rest.js";
import { DiscordFailure } from "./types.js";

/**
 * Registration of guild-scoped, read-only application commands is NOT role
 * mutation and must never reuse the Free Member or VIP write approvals.
 */
export function assertProductionReadOnlyCommandRegistration(config: DiscordConfig): void {
  assertTestGuildNetwork(config);
  if (
    config.DISCORD_ENVIRONMENT !== "production" ||
    !config.DISCORD_READONLY_COMMANDS_ENABLED ||
    !config.DISCORD_READONLY_COMMAND_REGISTRATION_APPROVED ||
    !config.DISCORD_READONLY_COMMAND_APPROVAL_REFERENCE ||
    config.DISCORD_COMMANDS_ENABLED ||
    config.DISCORD_VIP_SYNC_ENABLED ||
    config.DISCORD_PRODUCTION_VIP_WRITES_ENABLED ||
    !config.DISCORD_INTERACTIONS_PUBLIC_KEY ||
    [
      config.DISCORD_APPROVAL_REFERENCE,
      config.DISCORD_FREE_MEMBER_APPROVAL_REFERENCE,
      config.DISCORD_FREE_MEMBER_ALL_APPROVAL_REFERENCE,
    ].includes(config.DISCORD_READONLY_COMMAND_APPROVAL_REFERENCE)
  )
    throw new DiscordFailure("COMMAND_REGISTRATION_NOT_APPROVED");
}
