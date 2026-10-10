import { AuthService } from "./auth/service.js";
import { loadConfig } from "./config.js";
import { migrateUp } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { buildApp } from "./http/app.js";
import { MembershipService } from "./membership/service.js";
import { createDiscordRuntime } from "./discord/runtime.js";

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
await migrateUp(pool);

const auth = new AuthService(
  pool,
  config.PASSWORD_PEPPER,
  config.SESSION_PEPPER,
);
const memberships = new MembershipService(pool,config.NODE_ENV !== "production");
const discord = createDiscordRuntime(
  pool,
  auth,
  memberships,
  config.SESSION_PEPPER,
);
const app = buildApp({
  auth,
  memberships,
  production: config.NODE_ENV === "production",
  discord,
});

const shutdown = async (): Promise<void> => {
  await app.close();
  await pool.end();
};
process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

await app.listen({ host: config.HOST, port: config.PORT });
