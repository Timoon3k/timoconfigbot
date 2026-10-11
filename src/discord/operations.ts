import { randomUUID } from "node:crypto";
import type { DatabaseClient, DatabasePool } from "../db/pool.js";
import { inTransaction } from "../db/pool.js";
import { discordAudit } from "./audit.js";
import type { DiscordConfig } from "./config.js";
import { assertTestGuildWrites } from "./rest.js";
import { assertRole, freeMemberRolloutAllows } from "./policy.js";
import { DiscordFailure, type DiscordAdapter } from "./types.js";

/** Callers hold the member advisory lock and (for VIP) the membership user row lock. */
export class RoleOperations {
  public constructor(
    private readonly pool: DatabasePool,
    private readonly config: DiscordConfig,
    private readonly adapter: DiscordAdapter,
  ) {}

  public async apply(
    db: DatabaseClient,
    memberId: string,
    roleId: string,
    operation: "add" | "remove",
    userId: string | null,
  ): Promise<void> {
    assertTestGuildWrites(this.config, roleId);
    assertRole(this.config, roleId);
    if (
      operation === "add" &&
      roleId === this.config.DISCORD_FREE_MEMBER_ROLE_ID &&
      !freeMemberRolloutAllows(this.config, memberId)
    )
      throw new DiscordFailure("FREE_MEMBER_ROLLOUT_RESTRICTED");
    if (this.adapter.kind !== "rest")
      throw new DiscordFailure("LIVE_ADAPTER_REQUIRED");
    if (operation === "remove") {
      if (roleId === this.config.DISCORD_FREE_MEMBER_ROLE_ID)
        throw new DiscordFailure("FREE_MEMBER_REMOVAL_FORBIDDEN");
      const owned = await db.query(
        `SELECT 1 FROM discord_role_ownership
        WHERE guild_id=$1 AND discord_user_id=$2 AND role_id=$3 AND user_id=$4
        AND source IN ('bot_assignment','approved_migration')`,
        [this.config.DISCORD_GUILD_ID, memberId, roleId, userId],
      );
      if (!owned.rowCount) throw new DiscordFailure("ROLE_OWNERSHIP_UNKNOWN");
      const uncertain = await db.query(
        `SELECT 1 FROM discord_role_operations WHERE guild_id=$1
        AND discord_user_id=$2 AND role_id=$3 AND operation='remove' AND status IN ('intent','uncertain')`,
        [this.config.DISCORD_GUILD_ID, memberId, roleId],
      );
      if (uncertain.rowCount)
        throw new DiscordFailure("ROLE_OPERATION_UNCERTAIN");
    }
    const id = randomUUID();
    // Separate committed transaction: intent must remain visible even if the caller rolls back.
    await inTransaction(this.pool, async (journal) => {
      await journal.query(
        `INSERT INTO discord_role_operations(id,guild_id,discord_user_id,role_id,user_id,operation,approval_reference)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          this.config.DISCORD_GUILD_ID,
          memberId,
          roleId,
          userId,
          operation,
          this.config.DISCORD_ENVIRONMENT === "production"
            ? this.config.DISCORD_FREE_MEMBER_APPROVAL_REFERENCE
            : this.config.DISCORD_APPROVAL_REFERENCE,
        ],
      );
      await discordAudit(journal, "DISCORD_ROLE_EXECUTION_INTENT", userId, {
        operationId: id,
        memberId,
        roleId,
        operation,
        mode: this.config.DISCORD_ENVIRONMENT,
      });
    });
    try {
      if (operation === "add") await this.adapter.addRole(memberId, roleId);
      else await this.adapter.removeRole(memberId, roleId);
      await this.pool.query(
        `UPDATE discord_role_operations SET status='confirmed',confirmed_at=now() WHERE id=$1`,
        [id],
      );
      if (userId && operation === "add")
        await db.query(
          `INSERT INTO discord_role_ownership
        (guild_id,discord_user_id,role_id,user_id,source,approval_reference)
        VALUES($1,$2,$3,$4,'bot_assignment',$5) ON CONFLICT DO NOTHING`,
          [this.config.DISCORD_GUILD_ID, memberId, roleId, userId, id],
        );
      if (operation === "remove")
        await db.query(
          `DELETE FROM discord_role_ownership
        WHERE guild_id=$1 AND discord_user_id=$2 AND role_id=$3 AND user_id=$4`,
          [this.config.DISCORD_GUILD_ID, memberId, roleId, userId],
        );
      await discordAudit(
        this.pool,
        "DISCORD_ROLE_EXECUTION_CONFIRMED",
        userId,
        { operationId: id, memberId, roleId, operation },
      );
    } catch (error) {
      await this.pool.query(
        "UPDATE discord_role_operations SET status='uncertain' WHERE id=$1 AND status='intent'",
        [id],
      );
      throw error;
    }
  }

  /** Only a confirmed API operation can repair ownership after a database commit failure. */
  public async recoverOwnership(
    db: DatabaseClient,
    userId: string,
    memberId: string,
    roles: string[],
  ): Promise<void> {
    if (this.config.DISCORD_DRY_RUN) return;
    await db.query(
      `INSERT INTO discord_role_ownership(guild_id,discord_user_id,role_id,user_id,source,approval_reference)
      SELECT o.guild_id,o.discord_user_id,o.role_id,o.user_id,'bot_assignment',o.id::text
      FROM discord_role_operations o WHERE o.guild_id=$1 AND o.discord_user_id=$2 AND o.user_id=$3
      AND o.role_id=ANY($4::text[]) AND o.operation='add' AND o.status='confirmed'
      AND NOT EXISTS(SELECT 1 FROM discord_role_operations later WHERE later.guild_id=o.guild_id
        AND later.discord_user_id=o.discord_user_id AND later.role_id=o.role_id AND later.created_at>o.created_at)
      ON CONFLICT DO NOTHING`,
      [this.config.DISCORD_GUILD_ID, memberId, userId, roles],
    );
  }
}
