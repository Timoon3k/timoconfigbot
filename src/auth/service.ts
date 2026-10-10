import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import type { DatabasePool } from "../db/pool.js";
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
} from "../errors.js";

const scrypt = promisify(scryptCallback);
const emailSchema = z
  .string()
  .trim()
  .email()
  .max(320)
  .transform((value) => value.toLowerCase());
const passwordSchema = z.string().min(12).max(200);
export type AppRole = "customer" | "support" | "admin";
export type AuthenticatedUser = { id: string; email: string; role: AppRole };
export type SessionCredentials = {
  token: string;
  csrfToken: string;
  expiresAt: Date;
};

function digest(value: string, pepper: string): string {
  return createHash("sha256").update(value).update(pepper).digest("hex");
}

export class AuthService {
  public constructor(
    private readonly pool: DatabasePool,
    private readonly passwordPepper: string,
    private readonly sessionPepper: string,
  ) {}

  private async hashPassword(password: string): Promise<string> {
    const valid = passwordSchema.parse(password);
    const salt = randomBytes(16);
    const key = (await scrypt(
      `${valid}${this.passwordPepper}`,
      salt,
      64,
    )) as Buffer;
    return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
  }

  private async verifyPassword(
    password: string,
    encoded: string,
  ): Promise<boolean> {
    const [, saltHex, keyHex] = encoded.split("$");
    if (!saltHex || !keyHex) return false;
    const expected = Buffer.from(keyHex, "hex");
    const actual = (await scrypt(
      `${password}${this.passwordPepper}`,
      Buffer.from(saltHex, "hex"),
      expected.length,
    )) as Buffer;
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }

  public async createUser(
    email: string,
    password: string,
    role: AppRole = "customer",
  ): Promise<AuthenticatedUser> {
    const normalized = emailSchema.parse(email);
    const passwordHash = await this.hashPassword(password);
    try {
      const result = await this.pool.query<AuthenticatedUser>(
        "INSERT INTO app_users(email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email::text, role",
        [normalized, passwordHash, role],
      );
      const user = result.rows[0];
      if (!user) throw new Error("User insert did not return a row.");
      return user;
    } catch (error) {
      if ((error as { code?: string }).code === "23505")
        throw new ConflictError(
          "EMAIL_IN_USE",
          "This email address is already registered.",
        );
      throw error;
    }
  }

  public async login(
    email: string,
    password: string,
    lifetimeHours = 12,
  ): Promise<SessionCredentials> {
    const normalized = emailSchema.parse(email);
    const result = await this.pool.query<
      AuthenticatedUser & { password_hash: string; disabled_at: Date | null }
    >(
      "SELECT id, email::text, role, password_hash, disabled_at FROM app_users WHERE email = $1",
      [normalized],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.disabled_at ||
      !(await this.verifyPassword(password, row.password_hash))
    ) {
      throw new AuthenticationError(
        "INVALID_CREDENTIALS",
        "Invalid email or password.",
      );
    }
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + lifetimeHours * 3_600_000);
    await this.pool.query(
      `INSERT INTO user_sessions(id, user_id, token_hash, csrf_token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        randomUUID(),
        row.id,
        digest(token, this.sessionPepper),
        digest(csrfToken, this.sessionPepper),
        expiresAt,
      ],
    );
    return { token, csrfToken, expiresAt };
  }

  public async authenticate(
    token: string,
    csrfToken?: string,
    requireCsrf = false,
  ): Promise<AuthenticatedUser> {
    if (!token) throw new AuthenticationError();
    const result = await this.pool.query<
      AuthenticatedUser & { csrf_token_hash: string }
    >(
      `SELECT u.id, u.email::text, u.role, s.csrf_token_hash
       FROM user_sessions s JOIN app_users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL`,
      [digest(token, this.sessionPepper)],
    );
    const user = result.rows[0];
    if (!user)
      throw new AuthenticationError(
        "INVALID_SESSION",
        "The session is invalid or expired.",
      );
    if (
      requireCsrf &&
      (!csrfToken ||
        digest(csrfToken, this.sessionPepper) !== user.csrf_token_hash)
    ) {
      throw new AuthenticationError(
        "INVALID_CSRF",
        "The CSRF token is invalid.",
      );
    }
    return { id: user.id, email: user.email, role: user.role };
  }

  public requireAdmin(user: AuthenticatedUser): void {
    if (user.role !== "admin") throw new AuthorizationError();
  }

  public async reauthenticate(userId: string, password: string): Promise<void> {
    passwordSchema.parse(password);
    const row = (
      await this.pool.query<{ password_hash: string }>(
        "SELECT password_hash FROM app_users WHERE id=$1 AND disabled_at IS NULL",
        [userId],
      )
    ).rows[0];
    if (!row || !(await this.verifyPassword(password, row.password_hash))) {
      throw new AuthenticationError(
        "REAUTHENTICATION_FAILED",
        "Please confirm your password.",
      );
    }
  }
}
