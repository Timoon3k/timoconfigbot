import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabaseClient, DatabasePool } from "../db/pool.js";
import { inTransaction } from "../db/pool.js";
import { discordAudit } from "./audit.js";
import { snowflake, type DiscordConfig } from "./config.js";
import { freeMemberRolloutAllows, verifyGuild } from "./policy.js";
import { RoleOperations } from "./operations.js";
import { DiscordFailure, type DiscordAdapter } from "./types.js";
import type { DiscordSyncService } from "./sync.js";

const eventSchema = z.object({
  guild_id: snowflake,
  user: z.object({ id: snowflake }),
  pending: z.boolean().optional(),
  roles: z.array(snowflake).optional(),
});
type MemberJob = {
  guild_id: string;
  discord_user_id: string;
  lease_token: string;
  claimed_version: string;
  attempt_count: number;
};

async function requestVerification(
  db: DatabaseClient,
  guildId: string,
  id: string,
  pending: boolean | null,
  present: boolean,
): Promise<void> {
  await db.query(
    `INSERT INTO discord_member_jobs(guild_id,discord_user_id,pending,present)
    VALUES($1,$2,$3,$4) ON CONFLICT(guild_id,discord_user_id) DO UPDATE SET
    requested_version=discord_member_jobs.requested_version+1,pending=EXCLUDED.pending,present=EXCLUDED.present,
    status=CASE WHEN discord_member_jobs.status IN ('processing','retry','dead_letter') THEN discord_member_jobs.status ELSE 'queued' END,
    available_at=CASE WHEN discord_member_jobs.status IN ('retry','dead_letter') THEN discord_member_jobs.available_at ELSE now() END,
    attempt_count=CASE WHEN discord_member_jobs.status='succeeded' THEN 0 ELSE discord_member_jobs.attempt_count END,updated_at=now()`,
    [guildId, id, pending, present],
  );
}

/** Trusted Gateway input only. No public endpoint can submit a verification event. */
export class MemberVerification {
  public constructor(
    private readonly pool: DatabasePool,
    private readonly config: DiscordConfig,
    private readonly adapter: DiscordAdapter,
    private readonly sync: DiscordSyncService,
  ) {}

  public async dispatch(
    type: string,
    data: unknown,
    session: string,
    sequence: number,
  ): Promise<void> {
    if (
      ![
        "GUILD_MEMBER_ADD",
        "GUILD_MEMBER_UPDATE",
        "GUILD_MEMBER_REMOVE",
      ].includes(type)
    )
      return;
    const event = eventSchema.parse(data);
    if (event.guild_id !== this.config.DISCORD_GUILD_ID) return;
    if (
      !session ||
      session.length > 200 ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0
    )
      throw new DiscordFailure("GATEWAY_EVENT_INVALID");
    const accepted = await inTransaction(this.pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `discord-member:${event.guild_id}:${event.user.id}`,
      ]);
      const saved = await db.query(
        `INSERT INTO discord_gateway_events(guild_id,session_id,sequence)
        VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [event.guild_id, session, sequence],
      );
      if (!saved.rowCount) return false;
      // New join/leave invalidates old ownership; a later manual assignment must not be adopted.
      if (type !== "GUILD_MEMBER_UPDATE") {
        await db.query(
          "DELETE FROM discord_role_ownership WHERE guild_id=$1 AND discord_user_id=$2",
          [event.guild_id, event.user.id],
        );
        await db.query(
          `UPDATE discord_role_operations SET status='obsolete'
          WHERE guild_id=$1 AND discord_user_id=$2`,
          [event.guild_id, event.user.id],
        );
      } else if (event.roles) {
        await db.query(
          `DELETE FROM discord_role_ownership WHERE guild_id=$1 AND discord_user_id=$2 AND NOT(role_id=ANY($3::text[]))`,
          [event.guild_id, event.user.id, event.roles],
        );
        await db.query(
          `UPDATE discord_role_operations SET status='obsolete' WHERE guild_id=$1 AND discord_user_id=$2
          AND NOT(role_id=ANY($3::text[])) AND operation='add' AND status='confirmed'`,
          [event.guild_id, event.user.id, event.roles],
        );
      }
      await requestVerification(
        db,
        event.guild_id,
        event.user.id,
        event.pending ?? null,
        type !== "GUILD_MEMBER_REMOVE",
      );
      await discordAudit(db, "DISCORD_MEMBER_EVENT_ACCEPTED", null, {
        guildId: event.guild_id,
        memberId: event.user.id,
        type,
        pending: event.pending ?? null,
      });
      return true;
    });
    // Outside the member lock: payment processing locks the app user before locking the member.
    if (accepted && type !== "GUILD_MEMBER_REMOVE")
      await this.sync.memberRejoined(
        event.guild_id,
        event.user.id,
        `${session}:${sequence}`,
      );
  }

  /** Full guild REST inventory, not just linked customers. Persistent cursor repairs missed Gateway events. */
  public async reconcileBatch(): Promise<number> {
    if (!this.config.DISCORD_VERIFICATION_ENABLED) return 0;
    return inTransaction(this.pool, async (db) => {
      const name = `members:${this.config.DISCORD_GUILD_ID}`;
      await db.query(
        "INSERT INTO discord_runtime(name) VALUES($1) ON CONFLICT DO NOTHING",
        [name],
      );
      const state = (
        await db.query<{ cursor: string | null; due: boolean }>(
          "SELECT member_cursor AS cursor,next_scan_at<=clock_timestamp() AS due FROM discord_runtime WHERE name=$1 FOR UPDATE",
          [name],
        )
      ).rows[0]!;
      if (!state.due) return 0;
      const members = await this.adapter.listMembers(
        state.cursor ?? "0",
        this.config.DISCORD_RECONCILE_BATCH_SIZE,
      );
      const ids = members.map((m) => BigInt(m.id));
      if (
        ids.some(
          (id, i) =>
            id <= BigInt(state.cursor ?? "0") || (i > 0 && id <= ids[i - 1]!),
        )
      )
        throw new DiscordFailure("MEMBER_PAGE_INVALID");
      for (const member of members)
        await requestVerification(
          db,
          this.config.DISCORD_GUILD_ID,
          member.id,
          member.pending ?? null,
          true,
        );
      const finished =
        members.length < this.config.DISCORD_RECONCILE_BATCH_SIZE;
      await db.query(
        `UPDATE discord_runtime SET member_cursor=$2,next_scan_at=clock_timestamp()+$3*interval '1 second',
        last_scan_at=CASE WHEN $4 THEN clock_timestamp() ELSE last_scan_at END WHERE name=$1`,
        [
          name,
          finished ? null : members.at(-1)?.id,
          finished ? this.config.DISCORD_RECONCILE_SECONDS : 0,
          finished,
        ],
      );
      return members.length;
    });
  }

  public async runOne(): Promise<boolean> {
    if (!this.config.DISCORD_VERIFICATION_ENABLED) return false;
    const job = await inTransaction(this.pool, async (db) => {
      await db.query(
        `UPDATE discord_member_jobs SET status=CASE WHEN attempt_count >= $2 THEN 'dead_letter' ELSE 'retry' END,
        lease_token=NULL,lease_expires_at=NULL,last_error_code='LEASE_EXPIRED'
        WHERE guild_id=$1 AND status='processing' AND lease_expires_at<clock_timestamp()`,
        [this.config.DISCORD_GUILD_ID, this.config.DISCORD_MAX_ATTEMPTS],
      );
      return (
        await db.query<MemberJob>(
          `WITH candidate AS (SELECT guild_id,discord_user_id FROM discord_member_jobs
        WHERE guild_id=$1 AND status IN ('queued','retry') AND attempt_count<$4 AND available_at<=clock_timestamp()
        ORDER BY available_at,discord_user_id LIMIT 1 FOR UPDATE SKIP LOCKED)
        UPDATE discord_member_jobs j SET status='processing',lease_token=$2,lease_expires_at=clock_timestamp()+$3*interval '1 second',
        claimed_version=requested_version,attempt_count=attempt_count+1 FROM candidate c
        WHERE j.guild_id=c.guild_id AND j.discord_user_id=c.discord_user_id RETURNING j.*`,
          [
            this.config.DISCORD_GUILD_ID,
            randomUUID(),
            this.config.DISCORD_LEASE_SECONDS,
            this.config.DISCORD_MAX_ATTEMPTS,
          ],
        )
      ).rows[0];
    });
    if (!job) return false;
    try {
      const verified = await inTransaction(this.pool, async (db) => {
        // Lock member first, matching Gateway handlers; only then lock the job row.
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `discord-member:${job.guild_id}:${job.discord_user_id}`,
        ]);
        const current = await db.query(
          `SELECT 1 FROM discord_member_jobs WHERE guild_id=$1 AND discord_user_id=$2
          AND lease_token=$3 AND status='processing' AND lease_expires_at>clock_timestamp() FOR UPDATE`,
          [job.guild_id, job.discord_user_id, job.lease_token],
        );
        if (!current.rowCount) return;
        verifyGuild(this.config, await this.adapter.inspectGuild());
        const member = await this.adapter.getMember(job.discord_user_id);
        if (member && member.id !== job.discord_user_id)
          throw new DiscordFailure("MEMBER_IDENTITY_MISMATCH");
        const eligibleWithoutRollout =
          member?.pending === false &&
          !member.bot &&
          member.id !== this.config.DISCORD_CLIENT_ID &&
          !member.roles.includes(this.config.DISCORD_FREE_MEMBER_ROLE_ID);
        const rolloutAllowed = freeMemberRolloutAllows(this.config, job.discord_user_id);
        const shouldAdd = eligibleWithoutRollout && rolloutAllowed;
        const outcome = !member
          ? "member_absent"
          : member.bot || member.id === this.config.DISCORD_CLIENT_ID
            ? "bot_excluded"
            : member.pending !== false
              ? "screening_pending_or_unknown"
              : !eligibleWithoutRollout
                ? "noop"
                : !rolloutAllowed
                  ? "rollout_excluded"
                  : this.config.DISCORD_DRY_RUN
                  ? "preview"
                  : "applied";
        await discordAudit(this.pool, "DISCORD_VERIFICATION_PLANNED", null, {
          memberId: job.discord_user_id,
          pending: member?.pending ?? null,
          roleId: this.config.DISCORD_FREE_MEMBER_ROLE_ID,
          outcome,
          dryRun: this.config.DISCORD_DRY_RUN,
        });
        if (shouldAdd && !this.config.DISCORD_DRY_RUN)
          await new RoleOperations(this.pool, this.config, this.adapter).apply(
            db,
            job.discord_user_id,
            this.config.DISCORD_FREE_MEMBER_ROLE_ID,
            "add",
            null,
          );
        if (!member) {
          await db.query(
            "DELETE FROM discord_role_ownership WHERE guild_id=$1 AND discord_user_id=$2",
            [job.guild_id, job.discord_user_id],
          );
          await db.query(
            "UPDATE discord_role_operations SET status='obsolete' WHERE guild_id=$1 AND discord_user_id=$2",
            [job.guild_id, job.discord_user_id],
          );
        }
        await db.query(
          `UPDATE discord_member_jobs SET processed_version=$4,status=CASE WHEN requested_version>$4 THEN 'queued' ELSE 'succeeded' END,
          pending=$5,present=$6,last_error_code=NULL,lease_token=NULL,lease_expires_at=NULL,attempt_count=0,available_at=now(),updated_at=now()
          WHERE guild_id=$1 AND discord_user_id=$2 AND lease_token=$3`,
          [
            job.guild_id,
            job.discord_user_id,
            job.lease_token,
            job.claimed_version,
            member?.pending ?? null,
            !!member,
          ],
        );
        return (
          !!member &&
          member.pending === false &&
          !member.bot &&
          member.id !== this.config.DISCORD_CLIENT_ID
        );
      });
      // Repair missed screening/rejoin events for linked VIPs, including prior screening dead letters.
      if (verified)
        await this.sync.memberRejoined(
          job.guild_id,
          job.discord_user_id,
          `screening:${job.discord_user_id}:${job.claimed_version}`,
        );
    } catch (error) {
      const failure =
        error instanceof DiscordFailure
          ? error
          : new DiscordFailure("MEMBER_VERIFICATION_FAILED", true);
      await this.pool.query(
        `UPDATE discord_member_jobs SET status=$4,last_error_code=$5,
        available_at=clock_timestamp()+$6*interval '1 millisecond',lease_token=NULL,lease_expires_at=NULL,updated_at=now()
        WHERE guild_id=$1 AND discord_user_id=$2 AND lease_token=$3`,
        [
          job.guild_id,
          job.discord_user_id,
          job.lease_token,
          failure.retryable &&
          job.attempt_count < this.config.DISCORD_MAX_ATTEMPTS
            ? "retry"
            : "dead_letter",
          failure.code,
          Math.max(
            failure.retryAfterMs,
            Math.min(300000, 1000 * 2 ** job.attempt_count),
          ),
        ],
      );
      await discordAudit(this.pool, "DISCORD_VERIFICATION_FAILED", null, {
        memberId: job.discord_user_id,
        errorCode: failure.code,
      });
    }
    return true;
  }
}
