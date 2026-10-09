import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadConfig } from "../config.ts";
import { createDb } from "./client.ts";

// Resolves to server/migrations from both src/db and dist/db.
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../migrations");

const { db, pool } = createDb(loadConfig().DATABASE_URL);
try {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  console.log("Migrations applied.");
} finally {
  await pool.end();
}
