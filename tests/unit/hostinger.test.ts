import { describe, expect, it, vi } from "vitest";
import { loadDiscordConfig } from "../../src/discord/config.js";
import {
  assertTestGuildNetwork,
  assertTestGuildWrites,
  RestDiscordAdapter,
} from "../../src/discord/rest.js";
import { databasePoolOptions } from "../../src/db/pool.js";
import { mockGuild } from "../../src/discord/adapters.js";
import { verifyGuild } from "../../src/discord/policy.js";
const production = {
  NODE_ENV: "production",
  DISCORD_ENVIRONMENT: "production",
  DISCORD_PRODUCTION_GUILD_ID: "900000000000000001",
  DISCORD_GUILD_ID: "900000000000000001",
  DISCORD_GUILD_OWNER_ID: "100000000000000099",
  DISCORD_OWNER_APPROVED: "true",
  DISCORD_APPROVAL_REFERENCE: "read-only-owner-approval",
  DISCORD_ADAPTER: "rest",
  DISCORD_NETWORK_ENABLED: "true",
  DISCORD_VIP_SYNC_ENABLED: "false",
  DISCORD_OAUTH_REDIRECT_URI:
    "https://bot.timonconfigs.com/api/discord/callback",
  DISCORD_INTERACTIONS_PUBLIC_KEY: "a".repeat(64),
};
describe("production deployment gates", () => {
  it("starts with explicit production identity and read-only defaults", () => {
    const c = loadDiscordConfig(production);
    expect(c.DISCORD_DRY_RUN).toBe(true);
    expect(c.DISCORD_WRITES_ENABLED).toBe(false);
    expect(() => assertTestGuildNetwork(c)).not.toThrow();
    expect(() =>
      assertTestGuildWrites(c, c.DISCORD_FREE_MEMBER_ROLE_ID),
    ).toThrow();
  });
  it.each([
    { DISCORD_PRODUCTION_GUILD_ID: "900000000000000009" },
    { DISCORD_OWNER_APPROVED: "false" },
    { DISCORD_VIP_SYNC_ENABLED: "true" },
    { DISCORD_COMMANDS_ENABLED: "true" },
    { DISCORD_PRODUCTION_VIP_WRITES_ENABLED: "true" },
    { DISCORD_TEST_GUILD_ID: "900000000000000001" },
    { DISCORD_WRITES_ENABLED: "true", DISCORD_DRY_RUN: "false" },
    { NODE_ENV: "development" },
  ])("fails closed for unsafe production configuration %j", (override) => {
    expect(() => loadDiscordConfig({ ...production, ...override })).toThrow();
  });
  it("requires a distinct second approval for Free Member and always blocks VIP mutation", async () => {
    const c = loadDiscordConfig({
      ...production,
      DISCORD_WRITES_ENABLED: "true",
      DISCORD_DRY_RUN: "false",
      DISCORD_VERIFICATION_ENABLED: "true",
      DISCORD_FREE_MEMBER_WRITES_APPROVED: "true",
      DISCORD_FREE_MEMBER_APPROVAL_REFERENCE: "separate-free-member-approval",
    });
    expect(() =>
      assertTestGuildWrites(c, c.DISCORD_FREE_MEMBER_ROLE_ID),
    ).not.toThrow();
    expect(() =>
      assertTestGuildWrites(c, c.DISCORD_VIP_MONTHLY_ROLE_ID),
    ).toThrow();
    expect(() =>
      assertTestGuildWrites(c, c.DISCORD_VIP_LIFETIME_ROLE_ID),
    ).toThrow();
    const request = vi.fn();
    const adapter = new RestDiscordAdapter(c, "fixture", { request });
    await expect(
      adapter.addRole("200000000000000001", c.DISCORD_VIP_MONTHLY_ROLE_ID),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(() =>
      loadDiscordConfig({
        ...production,
        DISCORD_WRITES_ENABLED: "true",
        DISCORD_DRY_RUN: "false",
        DISCORD_VERIFICATION_ENABLED: "true",
        DISCORD_FREE_MEMBER_WRITES_APPROVED: "true",
        DISCORD_FREE_MEMBER_APPROVAL_REFERENCE:
          production.DISCORD_APPROVAL_REFERENCE,
      }),
    ).toThrow();
  });
  it("verifies both actual production guild and owner", () => {
    const c = loadDiscordConfig(production);
    const guild = mockGuild(c);
    expect(() => verifyGuild(c, guild)).not.toThrow();
    guild.ownerId = "200000000000000001";
    expect(() => verifyGuild(c, guild)).toThrow();
    guild.ownerId = c.DISCORD_GUILD_OWNER_ID!;
    guild.id = "900000000000000009";
    expect(() => verifyGuild(c, guild)).toThrow();
  });
});
describe("Supabase pool contract", () => {
  const url =
    "postgresql://fixture:fixture@aws-region.pooler.supabase.com:5432/postgres";
  it("requires direct/session pooling and verified TLS", () => {
    const c = databasePoolOptions(url, {
      NODE_ENV: "production",
      DB_CONNECTION_MODE: "session",
    });
    expect(c.ssl).toEqual({ rejectUnauthorized: true });
    expect(c.max).toBe(5);
    expect(() =>
      databasePoolOptions(url, { DB_CONNECTION_MODE: "transaction" }),
    ).toThrow();
    expect(() =>
      databasePoolOptions(url.replace(":5432", ":6543"), {
        DB_CONNECTION_MODE: "session",
      }),
    ).toThrow();
    expect(() =>
      databasePoolOptions(url, {
        NODE_ENV: "production",
        DB_SSL_MODE: "disable",
      }),
    ).toThrow();
  });
  it("accepts trusted CA in single-line Base64 without disabling certificate verification", () => {
    const ca = "-----BEGIN CERTIFICATE-----\\nZml4dHVyZQ==\\n-----END CERTIFICATE-----\\n".replace(/\\n/g, "\n");
    const encoded = Buffer.from(ca, "utf8").toString("base64");
    const options = databasePoolOptions(url, {
      NODE_ENV: "production",
      DB_CONNECTION_MODE: "session",
      DB_CA_CERT_BASE64: encoded,
    });
    expect(options.ssl).toEqual({ rejectUnauthorized: true, ca });
    expect(() =>
      databasePoolOptions(url, { DB_CA_CERT_BASE64: "not-a-certificate" }),
    ).toThrow();
    expect(() =>
      databasePoolOptions(url, { DB_CA_CERT_BASE64: encoded, DB_CA_CERT: ca }),
    ).toThrow();
  });
  it("does not let URL options override certificate verification", () => {
    const c = databasePoolOptions(url + "?sslmode=require", {
      DB_SSL_MODE: "require",
    });
    expect(c.connectionString).not.toContain("sslmode");
    expect(c.ssl).toEqual({ rejectUnauthorized: true });
    expect(() =>
      databasePoolOptions(url + "?sslmode=disable", { DB_SSL_MODE: "require" }),
    ).toThrow();
    expect(() => databasePoolOptions(url, { DB_POOL_MAX: "2" })).toThrow();
  });
});
