import { AuthService } from "./auth/service.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { buildApp } from "./http/app.js";
import { MembershipService } from "./membership/service.js";
import { createDiscordRuntime } from "./discord/runtime.js";
import { DiscordSupervisor } from "./discord/supervisor.js";
import { DiscordWorker } from "./discord/worker.js";

const config = loadConfig();
const mode = process.env.HOSTINGER_BACKGROUND_MODE ?? "continuous";
if (!["continuous", "cron"].includes(mode))
  throw new Error("Invalid HOSTINGER_BACKGROUND_MODE.");
if (mode === "cron" && process.env.DISCORD_GATEWAY_ENABLED === "true")
  throw new Error("Cron hosting requires Gateway disabled.");
const pool = createPool(config.DATABASE_URL);
const auth = new AuthService(
  pool,
  config.PASSWORD_PEPPER,
  config.SESSION_PEPPER,
);
const memberships = new MembershipService(
  pool,
  config.NODE_ENV !== "production",
);
const discord = createDiscordRuntime(
  pool,
  auth,
  memberships,
  config.SESSION_PEPPER,
);
const supervisor = new DiscordSupervisor(
  pool,
  discord.sync.config.DISCORD_GUILD_ID,
  () => {
    const runtime = createDiscordRuntime(
      pool,
      auth,
      memberships,
      config.SESSION_PEPPER,
    );
    return {
      worker: new DiscordWorker(runtime.sync, runtime.verification),
      gateway: runtime.gateway,
    };
  },
);
const readiness = async () => {
  if (mode === "continuous") return supervisor.health();
  const period = Number(process.env.CRON_EXPECTED_INTERVAL_SECONDS ?? 300);
  if (!Number.isInteger(period) || period < 30 || period > 86400)
    throw new Error("Invalid cron interval.");
  const result = await pool.query<{ alive: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM discord_runtime WHERE name=$1 AND heartbeat_at>now()-$2*interval '1 second') AS alive",
    [`cron:${discord.sync.config.DISCORD_GUILD_ID}`, period + 120],
  );
  return {
    state: "cron",
    gateway: "disabled",
    ready: result.rows[0]?.alive ?? false,
  };
};
const app = buildApp({
  auth,
  memberships,
  production: config.NODE_ENV === "production",
  discord,
  readiness,
});
let background: Promise<void> | undefined;
let shutdown: Promise<void> | undefined;
const stop = () =>
  (shutdown ??= (async () => {
    supervisor.stop();
    const deadline = setTimeout(() => process.exit(1), 20000);
    deadline.unref();
    try {
      await app.close();
      await background;
      await pool.end();
    } finally {
      clearTimeout(deadline);
    }
  })());
process.once("SIGINT", () => {
  void stop();
});
process.once("SIGTERM", () => {
  void stop();
});
// Hostinger's managed loader uses require() for the configured entry file.
// Keep the ESM entry graph synchronous; start asynchronous work in a function
// rather than using top-level await, which causes ERR_REQUIRE_ASYNC_MODULE.
async function startHostinger(): Promise<void> {
  try {
    // Migrations are an explicit release step, never an automatic production startup side effect.
    await pool.query("SELECT 1 FROM discord_member_jobs LIMIT 1");
    await app.listen({ host: process.env.HOST ?? "0.0.0.0", port: config.PORT });
    if (mode === "continuous")
      background = supervisor.run().catch(() => {
        process.stderr.write(
          JSON.stringify({ event: "background_fatal" }) + "\n",
        );
        process.exitCode = 1;
        void stop();
      });
  } catch {
    process.stderr.write(
      JSON.stringify({ event: "hosted_startup_failed" }) + "\n",
    );
    process.exitCode = 1;
    await stop();
  }
}

void startHostinger();
