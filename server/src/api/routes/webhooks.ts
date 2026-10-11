import { timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db/client.ts";
import { oauthTokens, users } from "../../db/schema.ts";
import type { SyncRunner } from "../../pipeline/syncRunner.ts";

export interface WebhookOptions {
  db: Db;
  runner: SyncRunner;
  /** Shared secret in the URL Pub/Sub posts to; proves the request comes from our subscription. */
  token: string;
}

const tokenQuery = z.object({ token: z.string().min(1) });

// What Pub/Sub posts: Gmail's notification, base64-encoded, inside its own envelope.
const envelope = z.object({ message: z.object({ data: z.string().min(1) }) });
const notification = z.object({ emailAddress: z.string().min(3) });

const sameToken = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The inbox a notification is about, or null when the body isn't one. */
function notifiedAddress(body: unknown): string | null {
  const parsed = envelope.safeParse(body);
  if (!parsed.success) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(parsed.data.message.data, "base64").toString("utf8"));
    return notification.parse(decoded).emailAddress.toLowerCase();
  } catch {
    return null;
  }
}

export async function webhookRoutes(app: FastifyInstance, { db, runner, token }: WebhookOptions) {
  /**
   * Gmail says an inbox changed. The notification carries no mail: it only prompts a sync from the stored cursor,
   * so a forged or repeated one can do no more than that.
   */
  app.post("/webhooks/gmail", async (request, reply) => {
    const query = tokenQuery.safeParse(request.query);
    if (!query.success || !sameToken(query.data.token, token)) return reply.code(403).send({ error: "forbidden" });

    // Anything but a retry is acknowledged, or Pub/Sub would redeliver a message that can never succeed.
    const address = notifiedAddress(request.body);
    if (!address) {
      request.log.warn("Ignored a Gmail notification that could not be read");
      return reply.code(204).send();
    }

    const inboxes = await db
      .select({ id: users.id })
      .from(users)
      .innerJoin(oauthTokens, eq(oauthTokens.userId, users.id))
      .where(sql`lower(${users.email}) = ${address}`);
    const outcomes = await Promise.all(inboxes.map(({ id }) => runner.sync(id)));

    // Rate limited or briefly down: an error status makes Pub/Sub deliver the notification again later.
    if (outcomes.includes("retry")) return reply.code(503).send({ error: "retry_later" });
    return reply.code(204).send();
  });
}
