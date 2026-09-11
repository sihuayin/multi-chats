import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

export interface CredentialCipher {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

export class AesCredentialCipher implements CredentialCipher {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (!secret) {
      throw new Error("APP_ENCRYPTION_KEY is required");
    }
    this.key = createHash("sha256").update(secret).digest();
  }

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString("base64");
  }

  decrypt(value: string): string {
    const payload = Buffer.from(value, "base64");
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const encrypted = payload.subarray(28);
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  }
}

export function createCredentialCipher(): CredentialCipher {
  const secret =
    process.env.APP_ENCRYPTION_KEY ??
    (process.env.NODE_ENV === "production"
      ? undefined
      : "development-only-encryption-key");
  if (!secret) {
    throw new Error("APP_ENCRYPTION_KEY is required before saving provider credentials");
  }
  return new AesCredentialCipher(secret);
}
