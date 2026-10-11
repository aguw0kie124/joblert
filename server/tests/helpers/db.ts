import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../../src/db/schema.ts";

const migrationsFolder = path.resolve(import.meta.dirname, "../../migrations");

/** An empty in-memory Postgres with every migration applied. */
export async function freshDb() {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder });
  return db;
}

export type TestDb = Awaited<ReturnType<typeof freshDb>>;

/** Gives the user a Gmail cursor, as if their inbox had been synced before. A user without one reads no mail. */
export async function seedCursor(db: TestDb, userId: string) {
  await db.insert(schema.syncState).values({ userId, historyId: "1", lastRunAt: new Date("2026-10-01T00:00:00Z") });
}

export async function createUser(db: TestDb, name: string) {
  const [user] = await db
    .insert(schema.users)
    .values({ googleSub: `sub-${name}`, email: `${name}@example.com` })
    .returning();
  return user!;
}
