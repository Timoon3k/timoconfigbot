import { z } from "zod";

export const snowflake = z
  .string()
  .regex(/^[0-9]{17,20}$/)
  .refine((id) => /^\d{17,20}$/.test(id) && BigInt(id) > 0n && BigInt(id) <= 18446744073709551615n);
const flag = (value: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(value)
    .transform((item) => item === "true");
const schema = z
  .object({
    DISCORD_ENVIRONMENT: z
      .enum(["offline", "test-guild", "production"])
      .default("offline"),
    DISCORD_TEST_GUILD_ID: snowflake.optional(),
    DISCORD_PRODUCTION_GUILD_ID: snowflake.optional(),
    DISCORD_FREE_MEMBER_WRITES_APPROVED: flag("false"),
    DISCORD_FREE_MEMBER_ROLLOUT_MODE: z.enum(["disabled", "canary", "all"]).default("disabled"),
    DISCORD_FREE_MEMBER_CANARY_IDS: z.string().default("").transform((value) =>
      value.trim() ? value.split(",").map((id) => id.trim()) : [],
    ),
    DISCORD_FREE_MEMBER_ALL_APPROVAL_REFERENCE: z.string().min(8).max(200).optional(),
    DISCORD_FREE_MEMBER_APPROVAL_REFERENCE: z
      .string()
      .min(8)
      .max(200)
      .optional(),
    DISCORD_PRODUCTION_VIP_WRITES_ENABLED: flag("false"),
    DISCORD_GUILD_OWNER_ID: snowflake.optional(),
    DISCORD_OWNER_APPROVED: flag("false"),
    DISCORD_APPROVAL_REFERENCE: z.string().min(8).max(200).optional(),
    DISCORD_GATEWAY_ENABLED: flag("false"),
    // Passive Ticket Tool channel detection: never sends a message or grants roles.
    TICKET_TOOL_CHANNEL_OBSERVATION_ENABLED: flag("false"),
    TICKET_TOOL_DISCORD_CATEGORY_IDS: z.string().default("").transform((value) =>
      value.trim() ? value.split(",").map((id) => id.trim()) : [],
    ),
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
    const ticketCategoryIds = config.TICKET_TOOL_DISCORD_CATEGORY_IDS;
    if (
      ticketCategoryIds.length > 10 ||
      ticketCategoryIds.some((id) => !snowflake.safeParse(id).success) ||
      new Set(ticketCategoryIds).size !== ticketCategoryIds.length ||
      (config.TICKET_TOOL_CHANNEL_OBSERVATION_ENABLED && ticketCategoryIds.length === 0)
    )
      ctx.addIssue({
        code: "custom",
        message: "Ticket observation requires one to ten distinct Discord category IDs.",
      });
    const canaryIds = config.DISCORD_FREE_MEMBER_CANARY_IDS;
    if (
      canaryIds.length > 2 ||
      canaryIds.some((id) => !snowflake.safeParse(id).success ||
        id === config.DISCORD_CLIENT_ID || id === config.DISCORD_GUILD_ID) ||
      new Set(canaryIds).size !== canaryIds.length ||
      (config.DISCORD_FREE_MEMBER_ROLLOUT_MODE === "canary" && canaryIds.length === 0) ||
      (config.DISCORD_FREE_MEMBER_ROLLOUT_MODE !== "canary" && canaryIds.length !== 0)
    )
      ctx.addIssue({
        code: "custom",
        message: "Canary requires one or two distinct human test account IDs; other modes forbid canary IDs.",
      });
    if (
      config.DISCORD_ENVIRONMENT === "production" &&
      config.DISCORD_WRITES_ENABLED &&
      (config.DISCORD_FREE_MEMBER_ROLLOUT_MODE === "disabled" ||
        (config.DISCORD_FREE_MEMBER_ROLLOUT_MODE === "all" &&
          (!config.DISCORD_FREE_MEMBER_ALL_APPROVAL_REFERENCE ||
            [config.DISCORD_APPROVAL_REFERENCE, config.DISCORD_FREE_MEMBER_APPROVAL_REFERENCE].includes(
              config.DISCORD_FREE_MEMBER_ALL_APPROVAL_REFERENCE,
            ))))
    )
      ctx.addIssue({
        code: "custom",
        message: "Production writes require a restricted canary or a separate, documented approval for all members.",
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
    if (
      config.DISCORD_ENVIRONMENT === "production" &&
      (!config.DISCORD_OWNER_APPROVED ||
        !config.DISCORD_APPROVAL_REFERENCE ||
        !config.DISCORD_GUILD_OWNER_ID ||
        config.DISCORD_PRODUCTION_GUILD_ID !== config.DISCORD_GUILD_ID ||
        config.DISCORD_TEST_GUILD_ID ||
        config.DISCORD_GUILD_ID === "100000000000000001" ||
        config.DISCORD_ADAPTER !== "rest" ||
        !config.DISCORD_NETWORK_ENABLED ||
        config.DISCORD_PRODUCTION_VIP_WRITES_ENABLED ||
        config.DISCORD_VIP_SYNC_ENABLED ||
        config.DISCORD_COMMANDS_ENABLED ||
        config.DISCORD_OAUTH_REDIRECT_URI !==
          "https://bot.timonconfigs.com/api/discord/callback" ||
        !config.DISCORD_INTERACTIONS_PUBLIC_KEY ||
        (config.DISCORD_WRITES_ENABLED &&
          (!config.DISCORD_VERIFICATION_ENABLED ||
            !config.DISCORD_FREE_MEMBER_WRITES_APPROVED ||
            !config.DISCORD_FREE_MEMBER_APPROVAL_REFERENCE ||
            config.DISCORD_FREE_MEMBER_APPROVAL_REFERENCE ===
              config.DISCORD_APPROVAL_REFERENCE)))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Production requires exact guild/owner approval, HTTPS identity, disabled VIP/command writes and separate Free Member approval.",
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
  if (env.NODE_ENV === "production" && env.DISCORD_ENVIRONMENT !== "production")
    throw new Error(
      "NODE_ENV production requires the explicit production Discord configuration.",
    );
  const normalized = { ...env };
  for (const key of [
    "DISCORD_TEST_GUILD_ID",
    "DISCORD_PRODUCTION_GUILD_ID",
    "DISCORD_FREE_MEMBER_APPROVAL_REFERENCE",
    "DISCORD_FREE_MEMBER_ALL_APPROVAL_REFERENCE",
    "DISCORD_GUILD_OWNER_ID",
    "DISCORD_APPROVAL_REFERENCE",
  ])
    if (normalized[key] === "") delete normalized[key];
  const config = schema.parse(normalized);
  if (
    config.DISCORD_ENVIRONMENT === "production" &&
    env.NODE_ENV !== "production"
  )
    throw new Error("Production Discord requires NODE_ENV=production.");
  return config;
}
