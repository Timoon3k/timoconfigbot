import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { MemberVerification } from "./verification.js";
import type { DiscordSyncService } from "./sync.js";

export class DiscordWorker {
  public lastCompletedAt: number | null = null;
  private stopping = false;
  private readonly controller = new AbortController();
  public readonly id = randomUUID();
  private stage = "idle";
  private lastFailureSignature = "";
  private lastFailureLoggedAt = 0;
  private suppressedFailures = 0;

  // Do not print exception messages/stacks: provider errors can contain secrets.
  private reportTickFailure(error: unknown): void {
    const rawCode =
      error && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
    const code =
      typeof rawCode === "string" && /^[a-zA-Z0-9_]{1,64}$/.test(rawCode)
        ? rawCode
        : "NO_ERROR_CODE";
    const rawType = error instanceof Error ? error.name : "Unknown";
    const type = /^[a-zA-Z]{1,48}$/.test(rawType) ? rawType : "Unknown";
    const signature = `${this.stage}:${code}:${type}`;
    const now = Date.now();
    if (
      signature !== this.lastFailureSignature ||
      now - this.lastFailureLoggedAt >= 60_000
    ) {
      process.stderr.write(
        JSON.stringify({
          event: "discord_worker_tick_failed",
          workerId: this.id,
          stage: this.stage,
          code,
          type,
          suppressedSinceLastLog: this.suppressedFailures,
        }) + "\n",
      );
      this.lastFailureSignature = signature;
      this.lastFailureLoggedAt = now;
      this.suppressedFailures = 0;
    } else {
      this.suppressedFailures++;
    }
  }
  public constructor(
    private readonly sync: DiscordSyncService,
    private readonly verification?: MemberVerification,
  ) {}
  public stop(): void {
    this.stopping = true;
    this.controller.abort();
  }
  public async tick(): Promise<number> {
    this.stage = "heartbeat";
    await this.sync.pool.query(
      `INSERT INTO discord_runtime(name,heartbeat_at) VALUES($1,now())
      ON CONFLICT(name) DO UPDATE SET heartbeat_at=now()`,
      [`worker:${this.sync.config.DISCORD_GUILD_ID}:${this.id}`],
    );
    this.stage = "vip_reconcile";
    await this.sync.reconcileBatch();
    this.stage = "member_reconcile";
    await this.verification?.reconcileBatch();
    let count = 0;
    // Bounded, sequential requests per process; other workers use SKIP LOCKED.
    for (
      let i = 0;
      i < this.sync.config.DISCORD_WORKER_BATCH_SIZE && !this.stopping;
      i++
    ) {
      this.stage = "heartbeat_update";
      await this.sync.pool.query(
        "UPDATE discord_runtime SET heartbeat_at=now() WHERE name=$1",
        [`worker:${this.sync.config.DISCORD_GUILD_ID}:${this.id}`],
      );
      this.stage = "member_job";
      const verified = (await this.verification?.runOne()) ?? false;
      this.stage = "vip_job";
      const synced = await this.sync.runOne(this.id);
      if (!verified && !synced) break;
      count += Number(verified) + Number(synced);
    }
    this.lastCompletedAt = Date.now();
    this.stage = "idle";
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
                dryRun: this.sync.config.DISCORD_DRY_RUN,
              }) + "\n",
            );
        } catch (error) {
          this.reportTickFailure(error);
        }
        await delay(this.sync.config.DISCORD_WORKER_POLL_MS, undefined, {
          signal: this.controller.signal,
        }).catch(() => undefined);
      }
    } finally {
      await this.sync.pool.query("DELETE FROM discord_runtime WHERE name=$1", [
        `worker:${this.sync.config.DISCORD_GUILD_ID}:${this.id}`,
      ]);
    }
  }
}
