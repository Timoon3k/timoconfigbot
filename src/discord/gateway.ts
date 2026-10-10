import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  assertTestGuildNetwork,
  discordResponse,
  type HttpTransport,
} from "./rest.js";
import { snowflake, type DiscordConfig } from "./config.js";
import { DiscordFailure } from "./types.js";
import type { MemberVerification } from "./verification.js";

export const MEMBER_GATEWAY_INTENTS = 1 | 2; // Guilds and privileged Guild Members; no Message Content.
const frameSchema = z.object({
  op: z.number().int(),
  s: z.number().int().nonnegative().nullable().optional(),
  t: z.string().nullable().optional(),
  d: z.unknown(),
});

export async function checkGatewaySessionBudget(
  transport: HttpTransport,
  token: string,
): Promise<void> {
  const result = z
    .object({
      session_start_limit: z.object({
        remaining: z.number().int().nonnegative(),
        reset_after: z.number().nonnegative(),
        max_concurrency: z.number().int().positive(),
      }),
    })
    .parse(
      await discordResponse(
        await transport.request("/api/v10/gateway/bot", {
          method: "GET",
          headers: { Authorization: `Bot ${token}` },
        }),
      ),
    );
  if (result.session_start_limit.remaining < 1)
    throw new DiscordFailure(
      "GATEWAY_SESSION_LIMIT",
      true,
      Math.ceil(result.session_start_limit.reset_after),
    );
}

/** Session state has no token. Durable event jobs and REST scans recover events lost across process restarts. */
export class MemberGatewaySession {
  public sessionId: string | null = null;
  public sequence: number | null = null;
  public constructor(
    private readonly config: DiscordConfig,
    private readonly verification: MemberVerification,
  ) {}
  public async dispatch(raw: unknown): Promise<void> {
    const frame = frameSchema.parse(raw);
    if (frame.op !== 0) return;
    if (!Number.isSafeInteger(frame.s))
      throw new DiscordFailure("GATEWAY_SEQUENCE_INVALID");
    if (frame.t === "READY") {
      const ready = z
        .object({
          session_id: z.string().min(1).max(200),
          user: z.object({ id: snowflake }),
          guilds: z.array(z.object({ id: snowflake })),
        })
        .parse(frame.d);
      if (
        ready.user.id !== this.config.DISCORD_CLIENT_ID ||
        ready.guilds.length !== 1 ||
        ready.guilds[0]?.id !== this.config.DISCORD_GUILD_ID
      )
        throw new DiscordFailure("GATEWAY_IDENTITY_MISMATCH");
      this.sessionId = ready.session_id;
    } else if (!this.sessionId)
      throw new DiscordFailure("GATEWAY_SESSION_MISSING");
    if (frame.t && this.sessionId)
      await this.verification.dispatch(
        frame.t,
        frame.d,
        this.sessionId,
        frame.s!,
      );
    // Advance only after the event and its outbox have committed. Replay is deduplicated.
    this.sequence = frame.s!;
  }
  public reset(): void {
    this.sessionId = null;
    this.sequence = null;
  }
}

/** No connection is made by constructing this class. run() is gated to an explicitly approved test guild. */
export class DiscordMemberGateway {
  public connected = false;
  private stopping = false;
  private socket: WebSocket | undefined;
  private readonly controller = new AbortController();
  private readonly session: MemberGatewaySession;
  private lastIdentifyAt = 0;
  public constructor(
    private readonly config: DiscordConfig,
    private readonly token: string,
    verification: MemberVerification,
    private readonly socketFactory: (url: string) => WebSocket = (url) =>
      new WebSocket(url),
    private readonly beforeIdentify: () => Promise<void> = async () => {
      throw new DiscordFailure("GATEWAY_BUDGET_NOT_CONFIGURED");
    },
    private readonly pause: (
      ms: number,
      signal: AbortSignal,
    ) => Promise<void> = async (ms, signal) => {
      await delay(ms, undefined, { signal });
    },
  ) {
    this.session = new MemberGatewaySession(config, verification);
  }
  public stop(): void {
    this.connected = false;
    this.stopping = true;
    this.controller.abort();
    this.socket?.close(1000);
  }
  public async run(): Promise<void> {
    assertTestGuildNetwork(this.config);
    if (
      !this.config.DISCORD_GATEWAY_ENABLED ||
      !this.config.DISCORD_VERIFICATION_ENABLED ||
      !this.token
    )
      throw new DiscordFailure("GATEWAY_NOT_ENABLED");
    let attempts = 0;
    while (!this.stopping) {
      let retryAfter = 0;
      try {
        await this.connect();
        attempts = 0;
      } catch (error) {
        if (error instanceof DiscordFailure && !error.retryable) throw error;
        retryAfter = error instanceof DiscordFailure ? error.retryAfterMs : 0;
        attempts++;
        // Never log raw payloads, close reasons, tokens or authentication frames.
        process.stderr.write(
          JSON.stringify({
            event: "discord_gateway_reconnect",
            attempt: attempts,
          }) + "\n",
        );
      }
      if (!this.stopping)
        await this.pause(
          Math.max(
            retryAfter,
            Math.min(30000, 1000 * 2 ** Math.min(attempts, 5)) +
              Math.floor(Math.random() * 1000),
          ),
          this.controller.signal,
        ).catch(() => undefined);
    }
  }
  private async connect(): Promise<void> {
    const wait = Math.max(0, 5000 - (Date.now() - this.lastIdentifyAt));
    if (wait)
      await this.pause(wait, this.controller.signal).catch(() => undefined);
    if (this.stopping) return;
    if (!this.session.sessionId) await this.beforeIdentify();
    if (this.stopping) return;
    return new Promise<void>((resolve, reject) => {
      const socket = this.socketFactory(
        "wss://gateway.discord.gg/?v=10&encoding=json",
      );
      this.socket = socket;
      let heartbeat: ReturnType<typeof setTimeout> | undefined;
      let acknowledged = true;
      let chain = Promise.resolve();
      let backlog = 0;
      let failure: unknown;
      const helloTimeout = setTimeout(() => {
        failure = new DiscordFailure("GATEWAY_HELLO_TIMEOUT", true);
        socket.close(4000);
      }, 10000);
      const send = (op: number, d: unknown) => {
        if (socket.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify({ op, d }));
      };
      const beat = () => {
        if (!acknowledged) {
          failure = new DiscordFailure("GATEWAY_HEARTBEAT_TIMEOUT", true);
          socket.close(4000);
          return;
        }
        acknowledged = false;
        send(1, this.session.sequence);
      };
      socket.addEventListener("message", (event) => {
        // Bounded payloads and serialized dispatch protect event order and asynchronous DB commits.
        if (
          typeof event.data !== "string" ||
          Buffer.byteLength(event.data) > 1024 * 1024
        ) {
          failure = new DiscordFailure("GATEWAY_PAYLOAD_INVALID");
          socket.close(4000);
          return;
        }
        if (++backlog > 1000) {
          failure = new DiscordFailure("GATEWAY_BACKLOG_LIMIT", true);
          socket.close(4000);
          return;
        }
        chain = chain
          .then(async () => {
            const frame = frameSchema.parse(JSON.parse(event.data as string));
            if (frame.op === 10) {
              clearTimeout(helloTimeout);
              const hello = z
                .object({
                  heartbeat_interval: z.number().int().min(1000).max(120000),
                })
                .parse(frame.d);
              const schedule = () => {
                beat();
                if (socket.readyState === WebSocket.OPEN)
                  heartbeat = setTimeout(schedule, hello.heartbeat_interval);
              };
              heartbeat = setTimeout(
                schedule,
                Math.floor(Math.random() * hello.heartbeat_interval),
              );
              if (this.session.sessionId)
                send(6, {
                  token: this.token,
                  session_id: this.session.sessionId,
                  seq: this.session.sequence,
                });
              else {
                this.lastIdentifyAt = Date.now();
                send(2, {
                  token: this.token,
                  intents: MEMBER_GATEWAY_INTENTS,
                  properties: {
                    os: process.platform,
                    browser: "TimonConfigs",
                    device: "TimonConfigs",
                  },
                });
              }
            } else if (frame.op === 11) acknowledged = true;
            else if (frame.op === 1) {
              acknowledged = false;
              send(1, this.session.sequence);
            } else if (frame.op === 7) socket.close(4000);
            else if (frame.op === 9) {
              if (frame.d !== true) this.session.reset();
              socket.close(4000);
            } else if (frame.op === 0) {
              await this.session.dispatch(frame);
              if (frame.t === "READY" || frame.t === "RESUMED")
                this.connected = true;
            }
          })
          .finally(() => {
            backlog--;
          })
          .catch((error) => {
            failure =
              error instanceof DiscordFailure
                ? error
                : new DiscordFailure("GATEWAY_PROCESSING_FAILED", true);
            socket.close(4000);
          });
      });
      socket.addEventListener("error", () => {
        failure = new DiscordFailure("GATEWAY_CONNECTION_FAILED", true);
        socket.close(4000);
      });
      socket.addEventListener("close", (event) => {
        this.connected = false;
        clearTimeout(helloTimeout);
        if (heartbeat) clearTimeout(heartbeat);
        if ([4007, 4009].includes(event.code)) this.session.reset();
        if ([4004, 4010, 4011, 4012, 4013, 4014].includes(event.code))
          failure = new DiscordFailure("GATEWAY_CONFIGURATION_REJECTED");
        void chain.then(() => {
          if (failure) reject(failure);
          else resolve();
        });
      });
    });
  }
}
