import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import type { Config } from "../config.ts";
import * as schema from "./schema.ts";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Hosted Postgres is always reached over TLS. Providers such as Supabase sign with their own CA, so the
 * certificate is only verified when that CA is supplied via DATABASE_CA_CERT; otherwise the connection is
 * encrypted but the server's identity is not checked.
 */
export function sslOptions(databaseUrl: string, caCertPath?: string): pg.PoolConfig["ssl"] {
  if (LOCAL_HOSTS.has(new URL(databaseUrl).hostname)) return false;
  return caCertPath ? { ca: readFileSync(caCertPath, "utf8") } : { rejectUnauthorized: false };
}

export function createDb(config: Pick<Config, "DATABASE_URL" | "DATABASE_CA_CERT">) {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    ssl: sslOptions(config.DATABASE_URL, config.DATABASE_CA_CERT),
  });
  return { db: drizzle(pool, { schema }), pool };
}

/** Any Postgres driver, and transactions on it: node-postgres in production, PGlite in tests. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
