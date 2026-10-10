import { loadDiscordConfig } from "./config.js";
import { slashCommands } from "./commands.js";
import { createPool } from "../db/pool.js";
import { assertTestGuildWrites, discordResponse } from "./rest.js";
import {
  ApprovedDiscordHttpsTransport,
  PostgresDiscordRateGate,
} from "./transport.js";
import { discordAudit } from "./audit.js";
import { DiscordFailure } from "./types.js";

const config = loadDiscordConfig();
if (config.DISCORD_DRY_RUN) {
  process.stdout.write(
    JSON.stringify(
      {
        dryRun: true,
        guildId: config.DISCORD_GUILD_ID,
        commands: slashCommands,
      },
      null,
      2,
    ) + "\n",
  );
} else {
  assertTestGuildWrites(config);
  if (
    !config.DISCORD_COMMANDS_ENABLED ||
    !process.env.DATABASE_URL ||
    !process.env.DISCORD_BOT_TOKEN
  )
    throw new DiscordFailure("COMMAND_REGISTRATION_NOT_APPROVED");
  const pool = createPool(process.env.DATABASE_URL);
  try {
    const transport = new ApprovedDiscordHttpsTransport(
      config,
      new PostgresDiscordRateGate(
        pool,
        `rate:${config.DISCORD_GUILD_ID}`,
        config.DISCORD_MIN_REQUEST_MS,
      ),
    );
    await discordAudit(pool, "DISCORD_COMMAND_REGISTRATION_INTENT", null, {
      guildId: config.DISCORD_GUILD_ID,
      names: slashCommands.map((c) => c.name),
      approval: config.DISCORD_APPROVAL_REFERENCE,
    });
    const response = await transport.request(
      `/api/v10/applications/${config.DISCORD_CLIENT_ID}/guilds/${config.DISCORD_GUILD_ID}/commands`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(slashCommands),
      },
    );
    await discordResponse(response);
    await discordAudit(pool, "DISCORD_COMMAND_REGISTRATION_CONFIRMED", null, {
      guildId: config.DISCORD_GUILD_ID,
    });
    process.stdout.write("Test guild commands registered.\n");
  } finally {
    await pool.end();
  }
}
