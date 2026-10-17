import { readFile, writeFile, appendFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { loadDiscordConfig, snowflake } from "../discord/config.js";
import type { HttpTransport } from "../discord/rest.js";
import { assertTestGuildNetwork } from "../discord/rest.js";
import { DiscordFailure } from "../discord/types.js";
import { TicketRest } from "./rest.js";
import {
  auditTicketPermissions,
  assertApprovedRepair,
  applyPermissionCorrections,
  type PermissionAudit,
} from "./permission-audit.js";

/** Explicit operator CLI only; never invoked by the app/worker. Secrets are read from env, never printed. */
async function main() {
  const args = process.argv.slice(2);
  const allowedFlags = new Set([
    "--apply",
    "--ticket-channel",
    "--panel-channel",
    "--output",
    "--plan",
    "--approval-reference",
    "--audit-log",
  ]);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (!allowedFlags.has(flag))
      throw new DiscordFailure("AUDIT_ARGUMENT_INVALID");
    if (flag !== "--apply" && (!args[++i] || args[i]!.startsWith("--")))
      throw new DiscordFailure("AUDIT_ARGUMENT_INVALID");
  }
  const arg = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
  const config = loadDiscordConfig();
  assertTestGuildNetwork(config);
  if (!process.env.DISCORD_BOT_TOKEN)
    throw new DiscordFailure("DISCORD_TOKEN_UNAVAILABLE");
  // This CLI is deliberately pinned to the owner's approved guild/categories.
  if (
    config.DISCORD_GUILD_ID !== "1557854161805115402" ||
    config.TICKET_TOOL_SUPPORT_DISCORD_CATEGORY_ID !== "1557857668964687913" ||
    config.TICKET_TOOL_DISCORD_CATEGORY_IDS.join(",") !== "1558892807786209360"
  )
    throw new DiscordFailure("PERMISSION_REPAIR_SCOPE_INVALID");
  const input = {
    ticketChannelId: snowflake.parse(arg("--ticket-channel")),
    panelChannelId: snowflake.parse(arg("--panel-channel")),
  };
  const apply = args.includes("--apply");
  const reference = arg("--approval-reference") ?? "";
  const logPath = arg("--audit-log");
  if (apply && (!arg("--plan") || !logPath || !reference))
    throw new DiscordFailure("PERMISSION_REPAIR_APPROVAL_REQUIRED");
  const approvedWrites = new Map<string, string>();
  const transport: HttpTransport = {
    async request(path, init) {
      const reads = [
        `/api/v10/guilds/${config.DISCORD_GUILD_ID}`,
        `/api/v10/guilds/${config.DISCORD_GUILD_ID}/roles`,
        ...[config.DISCORD_CLIENT_ID, config.TICKET_TOOL_BOT_ID].map(
          (id) => `/api/v10/guilds/${config.DISCORD_GUILD_ID}/members/${id}`,
        ),
        ...[
          config.TICKET_TOOL_DISCORD_CATEGORY_IDS[0],
          config.TICKET_TOOL_SUPPORT_DISCORD_CATEGORY_ID,
          input.ticketChannelId,
          input.panelChannelId,
        ].map((id) => `/api/v10/channels/${id}`),
      ];
      if (
        !(init.method === "GET" && reads.includes(path)) &&
        !(
          apply &&
          init.method === "PUT" &&
          approvedWrites.has(path) &&
          init.body === approvedWrites.get(path)
        )
      )
        throw new DiscordFailure("DISCORD_ROUTE_NOT_ALLOWED");
      await delay(300);
      try {
        const response = await fetch(`https://discord.com${path}`, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        });
        if (response.status === 429) {
          const value: unknown = await response
            .clone()
            .json()
            .catch(() => null);
          const retry =
            value &&
            typeof value === "object" &&
            "retry_after" in value &&
            typeof value.retry_after === "number"
              ? value.retry_after
              : 1;
          await delay(Math.min(10000, Math.max(1, retry) * 1000));
        }
        return response;
      } catch {
        throw new DiscordFailure("DISCORD_TIMEOUT", true);
      }
    },
  };
  const rest = new TicketRest(config, process.env.DISCORD_BOT_TOKEN, transport);
  const current = await auditTicketPermissions(config, rest, input);
  if (!apply) {
    if (arg("--output"))
      await writeFile(arg("--output")!, JSON.stringify(current, null, 2), {
        flag: "wx",
        mode: 0o600,
      });
    process.stdout.write(JSON.stringify(current, null, 2) + "\n");
    return;
  }
  const approved = JSON.parse(
    await readFile(arg("--plan")!, "utf8"),
  ) as PermissionAudit;
  assertApprovedRepair(config, approved, current, reference);
  for (const correction of current.corrections.filter((c) => c.needsChange)) {
    approvedWrites.set(
      `/api/v10/channels/${correction.channelId}/permissions/${config.DISCORD_CLIENT_ID}`,
      JSON.stringify({
        type: 1,
        allow: correction.after.allow,
        deny: correction.after.deny,
      }),
    );
  }
  await applyPermissionCorrections(
    config,
    rest,
    approved,
    current,
    reference,
    async (event) => {
      await appendFile(
        logPath!,
        JSON.stringify({ ...event, at: new Date().toISOString() }) + "\n",
        { mode: 0o600 },
      );
    },
  );
  approvedWrites.clear();
  const verified = await auditTicketPermissions(config, rest, input);
  process.stdout.write(
    JSON.stringify(
      { applied: true, approval: reference, audit: verified },
      null,
      2,
    ) + "\n",
  );
}
main().catch((error) => {
  process.stderr.write(
    JSON.stringify({
      error:
        error instanceof DiscordFailure
          ? error.code
          : "TICKET_PERMISSION_AUDIT_FAILED",
    }) + "\n",
  );
  process.exitCode = 1;
});
