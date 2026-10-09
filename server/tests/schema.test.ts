import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";
import * as schema from "../src/db/schema.ts";

const migrationsFolder = path.resolve(import.meta.dirname, "../migrations");

async function freshDb() {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder });
  return db;
}

test("migrations create every table", async () => {
  const db = await freshDb();
  const { rows } = await db.execute<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
  );
  expect(rows.map((r) => r.table_name)).toEqual([
    "applications",
    "emails",
    "events",
    "oauth_tokens",
    "review_items",
    "sync_state",
  ]);
});

test("an application round-trips with its email and event", async () => {
  const db = await freshDb();
  const now = new Date();

  const [app] = await db
    .insert(schema.applications)
    .values({ company: "Acme", role: "Backend Engineer", appliedAt: now, source: "email" })
    .returning();
  expect(app?.status).toBe("applied");

  const [email] = await db
    .insert(schema.emails)
    .values({
      gmailMessageId: "msg-1",
      threadId: "thread-1",
      sender: "no-reply@greenhouse.io",
      subject: "Thanks for applying to Acme",
      receivedAt: now,
      applicationId: app!.id,
    })
    .returning();

  await db.insert(schema.events).values({
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

test("the same Gmail message cannot be stored twice", async () => {
  const db = await freshDb();
  const row = {
    gmailMessageId: "msg-dup",
    threadId: "t",
    sender: "a@b.co",
    subject: "s",
    receivedAt: new Date(),
  };
  await db.insert(schema.emails).values(row);
  await expect(db.insert(schema.emails).values(row)).rejects.toThrow();

  const inserted = await db.insert(schema.emails).values(row).onConflictDoNothing().returning();
  expect(inserted).toHaveLength(0);
});
