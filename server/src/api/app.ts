import secureSession from "@fastify/secure-session";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import type { GoogleOAuth } from "../auth/google.ts";
import { deriveKey } from "../auth/secrets.ts";
import type { Db } from "../db/client.ts";
import { authRoutes } from "./routes/auth.ts";

declare module "@fastify/secure-session" {
  interface SessionData {
    userId: string;
    /** Random value sent to Google and checked on return, so a sign-in can't be started by another site. */
    oauthState: string;
  }
}

const SESSION_DAYS = 30;

export interface AppOptions {
  db: Db;
  oauth: GoogleOAuth;
  sessionSecret: string;
  tokenEncryptionKey: string;
  /** Cookies are marked Secure when the app is served over HTTPS. */
  publicUrl: string;
  /** Where the browser lands after signing in. */
  webUrl: string;
  logger?: boolean;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  await app.register(secureSession, {
    key: deriveKey(options.sessionSecret, "session-cookie"),
    cookieName: "joblert_session",
    expiry: SESSION_DAYS * 24 * 60 * 60,
    cookie: {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: options.publicUrl.startsWith("https://"),
      maxAge: SESSION_DAYS * 24 * 60 * 60,
    },
  });

  app.get("/api/health", async (_req, reply) => {
    try {
      await options.db.execute(sql`select 1`);
      return { ok: true, db: "up" };
    } catch {
      return reply.code(503).send({ ok: false, db: "down" });
    }
  });

  await app.register(authRoutes, {
    db: options.db,
    oauth: options.oauth,
    tokenKey: deriveKey(options.tokenEncryptionKey, "refresh-token"),
    webUrl: options.webUrl,
  });

  return app;
}
