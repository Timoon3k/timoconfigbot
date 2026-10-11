import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/** Domain-separated AEAD. Interaction tokens, checkout links and responses never enter logs. */
export class BillingSecrets {
  private readonly key: Buffer;
  public constructor(secret: string) {
    if (secret.length < 32)
      throw new Error("Billing encryption secret is too short.");
    this.key = createHash("sha256")
      .update(`discord-billing-v1:${secret}`)
      .digest();
  }
  public seal(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), data]
      .map((b) => b.toString("base64url"))
      .join(".");
  }
  public open(value: string): string {
    const [iv, tag, data] = value
      .split(".")
      .map((v) => Buffer.from(v, "base64url"));
    if (!iv || !tag || !data) throw new Error("Invalid billing ciphertext.");
    const cipher = createDecipheriv("aes-256-gcm", this.key, iv);
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(data), cipher.final()]).toString(
      "utf8",
    );
  }
}
