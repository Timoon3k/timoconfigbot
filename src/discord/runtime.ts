import type { AuthService } from "../auth/service.js";
import type { DatabasePool } from "../db/pool.js";
import type { MembershipService } from "../membership/service.js";
import {
  DatabaseMockDiscordAdapter,
  DryRunDiscordAdapter,
} from "./adapters.js";
import { loadDiscordConfig } from "./config.js";
import { DiscordLinkService } from "./oauth.js";
import { MockOAuthProvider } from "./oauth-provider.js";
import { DiscordSyncService } from "./sync.js";

export function createDiscordRuntime(
  pool: DatabasePool,
  auth: AuthService,
  memberships: MembershipService,
  secret: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const config = loadDiscordConfig(env);
  if (env.NODE_ENV === "production")
    throw new Error(
      "Offline Discord mock cannot be deployed as production. A separately approved activation release is required.",
    );
  const adapter = new DryRunDiscordAdapter(
    new DatabaseMockDiscordAdapter(pool, config),
  );
  const sync = new DiscordSyncService(pool, config, memberships, adapter);
  const links = new DiscordLinkService(
    pool,
    auth,
    new MockOAuthProvider(config.DISCORD_OAUTH_REDIRECT_URI),
    secret,
  );
  return { sync, links };
}
