import { randomUUID } from "node:crypto";
import { inTransaction, type DatabaseClient } from "../db/pool.js";
import { discordAudit } from "../discord/audit.js";
import type { DiscordConfig } from "../discord/config.js";
import { roleDiff, verifyGuild } from "../discord/policy.js";
import {
  assertTestGuildNetwork,
  discordResponse,
  type RestDiscordAdapter,
} from "../discord/rest.js";
import type { DiscordAdapter } from "../discord/types.js";
import { PostgresDiscordRateGate } from "../discord/transport.js";
import { assertPaidRolePolicy, type BillingConfig } from "./config.js";
import { BillingFailure, requireBilling } from "./stripe.js";
import { BillingService, type Principal } from "./service.js";

export interface PaidRoleAccess {
  reader: Pick<DiscordAdapter, "getMember" | "inspectGuild">;
  mutate(
    memberId: string,
    roleId: string,
    action: "add" | "remove",
  ): Promise<void>;
}
/** Separate VIP-only transport. Existing Free Member transport/configuration are deliberately unchanged. */
export class PaidRoleRest implements PaidRoleAccess {
  public constructor(
    public readonly reader: RestDiscordAdapter,
    private readonly discord: DiscordConfig,
    private readonly billing: BillingConfig,
    private readonly token: string,
    private readonly gate: PostgresDiscordRateGate,
    private readonly request: typeof fetch = fetch,
  ) {}
  public async mutate(
    memberId: string,
    roleId: string,
    action: "add" | "remove",
  ): Promise<void> {
    assertPaidRolePolicy(this.billing, this.discord, memberId, roleId);
    assertTestGuildNetwork(this.discord);
    verifyGuild(this.discord, await this.reader.inspectGuild());
    const member = await this.reader.getMember(memberId);
    requireBilling(
      member &&
        member.pending === false &&
        !member.bot &&
        memberId !== this.discord.DISCORD_CLIENT_ID,
      "STRIPE_ROLE_MEMBER_NOT_ELIGIBLE",
    );
    requireBilling(
      action === "add"
        ? !member.roles.includes(roleId)
        : member.roles.includes(roleId),
      "STRIPE_ROLE_STATE_RACE",
    );
    const wait = await this.gate.reserve();
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    const response = await this.request(
      `https://discord.com/api/v10/guilds/${this.discord.DISCORD_GUILD_ID}/members/${memberId}/roles/${roleId}`,
      {
        method: action === "add" ? "PUT" : "DELETE",
        headers: { Authorization: `Bot ${this.token}` },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      },
    );
    try {
      await discordResponse(response);
    } catch (error) {
      if (response.status === 429) await this.gate.defer(5000);
      throw error;
    }
    const after = await this.reader.getMember(memberId);
    requireBilling(
      after && after.roles.includes(roleId) === (action === "add"),
      "STRIPE_ROLE_WRITE_UNCONFIRMED",
      true,
    );
  }
}
export class BillingVipSync {
  public constructor(
    private readonly billing: BillingService,
    private readonly discord: DiscordConfig,
    private readonly access?: PaidRoleAccess,
  ) {}
  public async runOne(): Promise<boolean> {
    const c = this.billing.config;
    if (!c.STRIPE_WEBHOOKS_ENABLED) return false;
    const p = (
      await this.billing.pool.query<Principal>(
        `SELECT p.* FROM discord_billing_principals p
      JOIN stripe_vip_sync_state s ON s.principal_id=p.id WHERE p.guild_id=$1 AND p.stripe_account_id=$2 AND p.mode=$3
      AND s.checked_at<now()-interval '60 seconds' ORDER BY s.checked_at,p.id LIMIT 1`,
        [this.discord.DISCORD_GUILD_ID, c.STRIPE_ACCOUNT_ID!, c.STRIPE_MODE],
      )
    ).rows[0];
    if (!p) return false;
    await inTransaction(this.billing.pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `discord-member:${p.guild_id}:${p.discord_user_id}`,
      ]);
      await db.query(
        "SELECT 1 FROM discord_billing_principals WHERE id=$1 FOR NO KEY UPDATE",
        [p.id],
      );
      const due = await db.query(
        "SELECT 1 FROM stripe_vip_sync_state WHERE principal_id=$1 AND checked_at<now()-interval '60 seconds' FOR UPDATE",
        [p.id],
      );
      if (!due.rowCount) return;
      const tier = await this.billing.tier(db, p.id);
      let outcome = "preview";
      let code: string | null = null;
      try {
        if (c.DISCORD_BILLING_VIP_WRITES_ENABLED) {
          requireBilling(this.access, "STRIPE_ROLE_ADAPTER_NOT_AVAILABLE");
          assertPaidRolePolicy(
            c,
            this.discord,
            p.discord_user_id,
            this.discord.DISCORD_VIP_MONTHLY_ROLE_ID,
          );
          verifyGuild(this.discord, await this.access.reader.inspectGuild());
          const member = await this.access.reader.getMember(p.discord_user_id);
          requireBilling(
            member &&
              !member.bot &&
              member.pending === false &&
              member.id !== this.discord.DISCORD_CLIENT_ID,
            "STRIPE_ROLE_MEMBER_NOT_ELIGIBLE",
            true,
          );
          await this.recover(db, p, member.roles);
          const uncertain = await db.query(
            "SELECT 1 FROM discord_role_operations WHERE billing_principal_id=$1 AND status IN ('intent','uncertain')",
            [p.id],
          );
          requireBilling(
            !uncertain.rowCount,
            "STRIPE_ROLE_OPERATION_UNCERTAIN",
          );
          const diff = roleDiff(this.discord, member.roles, tier);
          for (const roleId of diff.add) await this.apply(db, p, roleId, "add");
          for (const roleId of diff.remove) {
            const owned = await db.query(
              "SELECT 1 FROM stripe_vip_role_ownership WHERE principal_id=$1 AND role_id=$2",
              [p.id, roleId],
            );
            if (owned.rowCount) await this.apply(db, p, roleId, "remove");
          }
          outcome = "confirmed";
        }
      } catch (error) {
        outcome = "blocked";
        code =
          error instanceof BillingFailure
            ? error.code
            : "STRIPE_ROLE_SYNC_REVIEW_REQUIRED";
      }
      await db.query(
        "UPDATE stripe_vip_sync_state SET checked_at=now(),outcome=$2,error_code=$3 WHERE principal_id=$1",
        [p.id, outcome, code],
      );
      await discordAudit(db, "STRIPE_VIP_SYNC_CHECKED", null, {
        principalId: p.id,
        tier,
        outcome,
        code,
        approval: c.DISCORD_BILLING_VIP_APPROVAL_REFERENCE ?? null,
      });
    });
    return true;
  }
  private async recover(
    db: DatabaseClient,
    p: Principal,
    roles: string[],
  ): Promise<void> {
    await db.query(
      `DELETE FROM stripe_vip_role_ownership own USING discord_role_operations o
      WHERE own.principal_id=$1 AND o.billing_principal_id=own.principal_id AND o.role_id=own.role_id
      AND o.operation='remove' AND o.status='confirmed'
      AND NOT EXISTS(SELECT 1 FROM discord_role_operations later WHERE later.billing_principal_id=o.billing_principal_id
        AND later.role_id=o.role_id AND later.created_at>o.created_at)`,
      [p.id],
    );
    await db.query(
      `INSERT INTO stripe_vip_role_ownership(principal_id,role_id,operation_id)
      SELECT o.billing_principal_id,o.role_id,o.id FROM discord_role_operations o WHERE o.billing_principal_id=$1
      AND o.status='confirmed' AND o.operation='add' AND o.role_id=ANY($2::text[])
      AND NOT EXISTS(SELECT 1 FROM discord_role_operations later WHERE later.billing_principal_id=o.billing_principal_id
        AND later.role_id=o.role_id AND later.created_at>o.created_at) ON CONFLICT DO NOTHING`,
      [p.id, roles],
    );
  }
  private async apply(
    db: DatabaseClient,
    p: Principal,
    roleId: string,
    action: "add" | "remove",
  ): Promise<void> {
    assertPaidRolePolicy(
      this.billing.config,
      this.discord,
      p.discord_user_id,
      roleId,
    );
    const uncertain = await db.query(
      "SELECT 1 FROM discord_role_operations WHERE billing_principal_id=$1 AND role_id=$2 AND status IN ('intent','uncertain')",
      [p.id, roleId],
    );
    requireBilling(!uncertain.rowCount, "STRIPE_ROLE_OPERATION_UNCERTAIN");
    const operationId = randomUUID();
    // Committed evidence remains recoverable even if the surrounding entitlement/ownership transaction fails.
    await inTransaction(this.billing.pool, async (journal) => {
      await journal.query(
        `INSERT INTO discord_role_operations(id,guild_id,discord_user_id,role_id,operation,billing_principal_id,approval_reference)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          operationId,
          p.guild_id,
          p.discord_user_id,
          roleId,
          action,
          p.id,
          this.billing.config.DISCORD_BILLING_VIP_APPROVAL_REFERENCE!,
        ],
      );
      await discordAudit(journal, "STRIPE_VIP_ROLE_INTENT", null, {
        principalId: p.id,
        operationId,
        roleId,
        action,
      });
    });
    try {
      await this.access!.mutate(p.discord_user_id, roleId, action);
      await this.billing.pool.query(
        "UPDATE discord_role_operations SET status='confirmed',confirmed_at=now() WHERE id=$1",
        [operationId],
      );
      if (action === "add")
        await db.query(
          "INSERT INTO stripe_vip_role_ownership(principal_id,role_id,operation_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [p.id, roleId, operationId],
        );
      else
        await db.query(
          "DELETE FROM stripe_vip_role_ownership WHERE principal_id=$1 AND role_id=$2",
          [p.id, roleId],
        );
      await discordAudit(db, "STRIPE_VIP_ROLE_CONFIRMED", null, {
        principalId: p.id,
        operationId,
        roleId,
        action,
      });
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : null;
      const rejected = [
        "DISCORD_RATE_LIMITED",
        "DISCORD_PERMISSION_DENIED",
        "DISCORD_INVALID_REQUEST",
        "STRIPE_ROLE_STATE_RACE",
        "STRIPE_ROLE_MEMBER_NOT_ELIGIBLE",
      ].includes(String(code));
      await this.billing.pool.query(
        "UPDATE discord_role_operations SET status=$2 WHERE id=$1 AND status='intent'",
        [operationId, rejected ? "obsolete" : "uncertain"],
      );
      throw error;
    }
  }
}

export class BillingWorker {
  public constructor(
    private readonly billing: BillingService,
    private readonly interactions: { runOne(): Promise<boolean> },
    private readonly vip: BillingVipSync,
  ) {}
  public async tick(): Promise<number> {
    // A failure in one optional billing stage must not block the other queues (or Free Member).
    let count = 0;
    for (const stage of [
      () => this.billing.recoverOrder(),
      () => this.billing.processOne(),
      () => this.interactions.runOne(),
      () => this.vip.runOne(),
    ]) {
      try {
        count += Number(await stage());
      } catch {
        /* Durable queues retain work; no provider errors/secrets logged. */
      }
    }
    return count;
  }
}
