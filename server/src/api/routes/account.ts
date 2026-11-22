import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { saveGroqKey } from "../../auth/groqKeys.ts";
import { decrypt } from "../../auth/secrets.ts";
import { oauthTokens, users } from "../../db/schema.ts";
import { ApiError, type ProtectedOptions } from "../protected.ts";

const groqKeyBody = z.object({ key: z.string().trim().min(1).max(200) });

export async function accountRoutes(
  app: FastifyInstance,
  { db, oauth, tokenKey, groqKeyKey, verifyGroqKey, runner }: ProtectedOptions,
) {
  /** Saves the user's own Groq key once Groq accepts it, then starts watching and syncing their inbox. */
  app.put("/api/groq-key", async (request, reply) => {
    const userId = request.user.id;
    const { key } = groqKeyBody.parse(request.body);
    const check = await verifyGroqKey(key);
    if (check === "invalid") throw new ApiError(400, "invalid_groq_key");
    if (check === "unavailable") throw new ApiError(503, "groq_unavailable");

    await saveGroqKey(db, groqKeyKey, userId, key);
    void runner.refresh(userId);
    return reply.code(204).send();
  });

  /** Starts a sync and returns at once. `lastSyncAt` on /api/me shows when it ends. */
  app.post("/api/sync", async (request, reply) => {
    const userId = request.user.id;
    if (runner.isRunning(userId)) throw new ApiError(409, "sync_in_progress");

    const start = await runner.begin(userId);
    if (start.status === "disconnected") throw new ApiError(409, "gmail_disconnected");
    if (start.status === "no_groq_key") throw new ApiError(409, "groq_key_missing");
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
