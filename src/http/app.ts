import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthService, AuthenticatedUser } from "../auth/service.js";
import { AppError } from "../errors.js";
import type { MembershipService } from "../membership/service.js";
import { DiscordFailure } from "../discord/types.js";
import type { DiscordSyncService } from "../discord/sync.js";
import type { DiscordLinkService } from "../discord/oauth.js";
import { registerDiscordRoutes } from "../discord/http.js";
import type { TicketService } from "../tickets/service.js";
import type { BillingService } from "../billing/service.js";
import type { BillingInteractions } from "../billing/interactions.js";
import { registerBillingRoutes } from "../billing/http.js";

const credentialsSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(12).max(200),
});

function bearerOrCookie(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  return request.cookies.session ?? "";
}

export function buildApp(dependencies: {
  auth: AuthService;
  memberships: MembershipService;
  production: boolean;
  readiness?: () => Promise<{ ready: boolean; state: string; gateway: string }>;
  discord?: { sync: DiscordSyncService; links: DiscordLinkService; tickets?: TicketService;
    billing?: BillingService; billingInteractions?: BillingInteractions };
}): FastifyInstance {
  const app = Fastify({
    logger: false,
    trustProxy: false,
    bodyLimit: 64 * 1024,
  });
  void app.register(cookie);
  void app.register(rateLimit, { max: 100, timeWindow: "1 minute" });

  const authenticate = async (
    request: FastifyRequest,
    mutating = false,
  ): Promise<AuthenticatedUser> => {
    const csrf =
      typeof request.headers["x-csrf-token"] === "string"
        ? request.headers["x-csrf-token"]
        : undefined;
    return dependencies.auth.authenticate(
      bearerOrCookie(request),
      csrf,
      mutating,
    );
  };

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DiscordFailure)
      return reply.code(error.retryable ? 503 : 409).send({
        error: {
          code: error.code,
          message: "Discord operation could not be completed safely.",
        },
      });
    if (
      error &&
      typeof error === "object" &&
      "statusCode" in error &&
      error.statusCode === 429
    )
      return reply.code(429).send({
        error: { code: "RATE_LIMITED", message: "Too many requests." },
      });
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
    }
    if (error instanceof z.ZodError) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed.",
          details: error.flatten(),
        },
      });
    }
    app.log.error(error);
    return reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "An internal error occurred.",
      },
    });
  });

  app.get("/health", async () => ({
    status: "ok",
    payments: dependencies.production ? "disabled" : "sandbox-only",
    stripeBilling: dependencies.discord?.billing?.config.STRIPE_CHECKOUT_ENABLED
      ? dependencies.discord.billing.config.STRIPE_MODE : "checkout-disabled",
    discord:
      dependencies.discord?.sync.config.DISCORD_DRY_RUN === false
        ? dependencies.discord.sync.config.DISCORD_ENVIRONMENT === "production"
          ? "free-member-only"
          : "test-guild"
        : "dry-run",
  }));

  app.post(
    "/auth/register",
    { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const input = credentialsSchema.parse(request.body);
      const user = await dependencies.auth.createUser(
        input.email,
        input.password,
      );
      return reply.status(201).send({ user });
    },
  );

  app.post(
    "/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const input = credentialsSchema.parse(request.body);
      const session = await dependencies.auth.login(
        input.email,
        input.password,
      );
      reply.setCookie("session", session.token, {
        httpOnly: true,
        sameSite: "strict",
        secure: dependencies.production,
        path: "/",
        expires: session.expiresAt,
      });
      return {
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt.toISOString(),
      };
    },
  );

  app.get("/api/me", async (request) => {
    const user = await authenticate(request);
    return {
      user,
      membership: { tier: await dependencies.memberships.activeTier(user.id) },
    };
  });

  app.get("/admin/memberships", async (request) => {
    const user = await authenticate(request);
    dependencies.auth.requireAdmin(user);
    const result = await dependencies.memberships.pool.query(
      `SELECT u.id, u.email::text, u.role,
       COALESCE((SELECT tier::text FROM membership_entitlements e WHERE e.user_id = u.id AND e.valid_from <= now()
         AND (e.valid_until IS NULL OR e.valid_until > now()) AND (e.revoked_at IS NULL OR e.revoked_at > now())
         ORDER BY CASE e.tier WHEN 'VIP_LIFETIME' THEN 2 ELSE 1 END DESC LIMIT 1), 'FREE') AS tier
       FROM app_users u ORDER BY u.created_at DESC LIMIT 100`,
    );
    return { members: result.rows };
  });

  app.post("/admin/reconciliation/expired", async (request) => {
    const user = await authenticate(request, true);
    dependencies.auth.requireAdmin(user);
    return {
      queued: await dependencies.memberships.reconcileExpired(
        new Date(),
        user.id,
      ),
    };
  });

  if (dependencies.discord)
    registerDiscordRoutes(
      app,
      dependencies.auth,
      dependencies.discord.sync,
      dependencies.discord.links,
      dependencies.readiness,
      dependencies.discord.tickets,
      dependencies.discord.billingInteractions,
    );
  if (dependencies.discord?.billing) registerBillingRoutes(app, dependencies.discord.billing);
  return app;
}
