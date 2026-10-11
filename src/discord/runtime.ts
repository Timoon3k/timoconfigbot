import type { AuthService } from "../auth/service.js";
import type { DatabasePool } from "../db/pool.js";
import type { MembershipService } from "../membership/service.js";
import {
  DatabaseMockDiscordAdapter,
  DryRunDiscordAdapter,
} from "./adapters.js";
import { loadDiscordConfig } from "./config.js";
import { DiscordLinkService } from "./oauth.js";
import {
  ApprovedDiscordHttpsTransport,
  PostgresDiscordRateGate,
} from "./transport.js";
import { RestDiscordAdapter } from "./rest.js";
import { MemberVerification } from "./verification.js";
import { DiscordMemberGateway, checkGatewaySessionBudget } from "./gateway.js";
import { DiscordFailure } from "./types.js";
import type { TicketChannel } from "../tickets/ticket-tool-bridge.js";
import { MockOAuthProvider, RestOAuthProvider } from "./oauth-provider.js";
import { DiscordSyncService } from "./sync.js";

export function createDiscordRuntime(
  pool: DatabasePool,
  auth: AuthService,
  memberships: MembershipService,
  secret: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const config = loadDiscordConfig(env);
  const transport = new ApprovedDiscordHttpsTransport(
    config,
    new PostgresDiscordRateGate(
      pool,
      `rate:${config.DISCORD_GUILD_ID}`,
      config.DISCORD_MIN_REQUEST_MS,
    ),
  );
  if (
    config.DISCORD_ENVIRONMENT !== "offline" &&
    (!env.DISCORD_BOT_TOKEN || !env.DISCORD_CLIENT_SECRET)
  )
    throw new DiscordFailure("TEST_GUILD_CREDENTIALS_MISSING");
  const reader =
    config.DISCORD_ADAPTER === "mock"
      ? new DatabaseMockDiscordAdapter(pool, config)
      : new RestDiscordAdapter(config, env.DISCORD_BOT_TOKEN!, transport);
  const adapter = config.DISCORD_DRY_RUN
    ? new DryRunDiscordAdapter(reader)
    : reader;
  const sync = new DiscordSyncService(pool, config, memberships, adapter);
  const links = new DiscordLinkService(
    pool,
    auth,
    config.DISCORD_ADAPTER === "mock"
      ? new MockOAuthProvider(config.DISCORD_OAUTH_REDIRECT_URI)
      : new RestOAuthProvider(config, env.DISCORD_CLIENT_SECRET!, transport),
    secret,
  );
  const verification = new MemberVerification(pool, config, adapter, sync);
  const onTicketChannelCreated = config.TICKET_TOOL_CHANNEL_OBSERVATION_ENABLED
    ? async (channel: TicketChannel): Promise<void> => {
        // Persist a candidate ticket channel only. No inferred buyer, payment or role.
        await pool.query(
          `INSERT INTO discord_ticket_channels
             (guild_id,channel_id,discord_category_id,source)
           VALUES ($1,$2,$3,'gateway')
           ON CONFLICT (guild_id,channel_id) DO NOTHING`,
          [channel.guild_id, channel.id, channel.parent_id],
        );
      }
    : undefined;
  const gateway = config.DISCORD_GATEWAY_ENABLED
    ? new DiscordMemberGateway(
        config,
        env.DISCORD_BOT_TOKEN!,
        verification,
        undefined,
        () => checkGatewaySessionBudget(transport, env.DISCORD_BOT_TOKEN!),
        undefined,
        onTicketChannelCreated,
      )
    : null;
  return { sync, links, verification, gateway };
}
