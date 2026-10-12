import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { applications, events } from "../../db/schema.ts";
import { buildFlow, type FlowChange } from "../flow.ts";
import type { ProtectedOptions } from "../protected.ts";

export async function statsRoutes(app: FastifyInstance, { db }: ProtectedOptions) {
  /** How the user's applications moved through the stages, for the Insights chart. */
  app.get("/api/stats/flow", async (request) => {
    const userId = request.user.id;

    const owned = await db
      .select({ id: applications.id, status: applications.status })
      .from(applications)
      .where(eq(applications.userId, userId));
    const changes = await db
      .select({ applicationId: events.applicationId, fromStatus: events.fromStatus, toStatus: events.toStatus })
      .from(events)
      .where(and(eq(events.userId, userId), isNotNull(events.toStatus), isNull(events.revertedAt)))
      .orderBy(asc(events.createdAt));

    return { total: owned.length, links: buildFlow(owned, changes as FlowChange[]) };
  });
}
