import secureSession from "@fastify/secure-session";
import fastifyStatic from "@fastify/static";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import type { GoogleOAuth } from "../auth/google.ts";
import { deriveKey } from "../auth/secrets.ts";
import type { Db } from "../db/client.ts";
import type { IngestDeps } from "../pipeline/ingest.ts";
import { createSyncRunner, type SyncRunner } from "../pipeline/syncRunner.ts";
import { protectedRoutes } from "./protected.ts";
import { authRoutes } from "./routes/auth.ts";
import { webhookRoutes } from "./routes/webhooks.ts";

declare module "@fastify/secure-session" {
  interface SessionData {
    userId: string;
    /** Random value sent to Google and checked on return, so a sign-in can't be started by another site. */
    oauthState: string;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    /** Starts every sync. The entrypoint starts its timer once the server is listening. */
    syncRunner: SyncRunner;
  }
}

const SESSION_DAYS = 30;

export interface AppOptions {
  db: Db;
  oauth: GoogleOAuth;
  sessionSecret: string;
  tokenEncryptionKey: string;
  /** How a sync reads and classifies mail. */
  ingest: Omit<IngestDeps, "db" | "log">;
  /** Gmail push: the topic Gmail publishes to, and the secret in the URL Pub/Sub posts to. Off when absent. */
  pubsub?: { topic: string; token: string };
  /** Cookies are marked Secure when the app is served over HTTPS. */
  publicUrl: string;
  /** Where the browser lands after signing in. */
  webUrl: string;
  /** Folder holding the built dashboard. In development Vite serves it instead. */
  webDir?: string;
  logger?: boolean;
}

// Paths the dashboard never owns: an unknown one is a 404, not a page.
const NOT_PAGES = ["/api", "/auth", "/webhooks", "/assets"];

// The webhook URL carries its secret in the query string, so requests are logged by path only.
const requestLog = (request: { method: string; url: string }) => ({
  method: request.method,
  url: request.url.split("?")[0],
});

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ? { serializers: { req: requestLog } } : false });

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

  const runner = createSyncRunner({
    ...options.ingest,
    db: options.db,
    topic: options.pubsub?.topic,
    log: (message, data) => app.log.info(data ?? {}, message),
  });
  app.decorate("syncRunner", runner);
  app.addHook("onClose", async () => runner.stopTimer());

  const tokenKey = deriveKey(options.tokenEncryptionKey, "refresh-token");
  await app.register(authRoutes, { db: options.db, oauth: options.oauth, tokenKey, webUrl: options.webUrl, runner });
  await app.register(protectedRoutes, { db: options.db, oauth: options.oauth, tokenKey, runner });
  if (options.pubsub) await app.register(webhookRoutes, { db: options.db, runner, token: options.pubsub.token });

  if (options.webDir) {
    await app.register(fastifyStatic, { root: options.webDir });
    // The dashboard routes in the browser, so any other page address gets the app itself.
    app.setNotFoundHandler((request, reply) => {
      const path = request.url.split("?")[0]!;
      const isPage = request.method === "GET" && !NOT_PAGES.some((p) => path === p || path.startsWith(`${p}/`));
      return isPage ? reply.sendFile("index.html") : reply.code(404).send({ error: "not_found" });
    });
  }

  return app;
}
