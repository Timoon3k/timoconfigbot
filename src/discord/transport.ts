import { setTimeout as delay } from "node:timers/promises";
import type { DatabasePool } from "../db/pool.js";
import { inTransaction } from "../db/pool.js";
import type { DiscordConfig } from "./config.js";
import { LIVE_DISCORD_RELEASE_APPROVED, type HttpTransport } from "./rest.js";
import { DiscordFailure } from "./types.js";
import { assertRole } from "./policy.js";

/** Shared across processes and all guild REST routes: deliberately conservative. */
export class PostgresDiscordRateGate {
  public constructor(
    private readonly pool: DatabasePool,
    private readonly name: string,
    private readonly spacingMs: number,
  ) {}
  public async reserve(): Promise<number> {
    return inTransaction(this.pool, async (db) => {
      await db.query(
        "INSERT INTO discord_runtime(name) VALUES($1) ON CONFLICT DO NOTHING",
        [this.name],
      );
      const row = (
        await db.query<{ wait: number }>(
          `SELECT GREATEST(0,EXTRACT(EPOCH FROM next_request_at-clock_timestamp())*1000)::float AS wait
        FROM discord_runtime WHERE name=$1 FOR UPDATE`,
          [this.name],
        )
      ).rows[0]!;
      // Avoid reserving unbounded future slots while another worker handles a 429.
      if (row.wait > 5000)
        throw new DiscordFailure(
          "DISCORD_RATE_LIMITED",
          true,
          Math.ceil(row.wait),
        );
      await db.query(
        `UPDATE discord_runtime SET next_request_at=GREATEST(clock_timestamp(),next_request_at)+$2*interval '1 millisecond'
        WHERE name=$1`,
        [this.name, this.spacingMs],
      );
      return Math.ceil(row.wait);
    });
  }
  public async defer(milliseconds: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO discord_runtime(name,next_request_at) VALUES($1,clock_timestamp()+$2*interval '1 millisecond')
      ON CONFLICT(name) DO UPDATE SET next_request_at=GREATEST(discord_runtime.next_request_at,EXCLUDED.next_request_at)`,
      [this.name, milliseconds],
    );
  }
}

/** Production-capable HTTPS transport, unreachable in this offline-approved release. */
export class ApprovedDiscordHttpsTransport implements HttpTransport {
  public constructor(
    private readonly config: DiscordConfig,
    private readonly gate: PostgresDiscordRateGate,
  ) {}
  public async request(
    path: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<Response> {
    if (!LIVE_DISCORD_RELEASE_APPROVED || !this.config.DISCORD_NETWORK_ENABLED)
      throw new DiscordFailure("PRODUCTION_CONNECTION_NOT_APPROVED");
    const guild = this.config.DISCORD_GUILD_ID;
    const allowed =
      path === "/api/v10/oauth2/token" ||
      path === "/api/v10/users/@me" ||
      new RegExp(
        `^/api/v10/guilds/${guild}(?:/roles|/members/[0-9]{17,20}(?:/roles/[0-9]{17,20})?)?$`,
      ).test(path);
    if (!allowed) throw new DiscordFailure("DISCORD_ROUTE_NOT_ALLOWED");
    if (init.method !== "GET" && path !== "/api/v10/oauth2/token") {
      if (this.config.DISCORD_DRY_RUN || !this.config.DISCORD_WRITES_ENABLED)
        throw new DiscordFailure("LIVE_MUTATIONS_NOT_APPROVED");
      const role = path.match(/\/roles\/([0-9]{17,20})$/)?.[1];
      if (!role || !["PUT", "DELETE"].includes(init.method))
        throw new DiscordFailure("DISCORD_ROUTE_NOT_ALLOWED");
      assertRole(this.config, role);
    }
    await delay(await this.gate.reserve());
    let response: Response;
    try {
      response = await fetch(`https://discord.com${path}`, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new DiscordFailure("DISCORD_TIMEOUT", true);
    }
    if (response.status === 429) {
      const body: unknown = await response
        .clone()
        .json()
        .catch(() => ({}));
      const seconds =
        body &&
        typeof body === "object" &&
        "retry_after" in body &&
        typeof body.retry_after === "number"
          ? body.retry_after
          : 1;
      const header = Number(response.headers.get("retry-after") ?? 1);
      await this.gate.defer(
        Math.ceil(
          Math.max(seconds, Number.isFinite(header) ? header : 1) * 1000,
        ),
      );
    } else if (response.headers.get("x-ratelimit-remaining") === "0") {
      const seconds = Number(
        response.headers.get("x-ratelimit-reset-after") ?? 1,
      );
      await this.gate.defer(
        Math.ceil((Number.isFinite(seconds) ? seconds : 1) * 1000),
      );
    }
    return response;
  }
}
