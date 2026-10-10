import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import pg from "pg";

const connectionString = process.env.TEST_DATABASE_URL;
if (
  !connectionString ||
  !new URL(connectionString).pathname.endsWith("_test")
) {
  throw new Error(
    "Use a disposable TEST_DATABASE_URL whose database name ends in _test.",
  );
}
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const env = {
  ...process.env,
  NODE_ENV: "test",
  DATABASE_URL: connectionString,
  PORT: String(port),
  HOST: "127.0.0.1",
  SESSION_PEPPER: randomBytes(32).toString("hex"),
  PASSWORD_PEPPER: randomBytes(32).toString("hex"),
};
await promisify(execFile)(process.execPath, ["dist/db/cli.js", "up"], { env });
const demo = await promisify(execFile)(
  process.execPath,
  ["dist/discord/demo.js"],
  { env },
);
const demoId = demo.stdout.match(/"demoUserId": "([a-f\d-]+)"/)?.[1];
assert.ok(demoId);
const pool = new pg.Pool({ connectionString });
const children = [];
async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await exited;
    assert.equal(child.exitCode, 0, "Child process must stop gracefully.");
  } finally {
    clearTimeout(timer);
  }
}
try {
  for (const script of ["dist/server.js", "dist/discord/worker-cli.js"]) {
    const child = spawn(process.execPath, [script], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.resume();
    child.stderr.resume();
    children.push(child);
  }
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${base}/ready`).catch(() => null);
    if (response?.ok) {
      ready = true;
      break;
    }
    await delay(100);
  }
  assert.ok(ready, "Compiled backend and worker must become ready.");
  assert.equal(
    (await fetch(`${base}/health`).then((r) => r.json())).discord,
    "dry-run",
  );
  const credentials = {
    email: `smoke-${randomUUID()}@example.test`,
    password: randomBytes(24).toString("base64url"),
  };
  const post = (path, body, headers = {}) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  assert.equal((await post("/auth/register", credentials)).status, 201);
  const login = await post("/auth/login", credentials);
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const session = await login.json();
  const me = await fetch(`${base}/api/me`, {
    headers: { Cookie: cookie },
  }).then((r) => r.json());
  assert.equal(me.membership.tier, "FREE");
  assert.equal(
    (
      await post(
        "/api/discord/connect",
        { password: credentials.password },
        { Cookie: cookie, "x-csrf-token": session.csrfToken },
      )
    ).status,
    200,
  );
  let preview;
  for (let attempt = 0; attempt < 50; attempt++) {
    preview = (
      await pool.query(
        "SELECT preview FROM discord_sync_history WHERE user_id=$1 AND outcome='preview' ORDER BY id DESC LIMIT 1",
        [demoId],
      )
    ).rows[0]?.preview;
    if (preview) break;
    await delay(100);
  }
  assert.equal(preview.effectiveMembership, "VIP_MONTHLY");
  assert.equal(preview.dryRun, true);
  assert.equal(preview.add.length, 1);
  const member = (
    await pool.query(
      "SELECT m.roles FROM discord_mock_members m JOIN discord_accounts a ON a.discord_user_id=m.discord_user_id WHERE a.user_id=$1",
      [demoId],
    )
  ).rows[0];
  assert.deepEqual(member.roles, [], "Dry-run must not change the mock roles.");
  console.log(
    "PASS: compiled migrations, demo OAuth/payment, HTTP authentication, worker readiness, persisted role preview and zero mutations.",
  );
} finally {
  for (const child of children.reverse()) await stop(child);
  await pool.end();
}
console.log("PASS: backend and worker graceful shutdown.");
