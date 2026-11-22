import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { groqKeys } from "../db/schema.ts";
import { decrypt, encrypt } from "./secrets.ts";

/** missing: never saved. invalid: Groq rejected it during a sync. ok: syncs use it. */
export type GroqKeyStatus = "missing" | "invalid" | "ok";

/** The user's Groq key, or null when there is none or Groq rejected it. */
export async function loadGroqKey(db: Db, key: Buffer, userId: string): Promise<string | null> {
  const [row] = await db.select().from(groqKeys).where(eq(groqKeys.userId, userId));
  if (!row || row.invalidAt) return null;
  return decrypt(row.keyEncrypted, key);
}

export async function saveGroqKey(db: Db, key: Buffer, userId: string, plaintext: string): Promise<void> {
  const value = {
    keyEncrypted: encrypt(plaintext, key),
    invalidAt: null,
    updatedAt: new Date(),
  };
  await db
    .insert(groqKeys)
    .values({ userId, ...value })
    .onConflictDoUpdate({ target: groqKeys.userId, set: value });
}

export async function markGroqKeyInvalid(db: Db, userId: string): Promise<void> {
  await db.update(groqKeys).set({ invalidAt: new Date() }).where(eq(groqKeys.userId, userId));
}

export async function groqKeyStatus(db: Db, userId: string): Promise<GroqKeyStatus> {
  const [row] = await db.select({ invalidAt: groqKeys.invalidAt }).from(groqKeys).where(eq(groqKeys.userId, userId));
  if (!row) return "missing";
  return row.invalidAt ? "invalid" : "ok";
}
