import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import * as schema from "../src/db/schema.ts";
import { createUser, freshDb } from "./helpers/db.ts";

const emailRow = (userId: string, gmailMessageId: string) => ({
  userId,
  gmailMessageId,
  threadId: "thread-1",
  sender: "no-reply@greenhouse.io",
  subject: "Thanks for applying to Acme",
  receivedAt: new Date(),
  processedState: "processed" as const,
});

test("migrations create every table with row-level security on", async () => {
  const db = await freshDb();
  const { rows } = await db.execute<{ relname: string; relrowsecurity: boolean }>(
    "select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname",
  );
  expect(rows.map((r) => r.relname)).toEqual([
    "applications",
    "emails",
    "events",
    "oauth_tokens",
    "review_items",
    "sync_state",
    "users",
  ]);
  expect(rows.filter((r) => !r.relrowsecurity)).toEqual([]);
});

test("an application round-trips with its email and event", async () => {
  const db = await freshDb();
  const user = await createUser(db, "sam");
  const now = new Date();

  const [app] = await db
    .insert(schema.applications)
    .values({ userId: user.id, company: "Acme", role: "Backend Engineer", appliedAt: now, source: "email" })
    .returning();
  expect(app?.status).toBe("applied");

  const [email] = await db
    .insert(schema.emails)
    .values({ ...emailRow(user.id, "msg-1"), applicationId: app!.id })
    .returning();

  await db.insert(schema.events).values({
    userId: user.id,
    applicationId: app!.id,
    kind: "applied",
    source: "email",
    toStatus: "applied",
    emailId: email!.id,
    confidence: 0.97,
    occurredAt: now,
  });

  const events = await db.select().from(schema.events).where(eq(schema.events.applicationId, app!.id));
  expect(events).toHaveLength(1);
  expect(events[0]?.emailId).toBe(email!.id);
});

test("a Gmail message is stored once per user, and separately for each user", async () => {
  const db = await freshDb();
  const sam = await createUser(db, "sam");
  const alex = await createUser(db, "alex");

  await db.insert(schema.emails).values(emailRow(sam.id, "msg-dup"));
  await expect(db.insert(schema.emails).values(emailRow(sam.id, "msg-dup"))).rejects.toThrow();

  const again = await db.insert(schema.emails).values(emailRow(sam.id, "msg-dup")).onConflictDoNothing().returning();
  expect(again).toHaveLength(0);

  const other = await db.insert(schema.emails).values(emailRow(alex.id, "msg-dup")).returning();
  expect(other).toHaveLength(1);
});

test("rows cannot exist without a real user", async () => {
  const db = await freshDb();
  const missingUser = "00000000-0000-0000-0000-000000000000";
  await expect(db.insert(schema.emails).values(emailRow(missingUser, "msg-1"))).rejects.toThrow();
});

test("each user has one cursor and one token", async () => {
  const db = await freshDb();
  const user = await createUser(db, "sam");

  await db.insert(schema.syncState).values({ userId: user.id, historyId: "100" });
  await expect(db.insert(schema.syncState).values({ userId: user.id, historyId: "200" })).rejects.toThrow();

  const token = { userId: user.id, refreshTokenEncrypted: "ciphertext", scope: "gmail.readonly" };
  await db.insert(schema.oauthTokens).values(token);
  await expect(db.insert(schema.oauthTokens).values(token)).rejects.toThrow();
});

test("a Google account can only be registered once", async () => {
  const db = await freshDb();
  await createUser(db, "sam");
  await expect(createUser(db, "sam")).rejects.toThrow();
});

test("deleting a user removes all of their data and nobody else's", async () => {
  const db = await freshDb();
  const sam = await createUser(db, "sam");
  const alex = await createUser(db, "alex");
  const now = new Date();

  for (const user of [sam, alex]) {
    const [app] = await db
      .insert(schema.applications)
      .values({ userId: user.id, company: "Acme", role: "Engineer", appliedAt: now, source: "manual" })
      .returning();
    const [email] = await db.insert(schema.emails).values(emailRow(user.id, "msg-1")).returning();
    await db
      .insert(schema.events)
      .values({ userId: user.id, applicationId: app!.id, kind: "applied", source: "manual", occurredAt: now });
    await db.insert(schema.reviewItems).values({ userId: user.id, emailId: email!.id, reason: "no_match" });
    await db.insert(schema.syncState).values({ userId: user.id, historyId: "1" });
    await db
      .insert(schema.oauthTokens)
      .values({ userId: user.id, refreshTokenEncrypted: "ciphertext", scope: "gmail.readonly" });
  }

  await db.delete(schema.users).where(eq(schema.users.id, sam.id));

  for (const table of [
    schema.applications,
    schema.emails,
    schema.events,
    schema.reviewItems,
    schema.syncState,
    schema.oauthTokens,
  ]) {
    const remaining = await db.select({ userId: table.userId }).from(table);
    expect(remaining).toEqual([{ userId: alex.id }]);
  }
});
