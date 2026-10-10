import { expect, test } from "vitest";
import { decrypt, deriveKey, encrypt } from "../src/auth/secrets.ts";

const secret = "a".repeat(32);
const key = deriveKey(secret, "refresh-token");

test("a value round-trips, and never appears in the ciphertext", () => {
  const encrypted = encrypt("1//refresh-token-value", key);
  expect(encrypted).not.toContain("refresh-token-value");
  expect(decrypt(encrypted, key)).toBe("1//refresh-token-value");
});

test("encrypting the same value twice gives different ciphertexts", () => {
  expect(encrypt("same", key)).not.toBe(encrypt("same", key));
});

test("a different key cannot decrypt", () => {
  const encrypted = encrypt("secret", key);
  expect(() => decrypt(encrypted, deriveKey("b".repeat(32), "refresh-token"))).toThrow();
});

test("the same secret gives unrelated keys for different purposes", () => {
  const encrypted = encrypt("secret", key);
  expect(() => decrypt(encrypted, deriveKey(secret, "session-cookie"))).toThrow();
});

test("a tampered ciphertext is rejected", () => {
  const [version, iv, ciphertext, tag] = encrypt("secret", key).split(".");
  const flipped = Buffer.from(ciphertext!, "base64url");
  flipped[0] = flipped[0]! ^ 1;
  expect(() => decrypt([version, iv, flipped.toString("base64url"), tag].join("."), key)).toThrow();
  expect(() => decrypt("not-encrypted", key)).toThrow("malformed");
});

test("short secrets are refused", () => {
  expect(() => deriveKey("too-short", "session-cookie")).toThrow("at least 32 characters");
});
