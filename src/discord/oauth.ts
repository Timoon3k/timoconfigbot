import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { AuthService } from "../auth/service.js";
import { inTransaction, type DatabasePool } from "../db/pool.js";
import { ConflictError } from "../errors.js";
import { discordAudit } from "./audit.js";
import { enqueueSync } from "./queue.js";
import { pkceChallenge, type DiscordOAuthProvider } from "./oauth-provider.js";
import { DiscordFailure } from "./types.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
type StateRow = {
  user_id: string;
  verifier_ciphertext: string;
  expected_discord_id: string | null;
  replacement_confirmed: boolean;
};

export class DiscordLinkService {
  private readonly key: Buffer;
  public constructor(
    private readonly pool: DatabasePool,
    private readonly auth: AuthService,
    public readonly provider: DiscordOAuthProvider,
    encryptionSecret: string,
  ) {
    if (encryptionSecret.length < 32)
      throw new Error(
        "OAuth encryption secret must have at least 32 characters.",
      );
    this.key = createHash("sha256")
      .update(`discord-oauth-v1:${encryptionSecret}`)
      .digest();
  }
  private binding(session: string): string {
    return createHmac("sha256", this.key).update(session).digest("hex");
  }
  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    return Buffer.concat([
      iv,
      cipher.update(value),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64");
  }
  private decrypt(value: string): string {
    const bytes = Buffer.from(value, "base64");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      bytes.subarray(0, 12),
    );
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([
      decipher.update(bytes.subarray(12, -16)),
      decipher.final(),
    ]).toString("utf8");
  }
  public async begin(
    session: string,
    csrf: string,
    password: string,
    confirmReplacement = false,
  ) {
    const user = await this.auth.authenticate(session, csrf, true);
    await this.auth.reauthenticate(user.id, password);
    const current = (
      await this.pool.query<{ discord_user_id: string }>(
        "SELECT discord_user_id FROM discord_accounts WHERE user_id=$1 AND unlinked_at IS NULL",
        [user.id],
      )
    ).rows[0];
    if (current && !confirmReplacement)
      throw new ConflictError(
        "REPLACEMENT_CONFIRMATION_REQUIRED",
        "Confirm replacement of your linked Discord account.",
      );
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    await inTransaction(this.pool, async (db) => {
      await db.query(
        `INSERT INTO discord_oauth_states(state_hash,user_id,session_binding,verifier_ciphertext,
        expected_discord_id,replacement_confirmed,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '5 minutes')`,
        [
          hash(state),
          user.id,
          this.binding(session),
          this.encrypt(verifier),
          current?.discord_user_id ?? null,
          confirmReplacement,
        ],
      );
      await discordAudit(
        db,
        "DISCORD_OAUTH_STARTED",
        user.id,
        { replacement: !!current },
        randomUUID(),
        user.id,
      );
    });
    return {
      authorizationUrl: this.provider.authorizationUrl(
        state,
        pkceChallenge(verifier),
      ),
      mode: "offline-mock",
    };
  }
  public async complete(session: string, state: string, code: string) {
    const user = await this.auth.authenticate(session);
    try {
      // Consume before exchanging the code: even failures require a fresh linking ceremony.
      const result = await this.pool.query<StateRow>(
        `UPDATE discord_oauth_states SET consumed_at=now()
        WHERE state_hash=$1 AND user_id=$2 AND session_binding=$3 AND consumed_at IS NULL AND expires_at>now()
        RETURNING user_id,verifier_ciphertext,expected_discord_id,replacement_confirmed`,
        [hash(state), user.id, this.binding(session)],
      );
      const attempt = result.rows[0];
      if (!attempt) throw new DiscordFailure("OAUTH_STATE_INVALID");
      const discordId = await this.provider.identify(
        code,
        this.decrypt(attempt.verifier_ciphertext),
      );
      return await inTransaction(this.pool, async (db) => {
        await db.query("SELECT id FROM app_users WHERE id=$1 FOR UPDATE", [
          user.id,
        ]);
        const previous =
          (
            await db.query<{ discord_user_id: string }>(
              "SELECT discord_user_id FROM discord_accounts WHERE user_id=$1 AND unlinked_at IS NULL",
              [user.id],
            )
          ).rows[0]?.discord_user_id ?? null;
        if (
          previous !== attempt.expected_discord_id ||
          (previous && !attempt.replacement_confirmed)
        ) {
          throw new ConflictError(
            "IDENTITY_CHANGED",
            "Your Discord connection changed. Start again.",
          );
        }
        await db.query(
          `INSERT INTO discord_identity_reservations(discord_user_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
          [discordId, user.id],
        );
        const reservation = (
          await db.query<{ user_id: string }>(
            "SELECT user_id FROM discord_identity_reservations WHERE discord_user_id=$1 FOR UPDATE",
            [discordId],
          )
        ).rows[0];
        if (reservation?.user_id !== user.id)
          throw new ConflictError(
            "DISCORD_ACCOUNT_IN_USE",
            "This Discord account is associated with another account.",
          );
        if (previous && previous !== discordId)
          await enqueueSync(
            db,
            user.id,
            "identity_replaced_cleanup",
            randomUUID(),
            previous,
          );
        await db.query(
          `INSERT INTO discord_accounts(user_id,discord_user_id) VALUES($1,$2)
          ON CONFLICT(user_id) DO UPDATE SET discord_user_id=EXCLUDED.discord_user_id,linked_at=now(),unlinked_at=NULL`,
          [user.id, discordId],
        );
        await enqueueSync(db, user.id, "discord_account_linked");
        await discordAudit(
          db,
          "DISCORD_ACCOUNT_LINKED",
          user.id,
          { discordUserId: discordId, replacedDiscordUserId: previous },
          randomUUID(),
          user.id,
        );
        return { linked: true, discordUserId: discordId };
      });
    } catch (error) {
      const code =
        error instanceof DiscordFailure || error instanceof ConflictError
          ? error.code
          : "OAUTH_LINK_FAILED";
      await discordAudit(
        this.pool,
        "DISCORD_OAUTH_FAILED",
        user.id,
        { errorCode: code },
        randomUUID(),
        user.id,
      );
      if ((error as { code?: string }).code === "23505")
        throw new ConflictError(
          "DISCORD_ACCOUNT_IN_USE",
          "This Discord account is already linked.",
        );
      throw error;
    }
  }
  public async unlink(
    session: string,
    csrf: string,
    password: string,
  ): Promise<void> {
    const user = await this.auth.authenticate(session, csrf, true);
    await this.auth.reauthenticate(user.id, password);
    await inTransaction(this.pool, async (db) => {
      await db.query("SELECT id FROM app_users WHERE id=$1 FOR UPDATE", [
        user.id,
      ]);
      const row = (
        await db.query<{ discord_user_id: string }>(
          `UPDATE discord_accounts SET unlinked_at=now()
        WHERE user_id=$1 AND unlinked_at IS NULL RETURNING discord_user_id`,
          [user.id],
        )
      ).rows[0];
      if (row) {
        await enqueueSync(
          db,
          user.id,
          "discord_account_unlinked",
          randomUUID(),
          row.discord_user_id,
        );
        await discordAudit(
          db,
          "DISCORD_ACCOUNT_UNLINKED",
          user.id,
          { discordUserId: row.discord_user_id },
          randomUUID(),
          user.id,
        );
      }
    });
  }
  public async status(userId: string) {
    const result = await this.pool.query<{
      discord_user_id: string;
      linked_at: Date;
    }>(
      "SELECT discord_user_id,linked_at FROM discord_accounts WHERE user_id=$1 AND unlinked_at IS NULL",
      [userId],
    );
    const row = result.rows[0];
    return {
      linked: !!row,
      discordUserId: row?.discord_user_id ?? null,
      linkedAt: row?.linked_at ?? null,
    };
  }
}
