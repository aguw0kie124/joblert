import Fastify from "fastify";
import { sql } from "drizzle-orm";
import { loadConfig } from "../config.ts";
import { createDb } from "../db/client.ts";

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL);

const app = Fastify({ logger: true });

app.get("/api/health", async (_req, reply) => {
  try {
    await db.execute(sql`select 1`);
    return { ok: true, db: "up" };
  } catch {
    return reply.code(503).send({ ok: false, db: "down" });
  }
});

app.addHook("onClose", async () => {
  await pool.end();
});

await app.listen({ port: config.PORT, host: "0.0.0.0" });
