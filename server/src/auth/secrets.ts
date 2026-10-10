import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const MIN_SECRET_CHARS = 32;
const VERSION = "v1";

/** Turns a secret string of any format into a 32-byte key. `purpose` keeps keys for different uses apart. */
export function deriveKey(secret: string, purpose: string): Buffer {
  if (secret.length < MIN_SECRET_CHARS) {
    throw new Error(`Secret for ${purpose} must be at least ${MIN_SECRET_CHARS} characters`);
  }
  return Buffer.from(hkdfSync("sha256", secret, "", purpose, 32));
}

/** AES-256-GCM. The output carries its own nonce and authentication tag. */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv, ciphertext, cipher.getAuthTag()]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

/** Throws when the value was produced with a different key or has been altered. */
export function decrypt(value: string, key: Buffer): string {
  const [version, iv, ciphertext, tag] = value.split(".");
  if (version !== VERSION || !iv || ciphertext === undefined || !tag) {
    throw new Error("Encrypted value is malformed");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}
