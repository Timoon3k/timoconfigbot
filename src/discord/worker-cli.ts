import { AuthService } from "../auth/service.js";
import { loadConfig } from "../config.js";
import { createPool } from "../db/pool.js";
import { MembershipService } from "../membership/service.js";
import { createDiscordRuntime } from "./runtime.js";
import { DiscordWorker } from "./worker.js";

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const auth = new AuthService(
  pool,
  config.PASSWORD_PEPPER,
  config.SESSION_PEPPER,
);
const { sync, verification, gateway, tickets, billingWorker } = createDiscordRuntime(
  pool,
  auth,
  new MembershipService(pool,config.NODE_ENV !== "production"),
  config.SESSION_PEPPER,
);
const worker = new DiscordWorker(sync, verification, tickets, billingWorker);
const stop = () => {
  worker.stop();
  gateway?.stop();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const gatewayLease = gateway ? await pool.connect() : null;
let tasks: Array<Promise<void>> = [];
try {
  const leader = gatewayLease
    ? (
        await gatewayLease.query<{ leader: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS leader",
          [`discord-gateway:${sync.config.DISCORD_GUILD_ID}`],
        )
      ).rows[0]?.leader
    : false;
  tasks = [worker.run()];
  if (leader && gateway)
    tasks.push(
      gateway.run().catch((error) => {
        stop();
        throw error;
      }),
    );
  await Promise.all(tasks);
} finally {
  stop();
  await Promise.allSettled(tasks);
  if (gatewayLease) {
    await gatewayLease.query(
      "SELECT pg_advisory_unlock(hashtextextended($1,0))",
      [`discord-gateway:${sync.config.DISCORD_GUILD_ID}`],
    );
    gatewayLease.release();
  }
  await pool.end();
}
