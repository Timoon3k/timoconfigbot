import { z } from "zod";

export const snowflake = z
  .string()
  .regex(/^[0-9]{17,20}$/)
  .refine((id) => BigInt(id) > 0n && BigInt(id) <= 18446744073709551615n);
const flag = (value: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(value)
    .transform((item) => item === "true");
const schema = z
  .object({
    DISCORD_ADAPTER: z.enum(["mock", "rest"]).default("mock"),
    DISCORD_DRY_RUN: flag("true"),
    DISCORD_WRITES_ENABLED: flag("false"),
    DISCORD_NETWORK_ENABLED: flag("false"),
    DISCORD_GUILD_ID: snowflake.default("100000000000000001"),
    DISCORD_CLIENT_ID: snowflake.default("100000000000000002"),
    DISCORD_INTERACTIONS_PUBLIC_KEY: z
      .string()
      .regex(/^(?:[a-fA-F0-9]{64})?$/)
      .default(""),
    DISCORD_VIP_MONTHLY_ROLE_ID: snowflake.default("100000000000000003"),
    DISCORD_VIP_LIFETIME_ROLE_ID: snowflake.default("100000000000000004"),
    DISCORD_FOUNDER_ROLE_ID: snowflake.default("100000000000000005"),
    DISCORD_STAFF_ROLE_ID: snowflake.default("100000000000000006"),
    DISCORD_OAUTH_REDIRECT_URI: z
      .string()
      .url()
      .default("http://localhost:3001/api/discord/callback"),
    DISCORD_WORKER_POLL_MS: z.coerce
      .number()
      .int()
      .min(50)
      .max(60000)
      .default(1000),
    DISCORD_WORKER_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10),
    DISCORD_LEASE_SECONDS: z.coerce
      .number()
      .int()
      .min(30)
      .max(600)
      .default(120),
    DISCORD_RECONCILE_SECONDS: z.coerce
      .number()
      .int()
      .min(30)
      .max(86400)
      .default(3600),
    DISCORD_RECONCILE_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(100),
    DISCORD_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(8),
    DISCORD_MIN_REQUEST_MS: z.coerce
      .number()
      .int()
      .min(50)
      .max(60000)
      .default(250),
  })
  .superRefine((config, ctx) => {
    const ids = [
      config.DISCORD_GUILD_ID,
      config.DISCORD_CLIENT_ID,
      config.DISCORD_VIP_MONTHLY_ROLE_ID,
      config.DISCORD_VIP_LIFETIME_ROLE_ID,
      config.DISCORD_FOUNDER_ROLE_ID,
      config.DISCORD_STAFF_ROLE_ID,
    ];
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: "custom",
        message: "Discord IDs must be distinct.",
      });
    const redirect = new URL(config.DISCORD_OAUTH_REDIRECT_URI);
    if (
      redirect.username ||
      redirect.password ||
      redirect.hash ||
      redirect.search ||
      (redirect.protocol !== "https:" &&
        !(
          redirect.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(redirect.hostname)
        ))
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "OAuth redirect must use HTTPS or loopback HTTP without credentials, query or fragment.",
      });
    }
    if (
      !config.DISCORD_DRY_RUN ||
      config.DISCORD_WRITES_ENABLED ||
      config.DISCORD_NETWORK_ENABLED ||
      config.DISCORD_ADAPTER !== "mock"
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "This release permits only offline mock and DRY_RUN. Live activation needs a separately approved release.",
      });
    }
  });
export type DiscordConfig = z.infer<typeof schema>;
export function loadDiscordConfig(
  env: NodeJS.ProcessEnv = process.env,
): DiscordConfig {
  if (env.NODE_ENV === "production")
    throw new Error(
      "This offline Discord release is not approved for production activation.",
    );
  return schema.parse(env);
}
