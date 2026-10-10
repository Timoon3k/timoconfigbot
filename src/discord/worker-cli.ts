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
const { sync } = createDiscordRuntime(
  pool,
  auth,
  new MembershipService(pool),
  config.SESSION_PEPPER,
);
const worker = new DiscordWorker(sync);
process.once("SIGINT", () => worker.stop());
process.once("SIGTERM", () => worker.stop());
try {
  await worker.run();
} finally {
  await pool.end();
}
