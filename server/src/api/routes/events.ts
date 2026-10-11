import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { applications, events } from "../../db/schema.ts";
import { ApiError, idParams, notFound, type ProtectedOptions } from "../protected.ts";

export async function eventRoutes(app: FastifyInstance, { db }: ProtectedOptions) {
  /** Undoes the most recent status change on an application, putting back the status it replaced. */
  app.post("/api/events/:id/revert", async (request) => {
    const { id } = idParams.parse(request.params);
    const userId = request.user.id;
    const now = new Date();

    return db.transaction(async (tx) => {
      const [event] = await tx
        .select()
        .from(events)
        .where(and(eq(events.id, id), eq(events.userId, userId)));
      if (!event) throw notFound();
      if (event.revertedAt) throw new ApiError(409, "already_reverted");
      if (!event.toStatus) throw new ApiError(409, "not_a_status_change");
      // The event that created the application has nothing to go back to; delete the application instead.
      if (!event.fromStatus) throw new ApiError(409, "nothing_to_restore");

      const [application] = await tx
        .select()
        .from(applications)
        .where(and(eq(applications.id, event.applicationId), eq(applications.userId, userId)))
        .for("update");
      if (!application) throw notFound();

      // Only the latest change can be undone; undoing an older one would skip over what came after it.
      const [latest] = await tx
        .select({ id: events.id })
        .from(events)
        .where(and(eq(events.applicationId, application.id), isNotNull(events.toStatus), isNull(events.revertedAt)))
        .orderBy(desc(events.createdAt))
        .limit(1);
      if (latest?.id !== event.id || application.status !== event.toStatus) {
        throw new ApiError(409, "not_latest_change");
      }

      await tx.update(events).set({ revertedAt: now }).where(eq(events.id, event.id));
      await tx
        .update(applications)
        .set({ status: event.fromStatus, statusUpdatedAt: now, updatedAt: now })
        .where(eq(applications.id, application.id));

      return { applicationId: application.id, status: event.fromStatus };
    });
  });
}
