import { createHash } from "node:crypto";
import { z } from "zod";
import type { DiscordConfig } from "../discord/config.js";
import { DiscordFailure } from "../discord/types.js";
import {
  channelSchema,
  roleSchema,
  memberSchema,
  channelPermissions,
  guildPermissions,
  botOverwriteCorrection,
  assertPrivateTicket,
  missingPermissions,
  VIEW,
  MANAGE_ROLES,
} from "./permissions.js";
import type { TicketRest } from "./rest.js";

export type AuditInput = { ticketChannelId: string; panelChannelId: string };
export async function auditTicketPermissions(
  config: DiscordConfig,
  rest: TicketRest,
  input: AuditInput,
) {
  const guild = z
    .object({ id: z.string(), owner_id: z.string() })
    .parse(await rest.request(`/api/v10/guilds/${config.DISCORD_GUILD_ID}`));
  if (
    guild.id !== config.DISCORD_GUILD_ID ||
    guild.owner_id !== config.DISCORD_GUILD_OWNER_ID
  )
    throw new DiscordFailure("GUILD_IDENTITY_MISMATCH");
  if (
    !config.TICKET_TOOL_BOT_ID ||
    config.TICKET_TOOL_DISCORD_CATEGORY_IDS.length !== 1
  )
    throw new DiscordFailure("TICKET_AUDIT_CONFIG_REQUIRED");
  const roles = z
    .array(roleSchema)
    .parse(await rest.request(`/api/v10/guilds/${guild.id}/roles`));
  const bot = memberSchema.parse(await rest.member(config.DISCORD_CLIENT_ID));
  const ticketTool = memberSchema.parse(
    await rest.member(config.TICKET_TOOL_BOT_ID),
  );
  if (!ticketTool.user.bot || !bot.user.bot || guild.owner_id === bot.user.id)
    throw new DiscordFailure("BOT_IDENTITY_INVALID");
  const get = async (id: string) => {
    const channel = channelSchema.parse(
      await rest.request(`/api/v10/channels/${id}`),
    );
    if (channel.id !== id || channel.guild_id !== guild.id)
      throw new DiscordFailure("CHANNEL_IDENTITY_MISMATCH");
    return channel;
  };
  const category = await get(config.TICKET_TOOL_DISCORD_CATEGORY_IDS[0]!);
  const support = await get(config.TICKET_TOOL_SUPPORT_DISCORD_CATEGORY_ID!);
  const ticket = await get(input.ticketChannelId);
  const panel = await get(input.panelChannelId);
  if (
    category.type !== 4 ||
    support.type !== 4 ||
    panel.type !== 0 ||
    panel.id === ticket.id
  )
    throw new DiscordFailure("TICKET_AUDIT_TARGET_INVALID");
  let privacyError: string | null = null;
  try {
    assertPrivateTicket(config, ticket, roles, bot, ticketTool);
  } catch (error) {
    privacyError =
      error instanceof DiscordFailure ? error.code : "TICKET_PRIVACY_INVALID";
  }
  const corrections = [category, ticket].map((channel) =>
    botOverwriteCorrection(config, channel, roles, bot),
  );
  const highest = Math.max(
    ...roles.filter((r) => bot.roles.includes(r.id)).map((r) => r.position),
  );
  const hierarchy = [
    config.DISCORD_VIP_MONTHLY_ROLE_ID,
    config.DISCORD_VIP_LIFETIME_ROLE_ID,
    config.DISCORD_STAFF_ROLE_ID,
    config.DISCORD_FOUNDER_ROLE_ID,
  ].map((id) => {
    const role = roles.find((r) => r.id === id);
    return {
      id,
      position: role?.position ?? null,
      correct: Boolean(
        role &&
        ([
          config.DISCORD_STAFF_ROLE_ID,
          config.DISCORD_FOUNDER_ROLE_ID,
        ].includes(id)
          ? role.position > highest
          : role.position < highest),
      ),
    };
  });
  const free = {
    user: { id: "free-role-only-probe" },
    roles: [config.DISCORD_FREE_MEMBER_ROLE_ID],
  };
  const staff = {
    user: { id: "staff-role-only-probe" },
    roles: [config.DISCORD_STAFF_ROLE_ID],
  };
  const base = guildPermissions(guild.id, roles, bot);
  const snapshot = {
    guild,
    roles,
    bot,
    ticketTool,
    category,
    support,
    ticket,
    panel,
  };
  return {
    version: 1,
    guildId: guild.id,
    input,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex"),
    roles: roles.map((r) => ({
      id: r.id,
      name: r.name,
      position: r.position,
      permissions: r.permissions,
    })),
    hierarchy,
    bot: {
      id: bot.user.id,
      roleIds: bot.roles,
      ticketPermissions: channelPermissions(ticket, roles, bot).toString(),
      categoryPermissions: channelPermissions(category, roles, bot).toString(),
      guildPermissions: base.toString(),
      administrator: Boolean(base & 8n),
      manageRoles: Boolean(base & MANAGE_ROLES),
    },
    ticketTool: {
      id: ticketTool.user.id,
      roleIds: ticketTool.roles,
      ticketPermissions: channelPermissions(ticket, roles, ticketTool).toString(),
      guildPermissions: guildPermissions(
        guild.id,
        roles,
        ticketTool,
      ).toString(),
      missingTicketPermissions: missingPermissions(
        channelPermissions(ticket, roles, ticketTool),
      ),
    },
    categoryOverwrites: category.permission_overwrites,
    ticketOverwrites: ticket.permission_overwrites,
    ticketPrivacyError: privacyError,
    panel: {
      id: panel.id,
      name: panel.name ?? null,
      parentId: panel.parent_id,
      everyoneVisible: Boolean(
        channelPermissions(panel, roles, { user: free.user, roles: [] }) & VIEW,
      ),
      freeMemberVisible: Boolean(channelPermissions(panel, roles, free) & VIEW),
    },
    staffTicketVisible: Boolean(
      channelPermissions(ticket, roles, staff) & VIEW,
    ),
    support: { id: support.id, unchanged: true },
    corrections,
  };
}
export type PermissionAudit = Awaited<
  ReturnType<typeof auditTicketPermissions>
>;
export function assertApprovedRepair(
  config: DiscordConfig,
  approved: PermissionAudit,
  current: PermissionAudit,
  reference: string,
) {
  if (
    !reference ||
    reference.trim().length < 8 ||
    reference.length > 200 ||
    [
      config.DISCORD_APPROVAL_REFERENCE,
      config.DISCORD_FREE_MEMBER_APPROVAL_REFERENCE,
      config.TICKET_TOOL_WELCOME_APPROVAL_REFERENCE,
    ].includes(reference)
  )
    throw new DiscordFailure("PERMISSION_REPAIR_APPROVAL_REQUIRED");
  if (JSON.stringify(approved) !== JSON.stringify(current))
    throw new DiscordFailure("PERMISSION_REPAIR_PLAN_CHANGED");
  if (
    current.ticketPrivacyError ||
    !current.staffTicketVisible ||
    !current.panel.freeMemberVisible ||
    current.bot.administrator ||
    !current.bot.manageRoles ||
    current.hierarchy.some((r) => !r.correct) ||
    current.corrections.some((c) => c.needsChange && !c.canApply)
  )
    throw new DiscordFailure("PERMISSION_REPAIR_NOT_AUTHORIZED");
}

export async function applyPermissionCorrections(
  config: DiscordConfig,
  rest: TicketRest,
  approved: PermissionAudit,
  current: PermissionAudit,
  reference: string,
  log: (event: Record<string, unknown>) => Promise<void>,
) {
  assertApprovedRepair(config, approved, current, reference);
  for (const correction of current.corrections.filter((c) => c.needsChange)) {
    const before = channelSchema.parse(
      await rest.request(`/api/v10/channels/${correction.channelId}`),
    );
    const expected =
      correction.channelId === config.TICKET_TOOL_DISCORD_CATEGORY_IDS[0]
        ? current.categoryOverwrites
        : current.ticketOverwrites;
    if (
      JSON.stringify(before.permission_overwrites) !== JSON.stringify(expected)
    )
      throw new DiscordFailure("PERMISSION_REPAIR_PLAN_CHANGED");
    const body = {
      type: 1,
      allow: correction.after.allow,
      deny: correction.after.deny,
    };
    await log({
      event: "VIP_PERMISSION_REPAIR_INTENT",
      approval: reference,
      correction,
    });
    await rest.request(
      `/api/v10/channels/${correction.channelId}/permissions/${config.DISCORD_CLIENT_ID}`,
      "PUT",
      body,
    );
    const after = channelSchema.parse(
      await rest.request(`/api/v10/channels/${correction.channelId}`),
    );
    const own = after.permission_overwrites.find(
      (o) => o.type === 1 && o.id === config.DISCORD_CLIENT_ID,
    );
    const others = (c: typeof after) =>
      c.permission_overwrites.filter(
        (o) => !(o.type === 1 && o.id === config.DISCORD_CLIENT_ID),
      );
    if (
      JSON.stringify(own) !== JSON.stringify(correction.after) ||
      JSON.stringify(others(before)) !== JSON.stringify(others(after))
    )
      throw new DiscordFailure("PERMISSION_REPAIR_NOT_CONFIRMED");
    await log({
      event: "VIP_PERMISSION_REPAIR_CONFIRMED",
      channelId: correction.channelId,
      after: own,
    });
  }
}
