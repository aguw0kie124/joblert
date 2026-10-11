import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { decrypt } from "../../auth/secrets.ts";
import { oauthTokens, users } from "../../db/schema.ts";
import { pollUser } from "../../pipeline/ingest.ts";
import { ApiError, type ProtectedOptions } from "../protected.ts";

export async function accountRoutes(app: FastifyInstance, { db, oauth, tokenKey, ingest }: ProtectedOptions) {
  // Guards against double-clicks within this process. A cron run in another process can still overlap;
  // the unique index on (user, Gmail message) is what keeps that from storing anything twice.
  const syncing = new Set<string>();

  /** Starts a sync and returns at once; a first sync can take minutes. `lastSyncAt` on /api/me shows when it ends. */
  app.post("/api/sync", async (request, reply) => {
    const userId = request.user.id;
    if (syncing.has(userId)) throw new ApiError(409, "sync_in_progress");

    syncing.add(userId);
    try {
      const gmail = await ingest.connect(userId);
      if (!gmail) throw new ApiError(409, "gmail_disconnected");

      void pollUser({ ...ingest, db }, userId, gmail)
        .then((stats) => request.log.info({ userId, stats }, "Sync finished"))
        .catch((error: unknown) => request.log.error({ userId, err: error }, "Sync failed"))
        .finally(() => syncing.delete(userId));
    } catch (error) {
      syncing.delete(userId);
      throw error;
    }
    return reply.code(202).send({ started: true });
  });

  /** Deletes the account and everything it owns, and withdraws the app's access to the Google account. */
  app.delete("/api/me", async (request, reply) => {
    const userId = request.user.id;
    const [token] = await db.select().from(oauthTokens).where(eq(oauthTokens.userId, userId));
    if (token) {
      try {
        await oauth.revokeToken(decrypt(token.refreshTokenEncrypted, tokenKey));
      } catch (error) {
        // The data is deleted regardless; the user can still remove access from their Google account page.
        request.log.warn({ userId, err: error }, "Could not revoke Google access");
      }
    }
    await db.delete(users).where(eq(users.id, userId));
    request.session.delete();
    return reply.code(204).send();
  });
}
