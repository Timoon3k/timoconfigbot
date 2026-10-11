import { z } from "zod";
import { snowflake, type DiscordConfig } from "../discord/config.js";

const flag = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");
const text = z.preprocess(
  (v) => (typeof v === "string" && !v.trim() ? undefined : v),
  z.string().trim().min(1).optional(),
);
const schema = z.object({
  STRIPE_MODE: z.enum(["test", "live"]).default("test"),
  STRIPE_CHECKOUT_ENABLED: flag,
  STRIPE_WEBHOOKS_ENABLED: flag,
  STRIPE_PORTAL_ENABLED: flag,
  STRIPE_LIVE_PAYMENTS_ENABLED: flag,
  STRIPE_MERCHANT_APPROVAL_REFERENCE: text,
  STRIPE_ACCOUNT_ID: text,
  STRIPE_SECRET_KEY: text,
  STRIPE_WEBHOOK_SECRET: text,
  STRIPE_VIP_MONTHLY_PRICE_ID: text,
  STRIPE_VIP_LIFETIME_PRICE_ID: text,
  STRIPE_PORTAL_CONFIGURATION_ID: text,
  STRIPE_PAYPAL_ENABLED: flag,
  STRIPE_PAYPAL_APPROVAL_REFERENCE: text,
  PUBLIC_BILLING_BASE_URL: text,
  BILLING_ALLOWED_ORIGINS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  BILLING_TERMS_URL: text,
  BILLING_PRIVACY_URL: text,
  BILLING_REFUND_POLICY_URL: text,
  BILLING_LIFETIME_TERMS_URL: text,
  BILLING_LEGAL_REVISION: text,
  DISCORD_BILLING_VIP_WRITES_ENABLED: flag,
  DISCORD_BILLING_VIP_APPROVAL_REFERENCE: text,
  DISCORD_BILLING_VIP_CANARY_IDS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
});
export type BillingConfig = z.infer<typeof schema>;

export function approvedUrl(value: string, origins: string[]): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !origins.includes(url.origin)
  )
    throw new Error("Billing URL is not approved.");
  return url.toString();
}
export function loadBillingConfig(
  env: NodeJS.ProcessEnv = process.env,
): BillingConfig {
  // Never include Zod input values in startup errors (they may contain credentials).
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error("Invalid billing configuration.");
  const c = parsed.data;
  const enabled =
    c.STRIPE_CHECKOUT_ENABLED ||
    c.STRIPE_WEBHOOKS_ENABLED ||
    c.STRIPE_PORTAL_ENABLED;
  if (
    enabled &&
    (!c.STRIPE_ACCOUNT_ID?.match(/^acct_[A-Za-z0-9]+$/) ||
      !c.STRIPE_SECRET_KEY?.startsWith(
        c.STRIPE_MODE === "test" ? "sk_test_" : "sk_live_",
      ))
  )
    throw new Error("Stripe mode, account and secret key must be configured.");
  if (
    enabled &&
    c.STRIPE_MODE === "live" &&
    (!c.STRIPE_LIVE_PAYMENTS_ENABLED || !c.STRIPE_MERCHANT_APPROVAL_REFERENCE)
  )
    throw new Error("Live Stripe requires separate merchant approval.");
  if (
    c.STRIPE_WEBHOOKS_ENABLED &&
    !c.STRIPE_WEBHOOK_SECRET?.startsWith("whsec_")
  )
    throw new Error("Stripe webhook secret is required.");
  if (
    c.STRIPE_CHECKOUT_ENABLED &&
    (!c.STRIPE_WEBHOOKS_ENABLED ||
      !c.STRIPE_VIP_MONTHLY_PRICE_ID?.match(/^price_[A-Za-z0-9]+$/) ||
      !c.STRIPE_VIP_LIFETIME_PRICE_ID?.match(/^price_[A-Za-z0-9]+$/) ||
      c.STRIPE_VIP_MONTHLY_PRICE_ID === c.STRIPE_VIP_LIFETIME_PRICE_ID ||
      !c.BILLING_LEGAL_REVISION)
  )
    throw new Error(
      "Checkout requires webhooks, distinct prices and legal revision.",
    );
  if (c.STRIPE_CHECKOUT_ENABLED || c.STRIPE_PORTAL_ENABLED) {
    for (const value of [
      c.PUBLIC_BILLING_BASE_URL,
      c.BILLING_TERMS_URL,
      c.BILLING_PRIVACY_URL,
      c.BILLING_REFUND_POLICY_URL,
      c.BILLING_LIFETIME_TERMS_URL,
    ]) {
      if (!value)
        throw new Error("Reviewed public billing and legal URLs are required.");
      approvedUrl(value, c.BILLING_ALLOWED_ORIGINS);
    }
    const base = new URL(c.PUBLIC_BILLING_BASE_URL!);
    if (base.pathname !== "/" || base.search)
      throw new Error("Billing base must be an HTTPS origin.");
  }
  if (
    c.STRIPE_PORTAL_ENABLED &&
    !c.STRIPE_PORTAL_CONFIGURATION_ID?.match(/^bpc_[A-Za-z0-9]+$/)
  )
    throw new Error(
      "A reviewed cancellation-only Stripe Portal configuration is required.",
    );
  if (c.STRIPE_PAYPAL_ENABLED && !c.STRIPE_PAYPAL_APPROVAL_REFERENCE)
    throw new Error("PayPal requires confirmed Stripe eligibility.");
  for (const id of c.DISCORD_BILLING_VIP_CANARY_IDS) snowflake.parse(id);
  if (
    c.DISCORD_BILLING_VIP_WRITES_ENABLED &&
    (!c.DISCORD_BILLING_VIP_APPROVAL_REFERENCE ||
      c.DISCORD_BILLING_VIP_CANARY_IDS.length < 1 ||
      c.DISCORD_BILLING_VIP_CANARY_IDS.length > 2 ||
      new Set(c.DISCORD_BILLING_VIP_CANARY_IDS).size !==
        c.DISCORD_BILLING_VIP_CANARY_IDS.length)
  )
    throw new Error(
      "Paid VIP writes require separate approval and 1–2 canary IDs.",
    );
  return c;
}
export function assertPaidRolePolicy(
  c: BillingConfig,
  d: DiscordConfig,
  memberId: string,
  roleId: string,
): void {
  if (
    !c.DISCORD_BILLING_VIP_WRITES_ENABLED ||
    !c.DISCORD_BILLING_VIP_APPROVAL_REFERENCE ||
    [
      d.DISCORD_APPROVAL_REFERENCE,
      d.DISCORD_FREE_MEMBER_APPROVAL_REFERENCE,
      d.TICKET_TOOL_WELCOME_APPROVAL_REFERENCE,
    ].includes(c.DISCORD_BILLING_VIP_APPROVAL_REFERENCE) ||
    !c.DISCORD_BILLING_VIP_CANARY_IDS.includes(memberId) ||
    ![d.DISCORD_VIP_MONTHLY_ROLE_ID, d.DISCORD_VIP_LIFETIME_ROLE_ID].includes(
      roleId,
    ) ||
    [
      d.DISCORD_FREE_MEMBER_ROLE_ID,
      d.DISCORD_STAFF_ROLE_ID,
      d.DISCORD_FOUNDER_ROLE_ID,
    ].includes(roleId) ||
    (d.DISCORD_ENVIRONMENT === "production" &&
      (c.STRIPE_MODE !== "live" ||
        !c.STRIPE_LIVE_PAYMENTS_ENABLED ||
        !c.STRIPE_MERCHANT_APPROVAL_REFERENCE))
  )
    throw new Error("Paid VIP mutation is not approved.");
}
