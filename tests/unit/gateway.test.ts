import { describe, expect, it, vi } from "vitest";
import {
  MemberGatewaySession,
  MEMBER_GATEWAY_INTENTS,
} from "../../src/discord/gateway.js";
import type { MemberVerification } from "../../src/discord/verification.js";
import { loadDiscordConfig } from "../../src/discord/config.js";
import { roleDiff, verifyGuild } from "../../src/discord/policy.js";
import { mockGuild } from "../../src/discord/adapters.js";
const config = loadDiscordConfig({ DISCORD_VERIFICATION_ENABLED: "true" });
const member = "200000000000000001";
const ready = {
  op: 0,
  t: "READY",
  s: 1,
  d: {
    session_id: "test-session",
    user: { id: config.DISCORD_CLIENT_ID },
    guilds: [{ id: config.DISCORD_GUILD_ID }],
  },
};
function fixture() {
  const dispatch = vi.fn().mockResolvedValue(undefined);
  return {
    dispatch,
    session: new MemberGatewaySession(config, {
      dispatch,
    } as unknown as MemberVerification),
  };
}
describe("Gateway session boundaries", () => {
  it("requests only Guilds and Server Members intents", () =>
    expect(MEMBER_GATEWAY_INTENTS).toBe(3));
  it("authenticates READY identity and guild before handling member events", async () => {
    const { session, dispatch } = fixture();
    await expect(
      session.dispatch({ ...ready, d: { ...ready.d, user: { id: member } } }),
    ).rejects.toMatchObject({ code: "GATEWAY_IDENTITY_MISMATCH" });
    await expect(
      session.dispatch({
        ...ready,
        d: { ...ready.d, guilds: [...ready.d.guilds, { id: member }] },
      }),
    ).rejects.toThrow();
    await session.dispatch(ready);
    await session.dispatch({
      op: 0,
      t: "GUILD_MEMBER_UPDATE",
      s: 2,
      d: {
        guild_id: config.DISCORD_GUILD_ID,
        user: { id: member },
        pending: false,
      },
    });
    expect(dispatch).toHaveBeenLastCalledWith(
      "GUILD_MEMBER_UPDATE",
      expect.objectContaining({ pending: false }),
      "test-session",
      2,
    );
    expect(session.sequence).toBe(2);
  });
  it("does not advance sequence on processing failure, permitting resumed replay", async () => {
    const { session, dispatch } = fixture();
    await session.dispatch(ready);
    dispatch.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(
      session.dispatch({ op: 0, t: "GUILD_MEMBER_ADD", s: 2, d: {} }),
    ).rejects.toThrow();
    expect(session.sequence).toBe(1);
    session.reset();
    expect(session.sessionId).toBeNull();
    expect(session.sequence).toBeNull();
  });
  it("keeps Free Member out of VIP removal even when verification is enabled", () => {
    expect(() => verifyGuild(config, mockGuild(config))).not.toThrow();
    expect(
      roleDiff(config, [config.DISCORD_FREE_MEMBER_ROLE_ID], "FREE").remove,
    ).toEqual([]);
  });
  it("rejects production and mismatched test-guild activation", () => {
    expect(() => loadDiscordConfig({ NODE_ENV: "production" })).toThrow();
    expect(() =>
      loadDiscordConfig({
        DISCORD_ENVIRONMENT: "test-guild",
        DISCORD_NETWORK_ENABLED: "true",
        DISCORD_OWNER_APPROVED: "true",
      }),
    ).toThrow();
    expect(() =>
      loadDiscordConfig({
        DISCORD_FREE_MEMBER_ROLE_ID: config.DISCORD_STAFF_ROLE_ID,
      }),
    ).toThrow();
  });
});

describe("Gateway connection lifecycle using an injected socket only", () => {
  it("resumes on reconnect, authenticates intent and shuts down cleanly", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { DiscordMemberGateway } =
      await import("../../src/discord/gateway.js");
    const live = loadDiscordConfig({
      DISCORD_ENVIRONMENT: "test-guild",
      DISCORD_TEST_GUILD_ID: "900000000000000001",
      DISCORD_GUILD_ID: "900000000000000001",
      DISCORD_GUILD_OWNER_ID: "100000000000000099",
      DISCORD_OWNER_APPROVED: "true",
      DISCORD_APPROVAL_REFERENCE: "owner-test-fixture",
      DISCORD_ADAPTER: "rest",
      DISCORD_NETWORK_ENABLED: "true",
      DISCORD_GATEWAY_ENABLED: "true",
      DISCORD_VERIFICATION_ENABLED: "true",
    });
    class Socket extends EventTarget {
      public readyState = 1;
      public sent: Array<{ op: number; d: Record<string, unknown> }> = [];
      public send(raw: string) {
        this.sent.push(JSON.parse(raw));
      }
      public emit(data: unknown) {
        this.dispatchEvent(
          new MessageEvent("message", { data: JSON.stringify(data) }),
        );
      }
      public close(code = 1000) {
        if (this.readyState === 3) return;
        this.readyState = 3;
        const event = new Event("close");
        Object.assign(event, { code });
        this.dispatchEvent(event);
      }
    }
    const sockets: Socket[] = [];
    const gateway = new DiscordMemberGateway(
      live,
      "test-only-token",
      {
        dispatch: vi.fn().mockResolvedValue(undefined),
      } as unknown as MemberVerification,
      () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      async () => undefined,
      async (ms, signal) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        }),
    );
    const running = gateway.run();
    try {
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]!.emit({ op: 10, d: { heartbeat_interval: 1000 } });
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets[0]!.sent.find((m) => m.op === 2)?.d.intents).toBe(3);
      sockets[0]!.emit({
        ...ready,
        d: { ...ready.d, guilds: [{ id: live.DISCORD_GUILD_ID }] },
      });
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]!.emit({ op: 7, d: null });
      await vi.advanceTimersByTimeAsync(6000);
      expect(sockets).toHaveLength(2);
      sockets[1]!.emit({ op: 10, d: { heartbeat_interval: 1000 } });
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets[1]!.sent.find((m) => m.op === 6)?.d).toMatchObject({
        session_id: "test-session",
        seq: 1,
      });
      gateway.stop();
      await running;
    } finally {
      gateway.stop();
      vi.useRealTimers();
    }
  });
});

describe("Gateway identify budget", () => {
  it("honors session reset limits before opening a new connection", async () => {
    const { checkGatewaySessionBudget } =
      await import("../../src/discord/gateway.js");
    const transport = {
      request: vi
        .fn()
        .mockResolvedValue(
          Response.json({
            session_start_limit: {
              remaining: 0,
              reset_after: 60000,
              max_concurrency: 1,
            },
          }),
        ),
    };
    await expect(
      checkGatewaySessionBudget(transport, "fixture"),
    ).rejects.toMatchObject({
      code: "GATEWAY_SESSION_LIMIT",
      retryAfterMs: 60000,
    });
    transport.request.mockResolvedValueOnce(
      Response.json({
        session_start_limit: {
          remaining: 1,
          reset_after: 60000,
          max_concurrency: 1,
        },
      }),
    );
    await expect(
      checkGatewaySessionBudget(transport, "fixture"),
    ).resolves.toBeUndefined();
  });
});
