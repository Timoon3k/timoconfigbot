import { describe, expect, it, vi } from "vitest";
import { DiscordWorker } from "../../src/discord/worker.js";
import type { DiscordSyncService } from "../../src/discord/sync.js";

describe("DiscordWorker error diagnostics", () => {
  it("logs the failing stage and PostgreSQL code without leaking error details", async () => {
    const output: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    try {
      let worker: DiscordWorker;
      const sync = {
        config: {
          DISCORD_GUILD_ID: "900000000000000001",
          DISCORD_WORKER_BATCH_SIZE: 1,
          DISCORD_WORKER_POLL_MS: 1,
          DISCORD_DRY_RUN: true,
        },
        pool: { query: vi.fn(async () => ({ rows: [] })) },
        reconcileBatch: vi.fn(async () => {
          worker.stop();
          throw Object.assign(new Error("private-database-connection-string"), { code: "42P01" });
        }),
        runOne: vi.fn(),
      } as unknown as DiscordSyncService;
      worker = new DiscordWorker(sync);
      await worker.run();
      const errors = output.filter((line) => line.includes('"event":"discord_worker_tick_failed"'));
      expect(errors).toHaveLength(1);
      expect(JSON.parse(errors[0]!)).toMatchObject({
        stage: "vip_reconcile",
        code: "42P01",
        type: "Error",
        suppressedSinceLastLog: 0,
      });
      expect(output.join("")).not.toContain("private-database-connection-string");
    } finally {
      stderr.mockRestore();
    }
  });
});
