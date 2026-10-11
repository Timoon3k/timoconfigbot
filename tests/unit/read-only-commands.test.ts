import { describe, expect, it, vi } from "vitest";
import { loadDiscordConfig } from "../../src/discord/config.js";
import { ApprovedDiscordHttpsTransport, PostgresDiscordRateGate } from "../../src/discord/transport.js";

const approved = {
  NODE_ENV: "production",
  DISCORD_ENVIRONMENT: "production",
  DISCORD_PRODUCTION_GUILD_ID: "900000000000000001",
  DISCORD_GUILD_ID: "900000000000000001",
  DISCORD_GUILD_OWNER_ID: "100000000000000099",
  DISCORD_OWNER_APPROVED: "true",
  DISCORD_APPROVAL_REFERENCE: "approved-network-only",
  DISCORD_ADAPTER: "rest",
  DISCORD_NETWORK_ENABLED: "true",
  DISCORD_VIP_SYNC_ENABLED: "false",
  DISCORD_INTERACTIONS_PUBLIC_KEY: "a".repeat(64),
  DISCORD_OAUTH_REDIRECT_URI: "https://bot.timonconfigs.com/api/discord/callback",
  DISCORD_READONLY_COMMANDS_ENABLED: "true",
  DISCORD_READONLY_COMMAND_REGISTRATION_APPROVED: "true",
  DISCORD_READONLY_COMMAND_APPROVAL_REFERENCE: "independent-readonly-approval",
};

describe("production slash command transport boundary (network mocked)", () => {
  it("can PUT only application command definitions while all role writes remain disabled", async () => {
    const config = loadDiscordConfig(approved);
    const gate = {
      reserve: vi.fn().mockResolvedValue(0),
      defer: vi.fn().mockResolvedValue(undefined),
    } as unknown as PostgresDiscordRateGate;
    const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const transport = new ApprovedDiscordHttpsTransport(config, gate);
      const commandPath = `/api/v10/applications/${config.DISCORD_CLIENT_ID}/guilds/${config.DISCORD_GUILD_ID}/commands`;
      const result = await transport.request(commandPath, {
        method: "PUT",
        headers: { Authorization: "Bot fixture-token", "Content-Type": "application/json" },
        body: "[]",
      });
      expect(result.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await expect(transport.request(
        `/api/v10/guilds/${config.DISCORD_GUILD_ID}/members/200000000000000001/roles/${config.DISCORD_VIP_MONTHLY_ROLE_ID}`,
        { method: "PUT", headers: { Authorization: "Bot fixture-token" } },
      )).rejects.toThrow();
      await expect(transport.request(
        commandPath,
        { method: "DELETE", headers: { Authorization: "Bot fixture-token" } },
      )).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects production command registration without dedicated approval", async () => {
    const config = loadDiscordConfig({
      ...approved,
      DISCORD_READONLY_COMMANDS_ENABLED: "false",
      DISCORD_READONLY_COMMAND_REGISTRATION_APPROVED: "false",
      DISCORD_READONLY_COMMAND_APPROVAL_REFERENCE: "",
    });
    const gate = { reserve: vi.fn() } as unknown as PostgresDiscordRateGate;
    const transport = new ApprovedDiscordHttpsTransport(config, gate);
    await expect(transport.request(
      `/api/v10/applications/${config.DISCORD_CLIENT_ID}/guilds/${config.DISCORD_GUILD_ID}/commands`,
      { method: "PUT", headers: { Authorization: "Bot fixture-token" } },
    )).rejects.toThrow();
    expect((gate.reserve as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
