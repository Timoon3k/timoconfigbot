import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { DiscordSyncService } from "./sync.js";

export class DiscordWorker {
  private stopping = false;
  private readonly controller = new AbortController();
  public readonly id = randomUUID();
  public constructor(private readonly sync: DiscordSyncService) {}
  public stop(): void {
    this.stopping = true;
    this.controller.abort();
  }
  public async tick(): Promise<number> {
    await this.sync.pool.query(
      `INSERT INTO discord_runtime(name,heartbeat_at) VALUES($1,now())
      ON CONFLICT(name) DO UPDATE SET heartbeat_at=now()`,
      [`worker:${this.id}`],
    );
    await this.sync.reconcileBatch();
    let count = 0;
    // Bounded, sequential requests per process; other workers use SKIP LOCKED.
    for (
      let i = 0;
      i < this.sync.config.DISCORD_WORKER_BATCH_SIZE && !this.stopping;
      i++
    ) {
      await this.sync.pool.query(
        "UPDATE discord_runtime SET heartbeat_at=now() WHERE name=$1",
        [`worker:${this.id}`],
      );
      if (!(await this.sync.runOne(this.id))) break;
      count++;
    }
    return count;
  }
  public async run(): Promise<void> {
    try {
      while (!this.stopping) {
        try {
          const processed = await this.tick();
          if (processed)
            process.stdout.write(
              JSON.stringify({
                event: "discord_worker_batch",
                workerId: this.id,
                processed,
                dryRun: true,
              }) + "\n",
            );
        } catch {
          process.stderr.write(
            JSON.stringify({
              event: "discord_worker_tick_failed",
              workerId: this.id,
            }) + "\n",
          );
        }
        await delay(this.sync.config.DISCORD_WORKER_POLL_MS, undefined, {
          signal: this.controller.signal,
        }).catch(() => undefined);
      }
    } finally {
      await this.sync.pool.query("DELETE FROM discord_runtime WHERE name=$1", [
        `worker:${this.id}`,
      ]);
    }
  }
}
