import { z } from "zod";
import { loadDiscordConfig } from "./discord/config.js";

const booleanString = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((value) => value === "true");
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z
    .string()
    .url()
    .refine(
      (value) =>
        value.startsWith("postgresql://") || value.startsWith("postgres://"),
      "Must be a PostgreSQL URL",
    ),
  SESSION_PEPPER: z.string().min(32),
  PASSWORD_PEPPER: z.string().min(32),
  PAYMENTS_ENABLED: booleanString("false"),
  PROVIDER_APPROVAL_CONFIRMED: booleanString("false"),
  PAYMENT_PROVIDER: z.literal("mock").default("mock"),
  DISCORD_DRY_RUN: booleanString("true"),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  loadDiscordConfig(environment);
  const config = schema.parse(environment);
  if (config.PAYMENTS_ENABLED || config.PROVIDER_APPROVAL_CONFIRMED) {
    throw new Error(
      "Production payment processing is intentionally disabled in Phase 1.",
    );
  }
  if (!config.DISCORD_DRY_RUN) {
    throw new Error("Discord DRY_RUN must remain enabled in Phase 1.");
  }
  return config;
}
