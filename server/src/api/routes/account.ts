import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { decrypt } from "../../auth/secrets.ts";
import { oauthTokens, users } from "../../db/schema.ts";
import { ApiError, type ProtectedOptions } from "../protected.ts";

export async function accountRoutes(app: FastifyInstance, { db, oauth, tokenKey, runner }: ProtectedOptions) {
  /** Starts a sync and returns at once. `lastSyncAt` on /api/me shows when it ends. */
  app.post("/api/sync", async (request, reply) => {
    const userId = request.user.id;
    if (runner.isRunning(userId)) throw new ApiError(409, "sync_in_progress");

    const start = await runner.begin(userId);
    if (start.status === "disconnected") throw new ApiError(409, "gmail_disconnected");
    return reply.code(202).send({ started: true });
  });

  /** Deletes the account and everything it owns, and withdraws the app's access to the Google account. */
  app.delete("/api/me", async (request, reply) => {
    const userId = request.user.id;
    const [token] = await db.select().from(oauthTokens).where(eq(oauthTokens.userId, userId));
    if (token) {
      await runner.unwatch(userId);
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
