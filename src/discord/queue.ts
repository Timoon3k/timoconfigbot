import { randomUUID } from "node:crypto";
import type { DatabaseClient, DatabasePool } from "../db/pool.js";
import { inTransaction } from "../db/pool.js";
import type { DiscordConfig } from "./config.js";
import { discordAudit } from "./audit.js";
import { DiscordFailure } from "./types.js";

export type SyncJob = {
  id: string;
  user_id: string;
  target_discord_id: string | null;
  reason: string;
  correlation_id: string;
  lease_token: string;
  attempt_count: number;
  max_attempts: number;
};

export async function enqueueSync(
  db: DatabaseClient | DatabasePool,
  userId: string,
  reason: string,
  key: string = randomUUID(),
  targetId: string | null = null,
  maxAttempts = 8,
): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO discord_sync_jobs
    (user_id,desired_tier,reason,deduplication_key,target_discord_id,max_attempts)
    VALUES ($1,'FREE',$2,$3,$4,$5) ON CONFLICT(deduplication_key) DO NOTHING RETURNING id`,
    [userId, reason, key, targetId, maxAttempts],
  );
  return result.rows[0]?.id ?? null;
}

export class SyncQueue {
  public constructor(
    public readonly pool: DatabasePool,
    private readonly config: DiscordConfig,
  ) {}

  public async claim(workerId: string): Promise<SyncJob | null> {
    return inTransaction(this.pool, async (db) => {
      // SKIP LOCKED also skips a previous worker that still holds its job transaction.
      const expired = await db.query<SyncJob>(`SELECT * FROM discord_sync_jobs
        WHERE status='processing' AND lease_expires_at < clock_timestamp()
        ORDER BY lease_expires_at LIMIT 100 FOR UPDATE SKIP LOCKED`);
      for (const job of expired.rows) {
        const exhausted = job.attempt_count >= job.max_attempts;
        await db.query(
          `UPDATE discord_sync_jobs SET status=$2::discord_job_status,lease_token=NULL,
          lease_expires_at=NULL,locked_by=NULL,locked_at=NULL,last_error_code='LEASE_EXPIRED',available_at=now(),
          completed_at=CASE WHEN $2::text='dead_letter' THEN now() ELSE NULL END
          WHERE id=$1`,
          [job.id, exhausted ? "dead_letter" : "retry"],
        );
        await db.query(
          `INSERT INTO discord_sync_history(job_id,user_id,correlation_id,attempt,outcome,error_code)
          VALUES ($1,$2,$3,$4,$5,'LEASE_EXPIRED')`,
          [
            job.id,
            job.user_id,
            job.correlation_id,
            job.attempt_count,
            exhausted ? "dead_letter" : "lease_recovered",
          ],
        );
        await discordAudit(
          db,
          exhausted ? "DISCORD_DEAD_LETTER_CREATED" : "DISCORD_LEASE_RECOVERED",
          job.user_id,
          { jobId: job.id },
          job.correlation_id,
        );
      }
      const result = await db.query<SyncJob>(
        `WITH candidate AS (
        SELECT id FROM discord_sync_jobs WHERE status IN ('queued','retry') AND available_at <= clock_timestamp()
        ORDER BY available_at,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
      ) UPDATE discord_sync_jobs j SET status='processing',attempt_count=attempt_count+1,locked_by=$1,
        locked_at=clock_timestamp(),lease_token=$2,lease_expires_at=clock_timestamp()+$3*interval '1 second'
        FROM candidate c WHERE j.id=c.id RETURNING j.*`,
        [workerId, randomUUID(), this.config.DISCORD_LEASE_SECONDS],
      );
      const job = result.rows[0];
      if (job)
        await discordAudit(
          db,
          "DISCORD_SYNC_STARTED",
          job.user_id,
          { jobId: job.id, attempt: job.attempt_count },
          job.correlation_id,
        );
      return job ?? null;
    });
  }

  public async retry(jobId: string, actorId: string): Promise<void> {
    await inTransaction(this.pool, async (db) => {
      const row = await db.query<
        SyncJob & { status: string; last_error_code: string | null }
      >("SELECT * FROM discord_sync_jobs WHERE id=$1 FOR UPDATE", [jobId]);
      const job = row.rows[0];
      const recoverable = [
        "DISCORD_TIMEOUT",
        "DISCORD_UNAVAILABLE",
        "DISCORD_RATE_LIMITED",
        "LEASE_EXPIRED",
        "INTERNAL_SYNC_FAILURE",
      ];
      if (
        !job ||
        !["dead_letter", "retry", "member_absent"].includes(job.status) ||
        (job.status !== "member_absent" &&
          !recoverable.includes(job.last_error_code ?? ""))
      )
        throw new DiscordFailure("JOB_NOT_RETRYABLE");
      await db.query(
        `UPDATE discord_sync_jobs SET status='queued',attempt_count=0,available_at=now(),completed_at=NULL,
        lease_token=NULL,lease_expires_at=NULL,locked_at=NULL,locked_by=NULL WHERE id=$1`,
        [jobId],
      );
      await discordAudit(
        db,
        "DISCORD_MANUAL_RETRY",
        job.user_id,
        { jobId },
        job.correlation_id,
        actorId,
      );
    });
  }
}
