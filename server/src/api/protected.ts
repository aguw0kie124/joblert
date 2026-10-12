import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { GoogleOAuth } from "../auth/google.ts";
import type { Db } from "../db/client.ts";
import { users } from "../db/schema.ts";
import type { SyncRunner } from "../pipeline/syncRunner.ts";
import { accountRoutes } from "./routes/account.ts";
import { applicationRoutes } from "./routes/applications.ts";
import { eventRoutes } from "./routes/events.ts";
import { reviewRoutes } from "./routes/review.ts";
import { statsRoutes } from "./routes/stats.ts";

declare module "fastify" {
  interface FastifyRequest {
    /** The signed-in user. Set on every route registered under `protectedRoutes`. */
    user: typeof users.$inferSelect;
  }
}

export interface ProtectedOptions {
  db: Db;
  oauth: GoogleOAuth;
  tokenKey: Buffer;
  runner: SyncRunner;
}

/** An error a route raises on purpose; the message is safe to show the client. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409,
    readonly code: string,
  ) {
    super(code);
  }
}

export const notFound = () => new ApiError(404, "not_found");

export const idParams = z.object({ id: z.uuid() });

/** Everything registered here requires a session, and may only touch rows owned by `request.user`. */
export async function protectedRoutes(app: FastifyInstance, options: ProtectedOptions) {
  app.decorateRequest("user", null as never);

  app.addHook("preHandler", async (request, reply) => {
    const userId = request.session.get("userId");
    const [user] = userId ? await options.db.select().from(users).where(eq(users.id, userId)) : [];
    if (!user) {
      request.session.delete();
      return reply.code(401).send({ error: "not_signed_in" });
    }
    request.user = user;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: "invalid_request", details: z.prettifyError(error) });
    }
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.code });
    request.log.error({ err: error }, "Request failed");
    return reply.code(500).send({ error: "internal_error" });
  });

  await app.register(applicationRoutes, options);
  await app.register(reviewRoutes, options);
  await app.register(eventRoutes, options);
  await app.register(statsRoutes, options);
  await app.register(accountRoutes, options);
}
