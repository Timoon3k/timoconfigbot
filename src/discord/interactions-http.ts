import type { FastifyInstance } from "fastify";
import { verifiedInteraction, type DiscordCommands } from "./commands.js";

/** Incoming signed interactions only; does not register commands, invite a bot or call Discord. */
export function registerInteractionEndpoint(
  app: FastifyInstance,
  commands: DiscordCommands,
  publicKeyHex: string,
  applicationId: string,
): void {
  if (!/^[a-f\d]{64}$/i.test(publicKeyHex))
    throw new Error("A valid Ed25519 interaction public key is required.");
  void app.register(async (scoped) => {
    scoped.removeContentTypeParser("application/json");
    scoped.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );
    scoped.post("/api/discord/interactions", async (request, reply) => {
      const signature = request.headers["x-signature-ed25519"];
      const timestamp = request.headers["x-signature-timestamp"];
      if (
        typeof signature !== "string" ||
        typeof timestamp !== "string" ||
        !Buffer.isBuffer(request.body)
      ) {
        return reply
          .code(401)
          .send({ error: { code: "INTERACTION_SIGNATURE_INVALID" } });
      }
      try {
        return await verifiedInteraction(
          request.body,
          signature,
          timestamp,
          publicKeyHex,
          commands,
          applicationId,
        );
      } catch {
        return reply
          .code(401)
          .send({ error: { code: "INTERACTION_REJECTED" } });
      }
    });
  });
}
