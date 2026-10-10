import { setTimeout as delay } from "node:timers/promises";
import type { DatabaseClient, DatabasePool } from "../db/pool.js";
import { DiscordFailure } from "./types.js";

export interface BackgroundTask {
  run(): Promise<void>;
  stop(): void;
}
export type ManagedTasks = {
  worker: BackgroundTask & { lastCompletedAt: number | null };
  gateway: (BackgroundTask & { connected: boolean }) | null;
};

/** Dedicated session owns leadership. Every database disconnect stops Gateway before releasing leadership. */
export class DiscordSupervisor {
  public state:
    "starting" | "standby" | "leader" | "recovering" | "fatal" | "stopped" =
    "starting";
  private stopping = false;
  private readonly abort = new AbortController();
  private tasks: ManagedTasks | null = null;
  public constructor(
    private readonly pool: DatabasePool,
    private readonly guildId: string,
    private readonly factory: () => ManagedTasks,
    private readonly pollMs = 2000,
  ) {}
  public health() {
    return {
      state: this.state,
      ready:
        this.state === "leader" &&
        this.tasks?.worker.lastCompletedAt !== null &&
        Date.now() - (this.tasks?.worker.lastCompletedAt ?? 0) < 60000 &&
        (!this.tasks?.gateway || this.tasks.gateway.connected),
      gateway: this.tasks?.gateway
        ? this.tasks.gateway.connected
          ? "connected"
          : "disconnected"
        : "disabled",
    };
  }
  public stop(): void {
    this.stopping = true;
    this.abort.abort();
    this.tasks?.gateway?.stop();
    this.tasks?.worker.stop();
  }
  public async run(): Promise<void> {
    while (!this.stopping) {
      let client: DatabaseClient | undefined;
      let lost = false;
      let tasks: Array<Promise<void>> = [];
      const key = `discord-gateway:${this.guildId}`;
      const disconnect = () => {
        lost = true;
        this.tasks?.gateway?.stop();
        this.tasks?.worker.stop();
      };
      try {
        client = await this.pool.connect();
        client.on("error", disconnect);
        const leader = (
          await client.query<{ leader: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS leader",
            [key],
          )
        ).rows[0]?.leader;
        if (!leader) this.state = "standby";
        else {
          this.tasks = this.factory();
          this.state = "leader";
          let finished = false;
          let taskFailure: unknown;
          tasks = [this.tasks.worker.run()];
          if (this.tasks.gateway) tasks.push(this.tasks.gateway.run());
          const watched = tasks.map((task) =>
            task
              .catch((error) => {
                taskFailure = error;
              })
              .finally(() => {
                finished = true;
              }),
          );
          while (!this.stopping && !lost && !finished) {
            await client.query("SELECT 1");
            await delay(this.pollMs, undefined, {
              signal: this.abort.signal,
            }).catch(() => undefined);
          }
          this.tasks.gateway?.stop();
          this.tasks.worker.stop();
          await Promise.all(watched);
          if (taskFailure instanceof DiscordFailure && !taskFailure.retryable) {
            this.state = "fatal";
            throw taskFailure;
          }
          if (taskFailure || lost || (!this.stopping && finished))
            throw new Error("BACKGROUND_SESSION_LOST");
        }
      } catch (error) {
        disconnect();
        await Promise.allSettled(tasks);
        if (this.state === "fatal") throw error;
        if (!this.stopping) {
          this.state = "recovering";
          process.stderr.write(
            JSON.stringify({ event: "background_recovery" }) + "\n",
          );
        }
      } finally {
        this.tasks = null;
        if (client) {
          if (!lost)
            await client
              .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key])
              .catch(() => {
                lost = true;
              });
          client.removeListener("error", disconnect);
          client.release(lost);
        }
      }
      if (!this.stopping)
        await delay(this.pollMs, undefined, {
          signal: this.abort.signal,
        }).catch(() => undefined);
    }
    this.state = "stopped";
  }
}
