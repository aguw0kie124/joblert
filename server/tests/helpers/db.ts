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

export async function createUser(db: TestDb, name: string) {
  const [user] = await db
    .insert(schema.users)
    .values({ googleSub: `sub-${name}`, email: `${name}@example.com` })
    .returning();
  return user!;
}
