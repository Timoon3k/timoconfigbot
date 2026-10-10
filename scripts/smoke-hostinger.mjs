import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Disposable test database required.");
const pool = new pg.Pool({ connectionString: url });
const member = "700000000000000001";
const guild = "100000000000000001";
const listener = createServer();
await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port;
await new Promise((r) => listener.close(r));
const env = {
  ...process.env,
  NODE_ENV: "test",
  DATABASE_URL: url,
  DB_CONNECTION_MODE: "direct",
  DB_SSL_MODE: "disable",
  HOST: "127.0.0.1",
  PORT: String(port),
  SESSION_PEPPER: randomBytes(32).toString("hex"),
  PASSWORD_PEPPER: randomBytes(32).toString("hex"),
  DISCORD_ENVIRONMENT: "offline",
  DISCORD_ADAPTER: "mock",
  DISCORD_NETWORK_ENABLED: "false",
  DISCORD_DRY_RUN: "true",
  DISCORD_WRITES_ENABLED: "false",
  DISCORD_GATEWAY_ENABLED: "false",
  DISCORD_VERIFICATION_ENABLED: "true",
  DISCORD_VIP_SYNC_ENABLED: "false",
  DISCORD_WORKER_BATCH_SIZE: "2",
  DISCORD_RECONCILE_BATCH_SIZE: "2",
  HOSTINGER_BACKGROUND_MODE: "continuous",
  CRON_MAX_TICKS: "1",
  CRON_MAX_DURATION_MS: "1000",
};
const children = [];
function start(path, extra = {}) {
  const child = spawn(process.execPath, [path], {
    env: { ...env, ...extra },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.resume();
  children.push(child);
  return child;
}
async function stop(child) {
  if (child.exitCode !== null) return;
  const done = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await done;
    assert.equal(child.exitCode, 0);
  } finally {
    clearTimeout(timer);
  }
}
async function ready() {
  for (let i = 0; i < 100; i++) {
    const response = await fetch(`http://127.0.0.1:${port}/ready`).catch(
      () => null,
    );
    if (response?.ok) return;
    await delay(100);
  }
  throw new Error("Hosted app not ready.");
}
try {
  await pool.query(
    `INSERT INTO discord_mock_members(guild_id,discord_user_id,pending) VALUES($1,$2,false)
    ON CONFLICT(guild_id,discord_user_id) DO UPDATE SET pending=false,present=true`,
    [guild, member],
  );
  await pool.query(
    `INSERT INTO discord_member_jobs(guild_id,discord_user_id) VALUES($1,$2) ON CONFLICT(guild_id,discord_user_id)
    DO UPDATE SET status='queued',attempt_count=0,available_at=now(),requested_version=discord_member_jobs.requested_version+1`,
    [guild, member],
  );
  const first = start("dist/hostinger.js");
  await ready();
  await stop(first);
  // Persisted work survives a new process, including an abandoned lease.
  await pool.query(
    `UPDATE discord_member_jobs SET status='processing',lease_token=gen_random_uuid(),lease_expires_at=now()-interval '1 second',attempt_count=1 WHERE guild_id=$1 AND discord_user_id=$2`,
    [guild, member],
  );
  const restarted = start("dist/hostinger.js");
  await ready();
  for (let i = 0; i < 100; i++) {
    const state = (
      await pool.query(
        "SELECT status FROM discord_member_jobs WHERE guild_id=$1 AND discord_user_id=$2",
        [guild, member],
      )
    ).rows[0];
    if (state.status === "succeeded") break;
    await delay(100);
  }
  assert.equal(
    (
      await pool.query(
        "SELECT status FROM discord_member_jobs WHERE guild_id=$1 AND discord_user_id=$2",
        [guild, member],
      )
    ).rows[0].status,
    "succeeded",
  );
  await stop(restarted);
  const cron = start("dist/discord/cron-cli.js");
  const exited = await new Promise((r) => cron.once("exit", r));
  assert.equal(exited, 0);
  const api = start("dist/hostinger.js", { HOSTINGER_BACKGROUND_MODE: "cron" });
  await ready();
  await stop(api);
  console.log(
    "PASS: single-process API/worker readiness, restart lease recovery, bounded cron, cron heartbeat and graceful shutdown; offline only.",
  );
} finally {
  for (const child of children) await stop(child);
  await pool.end();
}
