import { randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { hasGmailScope, type GoogleOAuth } from "../../auth/google.ts";
import { encrypt } from "../../auth/secrets.ts";
import type { Db } from "../../db/client.ts";
import { oauthTokens, syncState, users } from "../../db/schema.ts";

export interface AuthRouteOptions {
  db: Db;
  oauth: GoogleOAuth;
  tokenKey: Buffer;
  webUrl: string;
}

const callbackQuery = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
});

/**
 * denied: the user cancelled at Google.
 * gmail_scope: they signed in but left the Gmail permission unticked.
 * failed: anything else; signing in again usually fixes it.
 */
type SignInError = "denied" | "gmail_scope" | "failed";

const sameState = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function authRoutes(app: FastifyInstance, { db, oauth, tokenKey, webUrl }: AuthRouteOptions) {
  const failure = (error: SignInError) => `${webUrl}?auth_error=${error}`;

  /** The signed-in user, or undefined. A session for a deleted account counts as signed out. */
  async function currentUser(request: FastifyRequest) {
    const userId = request.session.get("userId");
    if (!userId) return undefined;
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) request.session.delete();
    return user;
  }

  app.get("/auth/google", async (request, reply) => {
    const state = randomBytes(24).toString("base64url");
    request.session.set("oauthState", state);
    return reply.redirect(oauth.authUrl(state));
  });

  app.get("/auth/google/callback", async (request, reply) => {
    const query = callbackQuery.safeParse(request.query);
    const expectedState = request.session.get("oauthState");
    request.session.set("oauthState", undefined);

    if (!query.success) return reply.redirect(failure("failed"));
    const { code, state, error } = query.data;
    if (error) return reply.redirect(failure(error === "access_denied" ? "denied" : "failed"));
    if (!code || !state || !expectedState || !sameState(state, expectedState)) {
      return reply.redirect(failure("failed"));
    }

    let signIn;
    try {
      signIn = await oauth.exchangeCode(code);
    } catch (cause) {
      request.log.warn({ err: cause }, "Google sign-in failed");
      return reply.redirect(failure("failed"));
    }
    if (!hasGmailScope(signIn.scope)) return reply.redirect(failure("gmail_scope"));

    const userId = await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ googleSub: signIn.sub, email: signIn.email })
        .onConflictDoUpdate({ target: users.googleSub, set: { email: signIn.email } })
        .returning({ id: users.id });

      if (signIn.refreshToken) {
        const token = {
          refreshTokenEncrypted: encrypt(signIn.refreshToken, tokenKey),
          scope: signIn.scope,
          updatedAt: new Date(),
        };
        await tx
          .insert(oauthTokens)
          .values({ userId: user!.id, ...token })
          .onConflictDoUpdate({ target: oauthTokens.userId, set: token });
      }
      return user!.id;
    });

    request.session.set("userId", userId);
    return reply.redirect(webUrl);
  });

  app.post("/auth/logout", async (request, reply) => {
    request.session.delete();
    return reply.code(204).send();
  });

  app.get("/api/me", async (request, reply) => {
    const user = await currentUser(request);
    if (!user) return reply.code(401).send({ error: "not_signed_in" });

    const [token] = await db
      .select({ userId: oauthTokens.userId })
      .from(oauthTokens)
      .where(eq(oauthTokens.userId, user.id));
    const [sync] = await db
      .select({ lastRunAt: syncState.lastRunAt })
      .from(syncState)
      .where(eq(syncState.userId, user.id));

    return {
      id: user.id,
      email: user.email,
      // False once Google stops accepting the stored token; the user signs in again to reconnect.
      gmailConnected: token !== undefined,
      lastSyncAt: sync?.lastRunAt ?? null,
    };
  });
}
