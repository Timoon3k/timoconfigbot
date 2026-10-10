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
    DISCORD_ENVIRONMENT: z.enum(["offline", "test-guild"]).default("offline"),
    DISCORD_TEST_GUILD_ID: snowflake.optional(),
    DISCORD_GUILD_OWNER_ID: snowflake.optional(),
    DISCORD_OWNER_APPROVED: flag("false"),
    DISCORD_APPROVAL_REFERENCE: z.string().min(8).max(200).optional(),
    DISCORD_GATEWAY_ENABLED: flag("false"),
    DISCORD_COMMANDS_ENABLED: flag("false"),
    DISCORD_VERIFICATION_ENABLED: flag("false"),
    DISCORD_VIP_SYNC_ENABLED: flag("true"),
    DISCORD_FREE_MEMBER_ROLE_ID: snowflake.default("100000000000000008"),
    DISCORD_SUPPORT_URL: z.string().url().default("https://timonconfigs.com"),
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
      config.DISCORD_FREE_MEMBER_ROLE_ID,
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
    const active =
      !config.DISCORD_DRY_RUN ||
      config.DISCORD_WRITES_ENABLED ||
      config.DISCORD_NETWORK_ENABLED ||
      config.DISCORD_ADAPTER !== "mock" ||
      config.DISCORD_GATEWAY_ENABLED ||
      config.DISCORD_COMMANDS_ENABLED;
    if (config.DISCORD_ENVIRONMENT === "offline" && active)
      ctx.addIssue({
        code: "custom",
        message: "Offline mode prohibits Discord network and live writes.",
      });
    if (
      config.DISCORD_ENVIRONMENT === "test-guild" &&
      (!config.DISCORD_OWNER_APPROVED ||
        !config.DISCORD_APPROVAL_REFERENCE ||
        !config.DISCORD_GUILD_OWNER_ID ||
        config.DISCORD_TEST_GUILD_ID !== config.DISCORD_GUILD_ID ||
        config.DISCORD_GUILD_ID === "100000000000000001" ||
        config.DISCORD_ADAPTER !== "rest" ||
        !config.DISCORD_NETWORK_ENABLED)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Test guild requires explicit owner approval, owner identity and matching test guild ID.",
      });
    if (config.DISCORD_WRITES_ENABLED === config.DISCORD_DRY_RUN)
      ctx.addIssue({
        code: "custom",
        message: "Writes and DRY_RUN must be complementary.",
      });
    const support = new URL(config.DISCORD_SUPPORT_URL);
    if (support.protocol !== "https:" || support.username || support.password)
      ctx.addIssue({
        code: "custom",
        message: "Support URL must use HTTPS without credentials.",
      });
  });
export type DiscordConfig = z.infer<typeof schema>;
export function loadDiscordConfig(
  env: NodeJS.ProcessEnv = process.env,
): DiscordConfig {
  if (env.NODE_ENV === "production")
    throw new Error(
      "Production Discord activation is not supported by this release.",
    );
  const normalized = { ...env };
  for (const key of [
    "DISCORD_TEST_GUILD_ID",
    "DISCORD_GUILD_OWNER_ID",
    "DISCORD_APPROVAL_REFERENCE",
  ])
    if (normalized[key] === "") delete normalized[key];
  return schema.parse(normalized);
}
