import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthService } from "../auth/service.js";
import { inTransaction } from "../db/pool.js";
import { discordAudit } from "./audit.js";
import type { DiscordLinkService } from "./oauth.js";
import type { DiscordSyncService } from "./sync.js";
import { DiscordFailure } from "./types.js";
import { DiscordCommands } from "./commands.js";
import { registerInteractionEndpoint } from "./interactions-http.js";
import { MembershipService } from "../membership/service.js";

export function sessionToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ")
    ? header.slice(7)
    : (request.cookies.session ?? "");
}
const csrfToken = (request: FastifyRequest) =>
  typeof request.headers["x-csrf-token"] === "string"
    ? request.headers["x-csrf-token"]
    : "";
const uuidParams = z.object({ userId: z.string().uuid() });
const pageQuery = z.object({
  before: z.string().regex(/^\d+$/).default("9223372036854775807"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function registerDiscordRoutes(
  app: FastifyInstance,
  auth: AuthService,
  sync: DiscordSyncService,
  links: DiscordLinkService,
): void {
  if (sync.config.DISCORD_INTERACTIONS_PUBLIC_KEY)
    registerInteractionEndpoint(
      app,
      new DiscordCommands(
        sync.pool,
        new MembershipService(sync.pool),
        sync.config,
      ),
      sync.config.DISCORD_INTERACTIONS_PUBLIC_KEY,
      sync.config.DISCORD_CLIENT_ID,
    );
  const admin = async (request: FastifyRequest, mutation = false) => {
    const user = await auth.authenticate(
      sessionToken(request),
      csrfToken(request),
      mutation,
    );
    auth.requireAdmin(user);
    return user;
  };
  app.post(
    "/api/discord/connect",
    { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } },
    async (request) => {
      const body = z
        .object({
          password: z.string().min(12).max(200),
          confirmReplacement: z.boolean().default(false),
        })
        .strict()
        .parse(request.body);
      return links.begin(
        sessionToken(request),
        csrfToken(request),
        body.password,
        body.confirmReplacement,
      );
    },
  );
  // SameSite=Strict session cookies are withheld on the initial external redirect.
  // This fixed same-origin bridge makes the authenticated POST without weakening the cookie policy.
  app.get("/api/discord/callback", async (_request, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("Referrer-Policy", "no-referrer")
      .header(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
    return reply
      .type("text/html")
      .send(
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>Discord connection</title><p id="status">Completing your Discord connection…</p><script src="/discord-callback.js" defer></script></html>',
      );
  });
  app.get("/discord-callback.js", async (_request, reply) =>
    reply.type("text/javascript").send(`
    const params = new URLSearchParams(location.search);
    const body = { state: params.get('state'), code: params.get('code') };
    history.replaceState(null, '', location.pathname);
    fetch('/api/discord/callback', {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)})
      .then(response => { document.getElementById('status').textContent = response.ok ? 'Discord account linked. You can close this page.' : 'Linking failed. Return to your account and start again.'; })
      .catch(() => { document.getElementById('status').textContent = 'Linking failed. Please try again.'; });
  `),
  );
  app.post(
    "/api/discord/callback",
    { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const body = z
        .object({
          state: z.string().min(40).max(128),
          code: z.string().min(1).max(2048),
        })
        .strict()
        .parse(request.body);
      return links.complete(sessionToken(request), body.state, body.code);
    },
  );
  app.get("/api/discord/status", async (request) => {
    const user = await auth.authenticate(sessionToken(request));
    return links.status(user.id);
  });
  app.post(
    "/api/discord/unlink",
    { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } },
    async (request) => {
      const body = z
        .object({ password: z.string().min(12).max(200) })
        .strict()
        .parse(request.body);
      await links.unlink(
        sessionToken(request),
        csrfToken(request),
        body.password,
      );
      return { unlinked: true };
    },
  );
  app.get("/admin/discord/users/:userId", async (request) => {
    await admin(request);
    const { userId } = uuidParams.parse(request.params);
    const [connection, entitlements, history, effectiveMembership] =
      await Promise.all([
        links.status(userId),
        sync.pool.query(
          "SELECT id,tier,valid_from,valid_until,revoked_at FROM membership_entitlements WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",
          [userId],
        ),
        sync.pool.query(
          "SELECT preview,created_at FROM discord_sync_history WHERE user_id=$1 AND preview IS NOT NULL ORDER BY id DESC LIMIT 1",
          [userId],
        ),
        sync.effectiveTier(userId),
      ]);
    return {
      connection,
      effectiveMembership,
      entitlements: entitlements.rows,
      lastKnownState: history.rows[0] ?? null,
    };
  });
  app.post("/admin/discord/users/:userId/preview", async (request) => {
    const actor = await admin(request, true);
    const { userId } = uuidParams.parse(request.params);
    const preview = await sync.preview(userId);
    await discordAudit(
      sync.pool,
      "DISCORD_ADMIN_PREVIEW",
      userId,
      { preview },
      randomUUID(),
      actor.id,
    );
    return { preview };
  });
  app.post("/admin/discord/users/:userId/sync", async (request) => {
    const actor = await admin(request, true);
    const { userId } = uuidParams.parse(request.params);
    z.object({})
      .strict()
      .parse(request.body ?? {});
    return {
      jobId: await sync.enqueue(userId, "administrator_sync", actor.id),
    };
  });
  app.get("/admin/discord/users/:userId/history", async (request) => {
    await admin(request);
    const { userId } = uuidParams.parse(request.params);
    const page = pageQuery.parse(request.query);
    const result = await sync.pool.query(
      "SELECT * FROM discord_sync_history WHERE user_id=$1 AND id<$2 ORDER BY id DESC LIMIT $3",
      [userId, page.before, page.limit],
    );
    return { history: result.rows };
  });
  app.get("/admin/discord/jobs", async (request) => {
    await admin(request);
    const page = z
      .object({
        status: z
          .enum([
            "queued",
            "processing",
            "retry",
            "succeeded",
            "member_absent",
            "dead_letter",
          ])
          .default("dead_letter"),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(request.query);
    return {
      jobs: (
        await sync.pool.query(
          "SELECT * FROM discord_sync_jobs WHERE status=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3",
          [page.status, page.limit, page.offset],
        )
      ).rows,
    };
  });
  app.post("/admin/discord/jobs/:jobId/retry", async (request) => {
    const actor = await admin(request, true);
    const { jobId } = z
      .object({ jobId: z.string().uuid() })
      .parse(request.params);
    await sync.queue.retry(jobId, actor.id);
    return { queued: true };
  });
  app.get("/admin/discord/statistics", async (request) => {
    await admin(request);
    return sync.stats();
  });
  app.get("/admin/discord/ownership-audit", async (request) => {
    await admin(request);
    const { limit, before } = pageQuery.parse(request.query);
    return {
      observations: (
        await sync.pool.query(
          `SELECT h.id,h.user_id,h.discord_user_id,h.preview,h.created_at,
      (a.user_id IS NULL OR a.unlinked_at IS NOT NULL OR a.discord_user_id<>h.discord_user_id) AS orphaned
      FROM discord_sync_history h LEFT JOIN discord_accounts a ON a.user_id=h.user_id
      WHERE h.preview IS NOT NULL AND h.id<$1 ORDER BY h.id DESC LIMIT $2`,
          [before, limit],
        )
      ).rows,
      coverage:
        "Observed linked identities only; historical guild-wide inventory is required before live activation.",
    };
  });
  app.get("/admin/discord/inventory", async (request) => {
    await admin(request);
    const page = z.object({
      after: z.string().regex(/^[0-9]{1,20}$/).default("0"),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(request.query);
    const result = await sync.pool.query(`SELECT m.discord_user_id,m.roles,m.present,m.updated_at,
      a.user_id,(a.user_id IS NULL OR a.unlinked_at IS NOT NULL) AS orphaned,
      ARRAY(SELECT r FROM jsonb_array_elements_text(m.roles) r WHERE r=ANY($4::text[]) AND NOT EXISTS(
        SELECT 1 FROM discord_role_ownership o WHERE o.guild_id=m.guild_id
        AND o.discord_user_id=m.discord_user_id AND o.role_id=r AND o.user_id=a.user_id)) AS unowned_vip_roles
      FROM discord_mock_members m LEFT JOIN discord_accounts a ON a.discord_user_id=m.discord_user_id
      WHERE m.guild_id=$1 AND m.discord_user_id::numeric>$2::numeric
      ORDER BY m.discord_user_id::numeric LIMIT $3`,
      [sync.config.DISCORD_GUILD_ID,page.after,page.limit,[sync.config.DISCORD_VIP_MONTHLY_ROLE_ID,sync.config.DISCORD_VIP_LIFETIME_ROLE_ID]]);
    return {members:result.rows,source:"local-mock-inventory",liveGuildInventoryComplete:false};
  });
  app.post("/admin/discord/users/:userId/ownership", async (request) => {
    const actor = await admin(request, true);
    const { userId } = uuidParams.parse(request.params);
    const body = z
      .object({
        password: z.string().min(12).max(200),
        roleKey: z.enum(["VIP_MONTHLY", "VIP_LIFETIME"]),
        policy: z.literal("adopt-existing-vip-role"),
        confirmation: z.literal(true),
        reference: z.string().min(8).max(200),
      })
      .strict()
      .parse(request.body);
    await auth.reauthenticate(actor.id, body.password);
    const preview = await sync.preview(userId);
    const roleId =
      body.roleKey === "VIP_MONTHLY"
        ? sync.config.DISCORD_VIP_MONTHLY_ROLE_ID
        : sync.config.DISCORD_VIP_LIFETIME_ROLE_ID;
    if (!preview?.currentRoles.includes(roleId))
      throw new DiscordFailure("ROLE_NOT_OBSERVED");
    await inTransaction(sync.pool, async (db) => {
      await db.query("SELECT id FROM app_users WHERE id=$1 FOR UPDATE", [
        userId,
      ]);
      const account = (
        await db.query<{ discord_user_id: string }>(
          "SELECT discord_user_id FROM discord_accounts WHERE user_id=$1 AND unlinked_at IS NULL",
          [userId],
        )
      ).rows[0];
      if (account?.discord_user_id !== preview.discordUserId)
        throw new DiscordFailure("IDENTITY_CHANGED");
      await db.query(
        `INSERT INTO discord_role_ownership(guild_id,discord_user_id,role_id,user_id,source,approval_reference,actor_user_id)
        VALUES($1,$2,$3,$4,'mock_seed',$5,$6) ON CONFLICT DO NOTHING`,
        [
          preview.guildId,
          preview.discordUserId,
          roleId,
          userId,
          body.reference,
          actor.id,
        ],
      );
      await discordAudit(
        db,
        "DISCORD_MOCK_OWNERSHIP_APPROVED",
        userId,
        { roleId, reference: body.reference, policy: body.policy },
        randomUUID(),
        actor.id,
      );
    });
    return { approved: true, scope: "mock-only" };
  });
  app.get("/ready", async (_request, reply) => {
    try {
      await sync.pool.query("SELECT 1 FROM discord_runtime LIMIT 1");
      const worker = (
        await sync.pool.query<{
          alive: boolean;
        }>(`SELECT EXISTS(SELECT 1 FROM discord_runtime
        WHERE name LIKE 'worker:%' AND heartbeat_at>now()-interval '60 seconds') AS alive`)
      ).rows[0];
      reply.code(worker?.alive ? 200 : 503);
      return {
        database: "ok",
        worker: worker?.alive ? "ok" : "not-running",
        mode: "offline-dry-run",
      };
    } catch {
      return reply.code(503).send({ database: "unavailable" });
    }
  });
}
