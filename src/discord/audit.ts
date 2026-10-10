import { randomUUID } from "node:crypto";
import type { DatabaseClient, DatabasePool } from "../db/pool.js";

export async function discordAudit(
  db: DatabaseClient | DatabasePool,
  action: string,
  userId: string | null,
  metadata: Record<string, unknown> = {},
  correlationId: string = randomUUID(),
  actorId?: string,
): Promise<void> {
  // Callers supply allowlisted structural fields, never raw HTTP bodies/errors or tokens.
  await db.query(
    `INSERT INTO administrative_audit_logs(actor_user_id,actor_type,action,target_type,target_id,correlation_id,metadata)
    VALUES ($1,$2,$3,'discord_account',$4,$5,$6::jsonb)`,
    [
      actorId ?? null,
      actorId ? "user" : "system",
      action,
      userId,
      correlationId,
      JSON.stringify(metadata),
    ],
  );
}
