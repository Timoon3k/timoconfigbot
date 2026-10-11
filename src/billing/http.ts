import type { FastifyInstance } from "fastify";
import { BillingFailure } from "./stripe.js";
import type { BillingService } from "./service.js";

export function registerBillingRoutes(
  app: FastifyInstance,
  billing: BillingService,
): void {
  void app.register(async (scoped) => {
    scoped.removeContentTypeParser("application/json");
    scoped.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: 1024 * 1024 },
      (_req, body, done) => done(null, body),
    );
    scoped.post(
      "/api/payments/stripe/webhook",
      { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
      async (request, reply) => {
        if (!billing.config.STRIPE_WEBHOOKS_ENABLED)
          return reply.code(503).send({ error: "BILLING_DISABLED" });
        const signature = request.headers["stripe-signature"];
        if (!Buffer.isBuffer(request.body) || typeof signature !== "string")
          return reply.code(400).send({ error: "STRIPE_SIGNATURE_INVALID" });
        try {
          await billing.receive(request.body, signature);
          return { received: true };
        } catch (error) {
          return reply
            .code(
              error instanceof BillingFailure && !error.retryable ? 400 : 503,
            )
            .send({
              error:
                error instanceof BillingFailure
                  ? error.code
                  : "STRIPE_RECEIPT_RETRY",
            });
        }
      },
    );
  });
  for (const path of ["/billing/return", "/billing/cancel"])
    app.get(path, async (_req, reply) =>
      reply
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .type("text/plain; charset=utf-8")
        .send(
          "Return to your private Discord VIP ticket and use Manage Billing / Status. This page does not confirm payment or grant VIP access.",
        ),
    );
}
