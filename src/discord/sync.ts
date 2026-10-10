import { randomUUID } from "node:crypto";
import type { DatabaseClient, DatabasePool } from "../db/pool.js";
import { inTransaction } from "../db/pool.js";
import type { MembershipService } from "../membership/service.js";
import type { DiscordConfig } from "./config.js";
import { snowflake } from "./config.js";
import { discordAudit } from "./audit.js";
import { RoleOperations } from "./operations.js";
import { roleDiff, verifyGuild } from "./policy.js";
import { enqueueSync, SyncQueue, type SyncJob } from "./queue.js";
import { DiscordFailure, type DiscordAdapter, type Preview } from "./types.js";

async function boundedRead<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new DiscordFailure("DISCORD_TIMEOUT", true)),
          5000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class DiscordSyncService {
  public readonly queue: SyncQueue;
  public constructor(
    public readonly pool: DatabasePool,
    public readonly config: DiscordConfig,
    private readonly memberships: MembershipService,
    private readonly adapter: DiscordAdapter,
    private readonly clock: () => Date = () => new Date(),
    private readonly jitter: () => number = Math.random,
  ) {
    this.queue = new SyncQueue(pool, config);
  }

  private async previewWith(
    db: DatabaseClient,
    userId: string,
    reason: string,
    targetId: string | null,
  ): Promise<Preview | null> {
    // Serialize with payment processing and identity replacement, not with other users.
    const user = await db.query<{ disabled_at: Date | null }>(
      "SELECT id,disabled_at FROM app_users WHERE id=$1 FOR UPDATE",
      [userId],
    );
    if (!user.rowCount) throw new DiscordFailure("USER_NOT_FOUND");
    const account = (
      await db.query<{ discord_user_id: string }>(
        "SELECT discord_user_id FROM discord_accounts WHERE user_id=$1 AND unlinked_at IS NULL",
        [userId],
      )
    ).rows[0];
    const id = targetId ?? account?.discord_user_id;
    if (!id) return null;
    snowflake.parse(id);
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `discord-member:${this.config.DISCORD_GUILD_ID}:${id}`,
    ]);
    const currentIdentity = account?.discord_user_id === id;
    const guild = await boundedRead(this.adapter.inspectGuild());
    let policyError: string | null = null;
    try {
      verifyGuild(this.config, guild);
    } catch (error) {
      if (!(error instanceof DiscordFailure)) throw error;
      policyError = error.code;
    }
    // A wrong guild response must never be used to resolve a member.
    if (guild.id !== this.config.DISCORD_GUILD_ID)
      throw new DiscordFailure("GUILD_IDENTITY_MISMATCH");
    const member = await boundedRead(this.adapter.getMember(id));
    if (!member) throw new DiscordFailure("MEMBER_ABSENT");
    if (member.id !== id) throw new DiscordFailure("MEMBER_IDENTITY_MISMATCH");
    const now = this.clock();
    const tier =
      currentIdentity && !user.rows[0]?.disabled_at
        ? await this.memberships.activeTierWith(db, userId, now)
        : "FREE";
    const refs = currentIdentity
      ? await db.query<{ id: string }>(
          `SELECT id FROM membership_entitlements
      WHERE user_id=$1 AND valid_from<=$2 AND (valid_until IS NULL OR valid_until>$2)
      AND (revoked_at IS NULL OR revoked_at>$2) ORDER BY id`,
          [userId, now],
        )
      : { rows: [] };
    const diff = roleDiff(this.config, member.roles, tier);
    await new RoleOperations(
      this.pool,
      this.config,
      this.adapter,
    ).recoverOwnership(db, userId, id, member.roles);
    if (
      this.config.DISCORD_ENVIRONMENT === "test-guild" &&
      diff.add.length &&
      member.pending !== false
    )
      policyError = "MEMBER_SCREENING_INCOMPLETE";
    const ownership = await db.query<{ role_id: string }>(
      `SELECT role_id FROM discord_role_ownership
      WHERE guild_id=$1 AND discord_user_id=$2 AND user_id=$3
      AND ($4::boolean OR source IN ('bot_assignment','approved_migration'))`,
      [this.config.DISCORD_GUILD_ID, id, userId, this.config.DISCORD_DRY_RUN],
    );
    const owned = new Set(ownership.rows.map((row) => row.role_id));
    const conflicts = diff.remove.filter((role) => !owned.has(role));
    return {
      userId,
      discordUserId: id,
      guildId: this.config.DISCORD_GUILD_ID,
      currentRoles: member.roles,
      effectiveMembership: tier,
      desiredRoles: diff.desired,
      add: diff.add,
      remove: diff.remove,
      ownershipConflicts: conflicts,
      reason,
      entitlementReferences: refs.rows.map((row) => row.id),
      timestamp: now.toISOString(),
      permitted: !policyError && !conflicts.length,
      dryRun: true,
      simulated: this.config.DISCORD_ADAPTER === "mock",
      errorCode:
        policyError ?? (conflicts.length ? "ROLE_OWNERSHIP_UNKNOWN" : null),
    };
  }

  public async preview(
    userId: string,
    reason = "administrator_preview",
  ): Promise<Preview | null> {
    return inTransaction(this.pool, (db) =>
      this.previewWith(db, userId, reason, null),
    );
  }

  public async effectiveTier(userId: string) {
    return this.memberships.activeTier(userId, this.clock());
  }

  public async runOne(workerId = randomUUID()): Promise<boolean> {
    if (!this.config.DISCORD_VIP_SYNC_ENABLED) return false;
    const cooldown = await this.pool.query<{ blocked: boolean }>(
      "SELECT next_request_at>clock_timestamp() AS blocked FROM discord_runtime WHERE name=$1",
      [`rate:${this.config.DISCORD_GUILD_ID}`],
    );
    if (cooldown.rows[0]?.blocked) return false;
    const job = await this.queue.claim(workerId);
    if (!job) return false;
    await this.process(job);
    return true;
  }

  public async process(job: SyncJob): Promise<void> {
    try {
      await inTransaction(this.pool, async (db) => {
        await db.query("SET LOCAL lock_timeout = '5s'");
        await db.query("SET LOCAL statement_timeout = '15s'");
        await db.query("SET LOCAL idle_in_transaction_session_timeout = '20s'");
        const lease = await db.query(
          `SELECT id FROM discord_sync_jobs WHERE id=$1 AND lease_token=$2
          AND status='processing' AND lease_expires_at>clock_timestamp() FOR UPDATE`,
          [job.id, job.lease_token],
        );
        if (!lease.rowCount) return;
        const preview = await this.previewWith(
          db,
          job.user_id,
          job.reason,
          job.target_discord_id,
        );
        if (preview) {
          for (const role of preview.add)
            await discordAudit(
              db,
              "DISCORD_ROLE_ADDITION_PLANNED",
              job.user_id,
              {
                jobId: job.id,
                roleId: role,
                permitted: preview.permitted,
                dryRun: true,
              },
              job.correlation_id,
            );
          for (const role of preview.remove)
            await discordAudit(
              db,
              "DISCORD_ROLE_REMOVAL_PLANNED",
              job.user_id,
              {
                jobId: job.id,
                roleId: role,
                permitted: preview.permitted,
                dryRun: true,
              },
              job.correlation_id,
            );
          if (preview.effectiveMembership === "VIP_LIFETIME")
            await discordAudit(
              db,
              "DISCORD_LIFETIME_PRESERVED",
              job.user_id,
              { jobId: job.id },
              job.correlation_id,
            );
          if (preview.effectiveMembership === "FREE")
            await discordAudit(
              db,
              "DISCORD_NO_ACTIVE_ENTITLEMENT",
              job.user_id,
              { jobId: job.id },
              job.correlation_id,
            );
          if (/REFUNDED|DISPUTED/.test(job.reason))
            await discordAudit(
              db,
              "DISCORD_REFUND_RECONCILIATION",
              job.user_id,
              { jobId: job.id },
              job.correlation_id,
            );
          if (preview.errorCode)
            await discordAudit(
              db,
              "DISCORD_SAFETY_CHECK_FAILED",
              job.user_id,
              { jobId: job.id, errorCode: preview.errorCode },
              job.correlation_id,
            );
        }
        const live = !this.config.DISCORD_DRY_RUN;
        if (preview?.permitted && live) {
          const operations = new RoleOperations(
            this.pool,
            this.config,
            this.adapter,
          );
          // Add the new tier before removing the old tier. Entitlements remain locked throughout.
          for (const role of preview.add)
            await operations.apply(
              db,
              preview.discordUserId,
              role,
              "add",
              job.user_id,
            );
          for (const role of preview.remove)
            await operations.apply(
              db,
              preview.discordUserId,
              role,
              "remove",
              job.user_id,
            );
        }
        const outcome = !preview
          ? "unlinked"
          : !preview.permitted
            ? "dead_letter"
            : preview.add.length || preview.remove.length
              ? live
                ? "applied"
                : "preview"
              : "noop";
        // Preview is never proof of assignment. Mode describes actual execution.
        await db.query(
          `INSERT INTO discord_sync_history(job_id,user_id,discord_user_id,correlation_id,attempt,outcome,error_code,preview,mode)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
          [
            job.id,
            job.user_id,
            preview?.discordUserId ?? null,
            job.correlation_id,
            job.attempt_count,
            outcome,
            preview?.errorCode ?? null,
            preview ? JSON.stringify(preview) : null,
            live ? "test-guild" : "dry-run",
          ],
        );
        await db.query(
          `UPDATE discord_sync_jobs SET status=$3::discord_job_status,completed_at=now(),lease_token=NULL,
          lease_expires_at=NULL,locked_by=NULL,locked_at=NULL,last_error_code=$4,last_error_message=NULL,dry_run=$5
          WHERE id=$1 AND lease_token=$2`,
          [
            job.id,
            job.lease_token,
            outcome === "dead_letter" ? "dead_letter" : "succeeded",
            preview?.errorCode ?? null,
            this.config.DISCORD_DRY_RUN,
          ],
        );
        await discordAudit(
          db,
          outcome === "dead_letter"
            ? "DISCORD_DEAD_LETTER_CREATED"
            : "DISCORD_SYNC_COMPLETED",
          job.user_id,
          {
            jobId: job.id,
            outcome,
            errorCode: preview?.errorCode ?? null,
            dryRun: this.config.DISCORD_DRY_RUN,
          },
          job.correlation_id,
        );
      });
    } catch (error) {
      await this.fail(job, error);
    }
  }

  private async fail(job: SyncJob, error: unknown): Promise<void> {
    const failure =
      error instanceof DiscordFailure
        ? error
        : new DiscordFailure("INTERNAL_SYNC_FAILURE", true);
    await inTransaction(this.pool, async (db) => {
      const lease = await db.query(
        "SELECT id FROM discord_sync_jobs WHERE id=$1 AND lease_token=$2 AND status='processing' FOR UPDATE",
        [job.id, job.lease_token],
      );
      if (!lease.rowCount) return;
      const absent = failure.code === "MEMBER_ABSENT";
      const retry = failure.retryable && job.attempt_count < job.max_attempts;
      const outcome = absent
        ? "member_absent"
        : retry
          ? "retry"
          : "dead_letter";
      const backoff = Math.min(
        300_000,
        1000 * 2 ** Math.min(18, job.attempt_count - 1),
      );
      const delay = Math.max(
        failure.retryAfterMs,
        Math.ceil(backoff * (1 + this.jitter())),
      );
      await db.query(
        `UPDATE discord_sync_jobs SET status=$3::discord_job_status,available_at=clock_timestamp()+$4*interval '1 millisecond',
        last_error_code=$5,last_error_message=$5,lease_token=NULL,lease_expires_at=NULL,locked_at=NULL,locked_by=NULL,
        completed_at=CASE WHEN $3::text='retry' THEN NULL ELSE now() END WHERE id=$1 AND lease_token=$2`,
        [job.id, job.lease_token, outcome, delay, failure.code],
      );
      if (failure.code === "DISCORD_RATE_LIMITED")
        await db.query(
          `INSERT INTO discord_runtime(name,next_request_at)
        VALUES($1,clock_timestamp()+$2*interval '1 millisecond') ON CONFLICT(name) DO UPDATE
        SET next_request_at=GREATEST(discord_runtime.next_request_at,EXCLUDED.next_request_at)`,
          [`rate:${this.config.DISCORD_GUILD_ID}`, delay],
        );
      await db.query(
        `INSERT INTO discord_sync_history(job_id,user_id,correlation_id,attempt,outcome,error_code,mode)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          job.id,
          job.user_id,
          job.correlation_id,
          job.attempt_count,
          outcome,
          failure.code,
          this.config.DISCORD_DRY_RUN ? "dry-run" : "test-guild",
        ],
      );
      await discordAudit(
        db,
        absent
          ? "DISCORD_MEMBER_NOT_FOUND"
          : retry
            ? "DISCORD_RETRY_SCHEDULED"
            : "DISCORD_DEAD_LETTER_CREATED",
        job.user_id,
        { jobId: job.id, errorCode: failure.code, retryAfterMs: delay },
        job.correlation_id,
      );
    });
  }

  public async enqueue(
    userId: string,
    reason: string,
    actorId?: string,
  ): Promise<string | null> {
    return inTransaction(this.pool, async (db) => {
      const id = await enqueueSync(
        db,
        userId,
        reason,
        randomUUID(),
        null,
        this.config.DISCORD_MAX_ATTEMPTS,
      );
      await discordAudit(
        db,
        "DISCORD_SYNC_ENQUEUED",
        userId,
        { jobId: id, reason },
        randomUUID(),
        actorId,
      );
      return id;
    });
  }

  /** Trusted gateway adapter hook; deliberately not a public HTTP endpoint. */
  public async memberRejoined(
    guildId: string,
    discordId: string,
    eventId: string,
  ): Promise<void> {
    if (guildId !== this.config.DISCORD_GUILD_ID)
      throw new DiscordFailure("GUILD_IDENTITY_MISMATCH");
    snowflake.parse(discordId);
    const account = await this.pool.query<{ user_id: string }>(
      "SELECT user_id FROM discord_accounts WHERE discord_user_id=$1 AND unlinked_at IS NULL",
      [discordId],
    );
    if (account.rows[0])
      await enqueueSync(
        this.pool,
        account.rows[0].user_id,
        "member_rejoined",
        `rejoin:${guildId}:${eventId}`,
        discordId,
        this.config.DISCORD_MAX_ATTEMPTS,
      );
  }

  public async reconcileBatch(): Promise<number> {
    return inTransaction(this.pool, async (db) => {
      const name = `scan:${this.config.DISCORD_GUILD_ID}`;
      await db.query(
        "INSERT INTO discord_runtime(name) VALUES($1) ON CONFLICT DO NOTHING",
        [name],
      );
      const state = (
        await db.query<{ cursor_user_id: string | null; due: boolean }>(
          "SELECT cursor_user_id,next_scan_at<=clock_timestamp() AS due FROM discord_runtime WHERE name=$1 FOR UPDATE",
          [name],
        )
      ).rows[0];
      if (!state?.due) return 0;
      const accounts = await db.query<{ user_id: string }>(
        `SELECT a.user_id FROM discord_accounts a
        WHERE a.unlinked_at IS NULL AND ($1::uuid IS NULL OR a.user_id>$1) ORDER BY a.user_id LIMIT $2`,
        [state.cursor_user_id, this.config.DISCORD_RECONCILE_BATCH_SIZE],
      );
      let count = 0;
      for (const account of accounts.rows) {
        const latest = (
          await db.query<{ status: string }>(
            `SELECT status FROM discord_sync_jobs WHERE user_id=$1
          ORDER BY created_at DESC,id DESC LIMIT 1`,
            [account.user_id],
          )
        ).rows[0];
        if (
          latest &&
          ["queued", "processing", "retry", "dead_letter"].includes(
            latest.status,
          )
        )
          continue;
        await enqueueSync(
          db,
          account.user_id,
          "periodic_reconciliation",
          randomUUID(),
          null,
          this.config.DISCORD_MAX_ATTEMPTS,
        );
        count++;
      }
      const finished =
        accounts.rows.length < this.config.DISCORD_RECONCILE_BATCH_SIZE;
      await db.query(
        `UPDATE discord_runtime SET cursor_user_id=$2,next_scan_at=clock_timestamp()+$3*interval '1 second',
        last_scan_at=CASE WHEN $4 THEN clock_timestamp() ELSE last_scan_at END WHERE name=$1`,
        [
          name,
          finished ? null : accounts.rows.at(-1)?.user_id,
          finished ? this.config.DISCORD_RECONCILE_SECONDS : 0,
          finished,
        ],
      );
      return count;
    });
  }

  public async stats() {
    const [jobs, history, runtime, members] = await Promise.all([
      this.pool
        .query(`SELECT status,count(*)::int AS count,COALESCE(max(EXTRACT(EPOCH FROM now()-created_at)),0)::float AS oldest_seconds
        FROM discord_sync_jobs GROUP BY status`),
      this.pool.query(
        `SELECT outcome,count(*)::int AS count FROM discord_sync_history GROUP BY outcome`,
      ),
      this.pool.query(
        "SELECT name,heartbeat_at,last_scan_at,next_scan_at FROM discord_runtime WHERE name NOT LIKE 'rate:%'",
      ),
      this.pool.query(
        "SELECT status,count(*)::int AS count FROM discord_member_jobs WHERE guild_id=$1 GROUP BY status",
        [this.config.DISCORD_GUILD_ID],
      ),
    ]);
    return {
      jobs: jobs.rows,
      memberJobs: members.rows,
      outcomes: history.rows,
      workers: runtime.rows,
      mode:
        this.config.DISCORD_ENVIRONMENT === "offline"
          ? "offline-dry-run"
          : this.config.DISCORD_DRY_RUN
            ? "test-guild-dry-run"
            : "test-guild",
    };
  }
}
