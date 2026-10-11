import { z } from "zod";
import type { DiscordConfig } from "../discord/config.js";
import { snowflake } from "../discord/config.js";
import {
  assertTestGuildNetwork,
  discordResponse,
  type HttpTransport,
} from "../discord/rest.js";
import { DiscordFailure } from "../discord/types.js";
import {
  assertPrivateTicket,
  channelPermissions,
  channelSchema,
  memberSchema,
  missingPermissions,
  roleSchema,
} from "./permissions.js";

export function welcomePanel() {
  return {
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: "TimonConfigs VIP Membership",
        description:
          "VIP Monthly — EUR 40/month, auto-renewal.\nVIP Lifetime — EUR 100, one-time payment.\n\nSelect a membership below. Checkout availability and terms are shown privately. Selection does not grant VIP access.",
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 1,
            label: "Select Monthly",
            custom_id: "tc:vip:monthly:v1",
          },
          {
            type: 2,
            style: 1,
            label: "Select Lifetime",
            custom_id: "tc:vip:lifetime:v1",
          },
        ],
      },
    ],
  };
}
export class TicketRest {
  public constructor(
    public readonly config: DiscordConfig,
    private readonly token: string,
    private readonly transport: HttpTransport,
  ) {}
  public async request(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<unknown> {
    assertTestGuildNetwork(this.config);
    return discordResponse(
      await this.transport.request(path, {
        method,
        headers: {
          Authorization: `Bot ${this.token}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }
  public async inspect(channelId: string) {
    snowflake.parse(channelId);
    const channel = channelSchema.parse(
      await this.request(`/api/v10/channels/${channelId}`),
    );
    if (
      channel.id !== channelId ||
      channel.guild_id !== this.config.DISCORD_GUILD_ID
    )
      throw new DiscordFailure("TICKET_IDENTITY_MISMATCH");
    const guild = `/api/v10/guilds/${this.config.DISCORD_GUILD_ID}`;
    const roles = z
      .array(roleSchema)
      .parse(await this.request(`${guild}/roles`));
    const bot = await this.member(this.config.DISCORD_CLIENT_ID);
    const ticketTool = await this.member(this.config.TICKET_TOOL_BOT_ID!);
    assertPrivateTicket(this.config, channel, roles, bot, ticketTool);
    if ((channelPermissions(channel, roles, bot) & 8n) !== 0n)
      throw new DiscordFailure("ADMINISTRATOR_NOT_ALLOWED");
    return { channel, roles, bot, ticketTool };
  }
  public async member(id: string) {
    const member = memberSchema.parse(
      await this.request(
        `/api/v10/guilds/${this.config.DISCORD_GUILD_ID}/members/${snowflake.parse(id)}`,
      ),
    );
    if (member.user.id !== id)
      throw new DiscordFailure("MEMBER_IDENTITY_MISMATCH");
    return member;
  }
  public async publish(channelId: string, nonce: string): Promise<string> {
    if (
      !this.config.TICKET_TOOL_WELCOME_WRITES_ENABLED ||
      !this.config.TICKET_TOOL_WELCOME_APPROVAL_REFERENCE
    )
      throw new DiscordFailure("TICKET_MESSAGES_NOT_APPROVED");
    const { channel, roles, bot } = await this.inspect(channelId);
    if (missingPermissions(channelPermissions(channel, roles, bot)).length)
      throw new DiscordFailure("TICKET_MESSAGE_PERMISSIONS_MISSING", true);
    const sent = z
      .object({
        id: snowflake,
        channel_id: snowflake,
        author: z.object({ id: snowflake }),
      })
      .parse(
        await this.request(`/api/v10/channels/${channelId}/messages`, "POST", {
          ...welcomePanel(),
          nonce,
          enforce_nonce: true,
        }),
      );
    if (
      sent.channel_id !== channelId ||
      sent.author.id !== this.config.DISCORD_CLIENT_ID
    )
      throw new DiscordFailure("TICKET_MESSAGE_IDENTITY_MISMATCH");
    return sent.id;
  }
  /** Recover an ambiguous send by locating the exact bot-authored button panel. */
  public async findPanel(
    channelId: string,
    nonce: string,
  ): Promise<string | null> {
    await this.inspect(channelId);
    let before = "";
    for (let page = 0; page < 10; page++) {
      const rows = z
        .array(
          z.object({
            id: snowflake,
            author: z.object({ id: snowflake }),
            nonce: z.union([z.string(), z.number()]).optional(),
            components: z
              .array(
                z.object({
                  components: z
                    .array(z.object({ custom_id: z.string().optional() }))
                    .optional(),
                }),
              )
              .optional(),
          }),
        )
        .parse(
          await this.request(
            `/api/v10/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ""}`,
          ),
        );
      const panel = rows.find(
        (m) =>
          m.author.id === this.config.DISCORD_CLIENT_ID &&
          String(m.nonce) === nonce &&
          m.components?.some((r) =>
            r.components?.some((c) => c.custom_id === "tc:vip:monthly:v1"),
          ),
      );
      if (panel) return panel.id;
      if (rows.length < 100) return null;
      before = rows.at(-1)!.id;
    }
    throw new DiscordFailure("TICKET_HISTORY_REVIEW_REQUIRED");
  }
}
