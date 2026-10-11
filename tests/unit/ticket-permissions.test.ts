import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { loadDiscordConfig } from "../../src/discord/config.js";
import {
  ApprovedDiscordHttpsTransport,
  type PostgresDiscordRateGate,
} from "../../src/discord/transport.js";
import {
  DiscordCommands,
  verifiedInteraction,
} from "../../src/discord/commands.js";
import type { DatabasePool } from "../../src/db/pool.js";
import type { MembershipService } from "../../src/membership/service.js";
import { DiscordWorker } from "../../src/discord/worker.js";
import type { DiscordSyncService } from "../../src/discord/sync.js";
import type { MemberVerification } from "../../src/discord/verification.js";
import type { TicketService } from "../../src/tickets/service.js";
import { TicketRest, welcomePanel } from "../../src/tickets/rest.js";
import {
  auditTicketPermissions,
  assertApprovedRepair,
  applyPermissionCorrections,
} from "../../src/tickets/permission-audit.js";
import {
  assertPrivateTicket,
  channelPermissions,
  botOverwriteCorrection,
  VIEW,
  SEND,
  REQUIRED,
  MANAGE_ROLES,
} from "../../src/tickets/permissions.js";
import {
  ticketFixture,
  ticketId,
  panelId,
  customerId,
  messageId,
  supportCategory,
} from "../ticket-fixture.js";

describe("VIP private ticket permissions", () => {
  it("audits real-shaped snapshots without sending writes; customer panel remains visible", async () => {
    const f = ticketFixture();
    const audit = await auditTicketPermissions(f.config, f.rest, {
      ticketChannelId: ticketId,
      panelChannelId: panelId,
    });
    expect(audit.ticketPrivacyError).toBeNull();
    expect(audit.panel.freeMemberVisible).toBe(true);
    expect(audit.staffTicketVisible).toBe(true);
    expect(audit.hierarchy.every((r) => r.correct)).toBe(true);
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
  });
  it("calculates everyone, aggregated roles and final member overwrites", () => {
    const f = ticketFixture();
    const customer = f.members.get(customerId)!;
    expect(channelPermissions(f.channel, f.roles, customer) & REQUIRED).toBe(
      REQUIRED,
    );
    expect(
      channelPermissions(f.channel, f.roles, {
        ...customer,
        user: { id: "200000000000000099" },
      }) & VIEW,
    ).toBe(0n);
    f.channel.permission_overwrites.find((o) => o.id === customerId)!.deny =
      SEND.toString();
    f.channel.permission_overwrites.find((o) => o.id === customerId)!.allow =
      VIEW.toString();
    expect(channelPermissions(f.channel, f.roles, customer) & SEND).toBe(0n);
  });
  it.each([
    "everyone",
    "free",
    "vip",
    "unknown-role",
    "support",
    "multiple-members",
  ])("fails closed for %s exposure", async (kind) => {
    const f = ticketFixture();
    if (kind === "everyone") f.channel.permission_overwrites = [];
    else if (kind === "support") f.channel.parent_id = supportCategory;
    else if (kind === "multiple-members")
      f.channel.permission_overwrites.push({
        id: "200000000000000099",
        type: 1,
        allow: VIEW.toString(),
        deny: "0",
      });
    else
      f.channel.permission_overwrites.push({
        id:
          kind === "free"
            ? f.config.DISCORD_FREE_MEMBER_ROLE_ID
            : kind === "vip"
              ? f.config.DISCORD_VIP_MONTHLY_ROLE_ID
              : "200000000000000099",
        type: 0,
        allow: VIEW.toString(),
        deny: "0",
      });
    expect(() =>
      assertPrivateTicket(
        f.config,
        f.channel,
        f.roles,
        f.members.get(f.config.DISCORD_CLIENT_ID)!,
        f.members.get(f.config.TICKET_TOOL_BOT_ID!)!,
      ),
    ).toThrow();
    await expect(f.rest.publish(ticketId, "fixture-nonce")).rejects.toThrow();
    expect(f.calls.some((c) => c.method === "POST")).toBe(false);
  });
  it("proposes only a bot-specific overwrite and refuses repairs without legal permissions", () => {
    const f = ticketFixture();
    const own = f.channel.permission_overwrites.find(
      (o) => o.id === f.config.DISCORD_CLIENT_ID,
    )!;
    own.allow = VIEW.toString();
    own.deny = SEND.toString();
    const others = structuredClone(f.channel.permission_overwrites);
    const correction = botOverwriteCorrection(
      f.config,
      f.channel,
      f.roles,
      f.members.get(f.config.DISCORD_CLIENT_ID)!,
    );
    expect(correction.after.id).toBe(f.config.DISCORD_CLIENT_ID);
    expect(correction.after.allow).toBe(REQUIRED.toString());
    expect(correction.after.deny).toBe("0");
    expect(correction.canApply).toBe(true);
    expect(f.channel.permission_overwrites).toEqual(others);
    f.roles.find((r) => r.name === "TimonConfigs")!.permissions =
      REQUIRED.toString();
    expect(
      botOverwriteCorrection(
        f.config,
        f.channel,
        f.roles,
        f.members.get(f.config.DISCORD_CLIENT_ID)!,
      ).canApply,
    ).toBe(false);
    f.roles.find((r) => r.name === "TimonConfigs")!.permissions = (
      MANAGE_ROLES | VIEW
    ).toString();
    f.roles.find((r) => r.id === f.config.DISCORD_GUILD_ID)!.permissions = "0";
    expect(
      botOverwriteCorrection(
        f.config,
        f.channel,
        f.roles,
        f.members.get(f.config.DISCORD_CLIENT_ID)!,
      ).canApply,
    ).toBe(false);
    expect(() =>
      botOverwriteCorrection(
        f.config,
        f.channels.get(supportCategory)!,
        f.roles,
        f.members.get(f.config.DISCORD_CLIENT_ID)!,
      ),
    ).toThrow();
  });
  it("requires a distinct approval and an unchanged plan before apply", async () => {
    const f = ticketFixture();
    const audit = await auditTicketPermissions(f.config, f.rest, {
      ticketChannelId: ticketId,
      panelChannelId: panelId,
    });
    expect(() => assertApprovedRepair(f.config, audit, audit, "")).toThrow();
    expect(() =>
      assertApprovedRepair(
        f.config,
        audit,
        audit,
        f.config.DISCORD_APPROVAL_REFERENCE!,
      ),
    ).toThrow();
    expect(() =>
      assertApprovedRepair(
        f.config,
        audit,
        { ...audit, fingerprint: "changed" },
        "fixture-repair-approval",
      ),
    ).toThrow();
    expect(() =>
      assertApprovedRepair(f.config, audit, audit, "fixture-repair-approval"),
    ).not.toThrow();
  });
  it("blocks message sending with missing permissions and by default", async () => {
    const f = ticketFixture();
    f.channel.permission_overwrites.find(
      (o) => o.id === f.config.DISCORD_CLIENT_ID,
    )!.allow = VIEW.toString();
    // Explicit deny overrides the base SEND permission.
    f.channel.permission_overwrites.find(
      (o) => o.id === f.config.DISCORD_CLIENT_ID,
    )!.deny = SEND.toString();
    await expect(
      f.rest.publish(ticketId, "fixture-nonce"),
    ).rejects.toMatchObject({ code: "TICKET_MESSAGE_PERMISSIONS_MISSING" });
    const disabled = ticketFixture({
      TICKET_TOOL_WELCOME_WRITES_ENABLED: "false",
      TICKET_TOOL_SELECTIONS_ENABLED: "false",
    });
    await expect(
      disabled.rest.publish(ticketId, "fixture-nonce"),
    ).rejects.toMatchObject({ code: "TICKET_MESSAGES_NOT_APPROVED" });
    expect(disabled.calls).toEqual([]);
    expect(loadDiscordConfig({}).TICKET_TOOL_WELCOME_WRITES_ENABLED).toBe(
      false,
    );
    expect(loadDiscordConfig({}).TICKET_TOOL_SELECTIONS_ENABLED).toBe(false);
  });
  it("has exact English products and buttons with no checkout or mentions", () => {
    const panel = welcomePanel();
    expect(panel.embeds[0]?.title).toBe("TimonConfigs VIP Membership");
    expect(panel.components[0]?.components.map((b) => b.label)).toEqual([
      "Select Monthly",
      "Select Lifetime",
    ]);
    expect(JSON.stringify(panel)).not.toContain("https:");
    expect(panel.allowed_mentions.parse).toEqual([]);
  });
  it("applies only the approved bot overwrite and verifies it over REST", async () => {
    const f = ticketFixture();
    const own = f.channel.permission_overwrites.find(
      (o) => o.id === f.config.DISCORD_CLIENT_ID,
    )!;
    own.allow = VIEW.toString();
    own.deny = SEND.toString();
    const unrelated = structuredClone(
      f.channel.permission_overwrites.filter(
        (o) => o.id !== f.config.DISCORD_CLIENT_ID,
      ),
    );
    const audit = await auditTicketPermissions(f.config, f.rest, {
      ticketChannelId: ticketId,
      panelChannelId: panelId,
    });
    const log = vi.fn(async () => {});
    await expect(
      applyPermissionCorrections(f.config, f.rest, audit, audit, "", log),
    ).rejects.toThrow();
    expect(f.calls.some((c) => c.method === "PUT")).toBe(false);
    await applyPermissionCorrections(
      f.config,
      f.rest,
      audit,
      audit,
      "fixture-repair-approval",
      log,
    );
    expect(f.calls.filter((c) => c.method === "PUT")).toEqual([
      {
        path: `/api/v10/channels/${ticketId}/permissions/${f.config.DISCORD_CLIENT_ID}`,
        method: "PUT",
      },
    ]);
    expect(
      f.channel.permission_overwrites.filter(
        (o) => o.id !== f.config.DISCORD_CLIENT_ID,
      ),
    ).toEqual(unrelated);
    expect(log.mock.calls).toHaveLength(2);
    expect(
      channelPermissions(
        f.channel,
        f.roles,
        f.members.get(f.config.DISCORD_CLIENT_ID)!,
      ) & REQUIRED,
    ).toBe(REQUIRED);
  });
  it("rejects unknown production modifications before any network request", async () => {
    const f = ticketFixture();
    const reserve = vi.fn();
    const transport = new ApprovedDiscordHttpsTransport(f.config, {
      reserve,
    } as unknown as PostgresDiscordRateGate);
    await expect(
      transport.request(
        `/api/v10/channels/${ticketId}/permissions/${customerId}`,
        { method: "PUT", headers: {} },
      ),
    ).rejects.toThrow();
    await expect(
      transport.request(`/api/v10/channels/${ticketId}`, {
        method: "PATCH",
        headers: {},
      }),
    ).rejects.toThrow();
    expect(reserve).not.toHaveBeenCalled();
    const request = vi.fn();
    const disabled = ticketFixture({
      TICKET_TOOL_WELCOME_WRITES_ENABLED: "false",
      TICKET_TOOL_SELECTIONS_ENABLED: "false",
    });
    await expect(
      new TicketRest(disabled.config, "fixture", { request }).publish(
        ticketId,
        "nonce",
      ),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("rejects a direct message POST to Support at the HTTPS transport boundary", async () => {
    const f = ticketFixture();
    f.channel.parent_id = supportCategory;
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(f.channel));
    const transport = new ApprovedDiscordHttpsTransport(f.config, {
      reserve: async () => 0,
      defer: async () => {},
    } as unknown as PostgresDiscordRateGate);
    await expect(
      transport.request(`/api/v10/channels/${ticketId}/messages`, {
        method: "POST",
        headers: { Authorization: "Bot fixture" },
        body: "{}",
      }),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");
  });
  it("continues Free Member processing and heartbeat when the ticket queue fails", async () => {
    const f = ticketFixture();
    const sync = {
      config: f.config,
      pool: { query: vi.fn(async () => ({ rows: [] })) },
      reconcileBatch: vi.fn(),
      runOne: vi.fn(async () => false),
    } as unknown as DiscordSyncService;
    const runOne = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const verification = {
      reconcileBatch: vi.fn(),
      runOne,
    } as unknown as MemberVerification;
    const tickets = {
      reconcileBatch: vi.fn(async () => {
        throw new Error("fixture failure");
      }),
    } as unknown as TicketService;
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const worker = new DiscordWorker(sync, verification, tickets);
    expect(await worker.tick()).toBe(1);
    expect(worker.lastCompletedAt).not.toBeNull();
    await worker.tick();
    expect(runOne.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("Signed VIP buttons", () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("hex");
  const timestamp = String(Math.floor(Date.now() / 1000));
  it("binds the clicking member from the signed interaction, never from the channel name", async () => {
    const f = ticketFixture();
    const handleTicket = vi.fn(async () => ({ type: 4 }));
    const payload = Buffer.from(
      JSON.stringify({
        id: "200000000000000030",
        type: 3,
        application_id: f.config.DISCORD_CLIENT_ID,
        guild_id: f.config.DISCORD_GUILD_ID,
        channel_id: ticketId,
        member: { user: { id: customerId } },
        message: { id: messageId, author: { id: f.config.DISCORD_CLIENT_ID } },
        data: { custom_id: "tc:vip:monthly:v1" },
      }),
    );
    const signature = sign(
      null,
      Buffer.concat([Buffer.from(timestamp), payload]),
      keys.privateKey,
    ).toString("hex");
    const commands = { handleTicket } as unknown as DiscordCommands;
    await verifiedInteraction(
      payload,
      signature,
      timestamp,
      publicKey,
      commands,
      f.config.DISCORD_CLIENT_ID,
    );
    expect(handleTicket).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: customerId, channelId: ticketId }),
    );
    await expect(
      verifiedInteraction(
        Buffer.from(payload.toString() + " "),
        signature,
        timestamp,
        publicKey,
        commands,
        f.config.DISCORD_CLIENT_ID,
      ),
    ).rejects.toThrow();
    await expect(
      verifiedInteraction(
        payload,
        signature,
        timestamp,
        publicKey,
        commands,
        "200000000000000099",
      ),
    ).rejects.toThrow();
  });
  it("answers ephemerally before three seconds when the dependency stalls", async () => {
    vi.useFakeTimers();
    try {
      const f = ticketFixture();
      const tickets = {
        select: () => new Promise(() => {}),
      } as unknown as TicketService;
      const commands = new DiscordCommands(
        {} as DatabasePool,
        {} as MembershipService,
        f.config,
        tickets,
      );
      const result = commands.handleTicket({
        interactionId: "200000000000000030",
        guildId: f.config.DISCORD_GUILD_ID,
        channelId: ticketId,
        memberId: customerId,
        messageId,
        customId: "tc:vip:monthly:v1",
      });
      await vi.advanceTimersByTimeAsync(1800);
      expect(await result).toMatchObject({ type: 4, data: { flags: 64 } });
    } finally {
      vi.useRealTimers();
    }
  });
});
