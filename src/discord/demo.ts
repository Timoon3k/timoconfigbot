import { randomBytes, randomUUID } from "node:crypto";
import { AuthService } from "../auth/service.js";
import { loadConfig } from "../config.js";
import { createPool } from "../db/pool.js";
import { MembershipService } from "../membership/service.js";
import { MockPaymentProvider } from "../payments/mock.js";
import { createDiscordRuntime } from "./runtime.js";
import { MockOAuthProvider } from "./oauth-provider.js";

const config = loadConfig();
if (config.NODE_ENV === "production")
  throw new Error("Demo is unavailable in production.");
const pool = createPool(config.DATABASE_URL);
try {
  const auth = new AuthService(
    pool,
    config.PASSWORD_PEPPER,
    config.SESSION_PEPPER,
  );
  const memberships = new MembershipService(pool);
  const { sync, links } = createDiscordRuntime(
    pool,
    auth,
    memberships,
    config.SESSION_PEPPER,
  );
  const password = randomBytes(32).toString("base64url");
  const user = await auth.createUser(
    `discord-demo-${randomUUID()}@example.test`,
    password,
  );
  const session = await auth.login(user.email, password);
  const start = await links.begin(session.token, session.csrfToken, password);
  const url = new URL(start.authorizationUrl);
  const discordId = (
    100000000000000000n + BigInt(`0x${randomBytes(7).toString("hex")}`)
  ).toString();
  const code = randomUUID();
  if (!(links.provider instanceof MockOAuthProvider))
    throw new Error("Demo requires the mock provider.");
  links.provider.issueCode(
    code,
    discordId,
    url.searchParams.get("code_challenge")!,
  );
  await links.complete(session.token, url.searchParams.get("state")!, code);
  await pool.query(
    "INSERT INTO discord_mock_members(guild_id,discord_user_id,roles) VALUES($1,$2,'[]')",
    [sync.config.DISCORD_GUILD_ID, discordId],
  );
  const orderId = `demo-${randomUUID()}`;
  await memberships.createOrder({
    userId: user.id,
    productCode: "VIP_MONTHLY_ONCE",
    providerOrderId: orderId,
    idempotencyKey: orderId,
  });
  await memberships.processVerifiedEvent(
    new MockPaymentProvider().createPurchase({
      userId: user.id,
      productCode: "VIP_MONTHLY_ONCE",
      providerOrderId: orderId,
      providerPaymentId: randomUUID(),
      eventId: randomUUID(),
      occurredAt: new Date(),
      correlationId: randomUUID(),
    }),
  );
  process.stdout.write(
    JSON.stringify(
      {
        demoUserId: user.id,
        preview: await sync.preview(user.id, "offline_demo"),
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    "Demo records and jobs were saved. Start discord:worker to record dry-run results. No Discord network request was made.\n",
  );
} finally {
  await pool.end();
}
