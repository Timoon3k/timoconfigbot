import { loadDiscordConfig } from "../src/discord/config.js";
import { DiscordFailure } from "../src/discord/types.js";
import type { HttpTransport } from "../src/discord/rest.js";
import { TicketRest } from "../src/tickets/rest.js";
import {
  REQUIRED,
  VIEW,
  MANAGE_ROLES,
  type Channel,
  type Role,
  type GuildMember,
} from "../src/tickets/permissions.js";

export const guildId = "1557854161805115402";
export const vipCategory = "1558892807786209360";
export const supportCategory = "1557857668964687913";
export const ticketId = "200000000000000020";
export const panelId = "200000000000000021";
export const customerId = "200000000000000022";
export const messageId = "200000000000000023";
export function ticketFixture(override: NodeJS.ProcessEnv = {}) {
  const config = loadDiscordConfig({
    DISCORD_ENVIRONMENT: "test-guild",
    DISCORD_TEST_GUILD_ID: guildId,
    DISCORD_GUILD_ID: guildId,
    DISCORD_GUILD_OWNER_ID: "100000000000000099",
    DISCORD_OWNER_APPROVED: "true",
    DISCORD_APPROVAL_REFERENCE: "fixture-network-approval",
    DISCORD_ADAPTER: "rest",
    DISCORD_NETWORK_ENABLED: "true",
    TICKET_TOOL_CHANNEL_OBSERVATION_ENABLED: "true",
    TICKET_TOOL_DISCORD_CATEGORY_IDS: vipCategory,
    TICKET_TOOL_SUPPORT_DISCORD_CATEGORY_ID: supportCategory,
    TICKET_TOOL_BOT_ID: "200000000000000024",
    TICKET_TOOL_WELCOME_WRITES_ENABLED: "true",
    TICKET_TOOL_SELECTIONS_ENABLED: "true",
    TICKET_TOOL_WELCOME_APPROVAL_REFERENCE: "fixture-welcome-approval",
    TICKET_TOOL_WELCOME_NOT_BEFORE: "2015-01-01T00:00:01Z",
    ...override,
  });
  const role = (
    id: string,
    name: string,
    position: number,
    permissions = "0",
  ): Role => ({ id, name, position, permissions, managed: false });
  const roles = [
    role(guildId, "@everyone", 0, REQUIRED.toString()),
    role(config.DISCORD_FREE_MEMBER_ROLE_ID, "Free Member", 0),
    role(config.DISCORD_VIP_MONTHLY_ROLE_ID, "VIP Monthly", 1),
    role(config.DISCORD_VIP_LIFETIME_ROLE_ID, "VIP Lifetime", 2),
    role(
      "100000000000000007",
      "TimonConfigs",
      3,
      (REQUIRED | MANAGE_ROLES).toString(),
    ),
    role(config.DISCORD_STAFF_ROLE_ID, "Staff", 4),
    role(config.DISCORD_FOUNDER_ROLE_ID, "Founder", 5),
    role("200000000000000025", "Ticket Tool", 3, REQUIRED.toString()),
  ];
  const members = new Map<string, GuildMember>([
    [
      config.DISCORD_CLIENT_ID,
      {
        user: { id: config.DISCORD_CLIENT_ID, bot: true },
        roles: ["100000000000000007"],
      },
    ],
    [
      config.TICKET_TOOL_BOT_ID!,
      {
        user: { id: config.TICKET_TOOL_BOT_ID!, bot: true },
        roles: ["200000000000000025"],
      },
    ],
    [
      customerId,
      {
        user: { id: customerId },
        roles: [config.DISCORD_FREE_MEMBER_ROLE_ID],
        pending: false,
      },
    ],
  ]);
  const channel: Channel = {
    id: ticketId,
    guild_id: guildId,
    parent_id: vipCategory,
    type: 0,
    name: "private-ticket",
    permission_overwrites: [
      { id: guildId, type: 0, allow: "0", deny: VIEW.toString() },
      {
        id: config.DISCORD_STAFF_ROLE_ID,
        type: 0,
        allow: REQUIRED.toString(),
        deny: "0",
      },
      {
        id: "200000000000000025",
        type: 0,
        allow: REQUIRED.toString(),
        deny: "0",
      },
      {
        id: config.DISCORD_CLIENT_ID,
        type: 1,
        allow: REQUIRED.toString(),
        deny: "0",
      },
      { id: customerId, type: 1, allow: REQUIRED.toString(), deny: "0" },
    ],
  };
  const channels = new Map<string, Channel>([
    [ticketId, channel],
    [
      vipCategory,
      {
        ...structuredClone(channel),
        id: vipCategory,
        type: 4,
        parent_id: null,
      },
    ],
    [
      supportCategory,
      {
        ...structuredClone(channel),
        id: supportCategory,
        type: 4,
        parent_id: null,
      },
    ],
    [
      panelId,
      {
        ...structuredClone(channel),
        id: panelId,
        parent_id: null,
        name: "open-vip-ticket",
        permission_overwrites: [],
      },
    ],
  ]);
  const messages: Array<{
    id: string;
    author: { id: string };
    nonce: string;
    components: unknown;
  }> = [];
  const calls: Array<{ path: string; method: string }> = [];
  let fail: DiscordFailure | undefined;
  let loseResponse = false;
  const transport: HttpTransport = {
    async request(path, init) {
      calls.push({ path, method: init.method });
      if (fail) throw fail;
      const prefix = `/api/v10/guilds/${guildId}`;
      if (path === prefix)
        return Response.json({
          id: guildId,
          owner_id: config.DISCORD_GUILD_OWNER_ID,
        });
      if (path === `${prefix}/roles`) return Response.json(roles);
      if (path === `${prefix}/channels`)
        return Response.json([...channels.values()]);
      const member = path.match(/\/members\/(\d+)$/)?.[1];
      if (member)
        return members.has(member)
          ? Response.json(members.get(member))
          : new Response("{}", { status: 404 });
      const id = path.match(/\/channels\/(\d+)/)?.[1];
      if (!id || !channels.has(id)) throw new Error("Unexpected fixture route");
      if (
        path.endsWith(`/permissions/${config.DISCORD_CLIENT_ID}`) &&
        init.method === "PUT"
      ) {
        const payload = JSON.parse(init.body!) as {
          type: 1;
          allow: string;
          deny: string;
        };
        const overwrites = channels.get(id)!.permission_overwrites;
        const own = overwrites.find(
          (o) => o.type === 1 && o.id === config.DISCORD_CLIENT_ID,
        );
        if (own) Object.assign(own, payload);
        else overwrites.push({ id: config.DISCORD_CLIENT_ID, ...payload });
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/messages") && init.method === "POST") {
        const payload = JSON.parse(init.body!) as {
          nonce: string;
          components: unknown;
        };
        messages.push({
          id: messageId,
          author: { id: config.DISCORD_CLIENT_ID },
          nonce: payload.nonce,
          components: payload.components,
        });
        if (loseResponse) throw new DiscordFailure("DISCORD_TIMEOUT", true);
        return Response.json({
          id: messageId,
          channel_id: id,
          author: { id: config.DISCORD_CLIENT_ID },
        });
      }
      if (path.includes("/messages?")) return Response.json(messages);
      return Response.json(channels.get(id));
    },
  };
  return {
    config,
    roles,
    members,
    channels,
    channel,
    messages,
    calls,
    rest: new TicketRest(config, "fixture-only", transport),
    setFailure: (value: DiscordFailure | undefined) => {
      fail = value;
    },
    loseResponse: (value: boolean) => {
      loseResponse = value;
    },
  };
}
