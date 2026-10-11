import { AuthService } from "../auth/service.js";
import { loadConfig } from "../config.js";
import { createPool } from "../db/pool.js";
import { MembershipService } from "../membership/service.js";
import { createDiscordRuntime } from "./runtime.js";
import { DiscordWorker } from "./worker.js";

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const runtime = createDiscordRuntime(
  pool,
  new AuthService(pool, config.PASSWORD_PEPPER, config.SESSION_PEPPER),
  new MembershipService(pool, config.NODE_ENV !== "production"),
  config.SESSION_PEPPER,
);
if (runtime.gateway) {
  await pool.end();
  throw new Error("Cron requires DISCORD_GATEWAY_ENABLED=false.");
}
const ticks = Number(process.env.CRON_MAX_TICKS ?? 3);
const duration = Number(process.env.CRON_MAX_DURATION_MS ?? 45000);
if (
  !Number.isInteger(ticks) ||
  ticks < 1 ||
  ticks > 10 ||
  !Number.isInteger(duration) ||
  duration < 1000 ||
  duration > 60000
) {
  await pool.end();
  throw new Error("Cron bounds are invalid.");
}
const client = await pool.connect();
const worker = new DiscordWorker(runtime.sync, runtime.verification, runtime.tickets);
const key = `discord-gateway:${runtime.sync.config.DISCORD_GUILD_ID}`;
const disconnect = () => worker.stop();
client.on("error", disconnect);
const started = Date.now();
let leader = false;
const timer = setTimeout(() => worker.stop(), duration);
const hardDeadline = setTimeout(() => process.exit(1), duration + 10000);
hardDeadline.unref();
try {
  leader =
    (
      await client.query<{ leader: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS leader",
        [key],
      )
    ).rows[0]?.leader ?? false;
  if (leader)
    for (let i = 0; i < ticks && Date.now() - started < duration; i++) {
      await client.query("SELECT 1");
      await worker.tick();
    }
  if (leader)
    await pool.query(
      `INSERT INTO discord_runtime(name,heartbeat_at) VALUES($1,now())
    ON CONFLICT(name) DO UPDATE SET heartbeat_at=now()`,
      [`cron:${runtime.sync.config.DISCORD_GUILD_ID}`],
    );
  process.stdout.write(
    JSON.stringify({
      event: "bounded_reconciliation_finished",
      leader,
      durationMs: Date.now() - started,
    }) + "\n",
  );
} catch {
  process.stderr.write(
    JSON.stringify({ event: "bounded_reconciliation_failed" }) + "\n",
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  clearTimeout(hardDeadline);
  worker.stop();
  if (leader)
    await client
      .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key])
      .catch(() => undefined);
  client.removeListener("error", disconnect);
  client.release(true);
  await pool.end();
}
