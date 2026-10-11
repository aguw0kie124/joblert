import { and, asc, count, desc, eq, gt, ilike, isNull, min, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { applications, emails, events } from "../../db/schema.ts";
import { STATUSES, type Status } from "../../status.ts";
import { idParams, notFound, type ProtectedOptions } from "../protected.ts";

const text = (max: number) => z.string().trim().max(max);
// An empty string from a form clears the field.
const optionalText = (max: number) =>
  text(max)
    .nullable()
    .transform((value) => value || null);

const fields = {
  company: text(200).min(1),
  role: text(200),
  jobUrl: z.union([z.url({ protocol: /^https?$/ }).max(2000), z.literal("").transform(() => null), z.null()]),
  location: optionalText(200),
  notes: optionalText(5000),
  appliedAt: z.coerce.date(),
  status: z.enum(STATUSES),
};

const createBody = z.strictObject({
  company: fields.company,
  role: fields.role.default(""),
  jobUrl: fields.jobUrl.optional(),
  location: fields.location.optional(),
  notes: fields.notes.optional(),
  appliedAt: fields.appliedAt.optional(),
  status: fields.status.default("applied"),
});

const updateBody = z.strictObject(fields).partial();

const listQuery = z.object({
  status: z.enum(STATUSES).optional(),
  q: z.string().trim().max(200).optional(),
});

// "%" and "_" are wildcards in LIKE; a search for "100%" should mean those characters.
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, "\\$&")}%`;

export async function applicationRoutes(app: FastifyInstance, { db }: ProtectedOptions) {
  app.get("/api/applications", async (request) => {
    const userId = request.user.id;
    const { status, q } = listQuery.parse(request.query);

    const rows = await db
      .select()
      .from(applications)
      .where(
        and(
          eq(applications.userId, userId),
          status ? eq(applications.status, status) : undefined,
          q ? or(ilike(applications.company, likePattern(q)), ilike(applications.role, likePattern(q))) : undefined,
        ),
      )
      .orderBy(desc(applications.statusUpdatedAt), asc(applications.company));

    // Counts cover every application, so the status tabs don't change as the list is filtered.
    const totals = await db
      .select({ status: applications.status, n: count() })
      .from(applications)
      .where(eq(applications.userId, userId))
      .groupBy(applications.status);
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
    for (const { status: s, n } of totals) counts[s] = n;

    const now = new Date();
    const upcoming = (column: typeof events.deadline | typeof events.interviewAt) =>
      db
        .select({ applicationId: events.applicationId, at: min(column) })
        .from(events)
        .where(and(eq(events.userId, userId), isNull(events.revertedAt), gt(column, now)))
        .groupBy(events.applicationId);
    const deadlines = new Map((await upcoming(events.deadline)).map((r) => [r.applicationId, r.at]));
    const interviews = new Map((await upcoming(events.interviewAt)).map((r) => [r.applicationId, r.at]));

    return {
      applications: rows.map(({ userId: _owner, ...row }) => ({
        ...row,
        nextDeadline: deadlines.get(row.id) ?? null,
        nextInterviewAt: interviews.get(row.id) ?? null,
      })),
      counts,
    };
  });

  app.get("/api/applications/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    const [application] = await db
      .select()
      .from(applications)
      .where(and(eq(applications.id, id), eq(applications.userId, request.user.id)));
    if (!application) throw notFound();

    const timeline = await db
      .select({
        id: events.id,
        kind: events.kind,
        source: events.source,
        fromStatus: events.fromStatus,
        toStatus: events.toStatus,
        confidence: events.confidence,
        evidenceQuote: events.evidenceQuote,
        summary: events.summary,
        deadline: events.deadline,
        interviewAt: events.interviewAt,
        occurredAt: events.occurredAt,
        revertedAt: events.revertedAt,
        email: {
          subject: emails.subject,
          sender: emails.sender,
          gmailMessageId: emails.gmailMessageId,
          threadId: emails.threadId,
        },
      })
      .from(events)
      .leftJoin(emails, eq(emails.id, events.emailId))
      .where(and(eq(events.applicationId, id), eq(events.userId, request.user.id)))
      .orderBy(desc(events.occurredAt), desc(events.createdAt));

    const { userId: _owner, ...rest } = application;
    return { application: rest, events: timeline };
  });

  app.post("/api/applications", async (request, reply) => {
    const body = createBody.parse(request.body);
    const userId = request.user.id;
    const now = new Date();

    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(applications)
        .values({
          userId,
          company: body.company,
          role: body.role,
          jobUrl: body.jobUrl ?? null,
          location: body.location ?? null,
          notes: body.notes ?? null,
          appliedAt: body.appliedAt ?? now,
          status: body.status,
          statusUpdatedAt: now,
          source: "manual",
        })
        .returning();
      await tx.insert(events).values({
        userId,
        applicationId: row!.id,
        kind: body.status,
        source: "manual",
        toStatus: body.status,
        occurredAt: now,
      });
      return row!;
    });

    const { userId: _owner, ...rest } = created;
    return reply.code(201).send({ application: rest });
  });

  app.patch("/api/applications/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = updateBody.parse(request.body);
    const userId = request.user.id;
    const owned = and(eq(applications.id, id), eq(applications.userId, userId));
    const now = new Date();

    const updated = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(applications).where(owned).for("update");
      if (!current) throw notFound();

      const statusChanged = body.status !== undefined && body.status !== current.status;
      const [row] = await tx
        .update(applications)
        .set({ ...body, updatedAt: now, ...(statusChanged ? { statusUpdatedAt: now } : {}) })
        .where(owned)
        .returning();

      if (statusChanged) {
        await tx.insert(events).values({
          userId,
          applicationId: id,
          kind: body.status!,
          source: "manual",
          fromStatus: current.status,
          toStatus: body.status!,
          occurredAt: now,
        });
      }
      return row!;
    });

    const { userId: _owner, ...rest } = updated;
    return { application: rest };
  });

  app.delete("/api/applications/:id", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const deleted = await db
      .delete(applications)
      .where(and(eq(applications.id, id), eq(applications.userId, request.user.id)))
      .returning({ id: applications.id });
    if (deleted.length === 0) throw notFound();
    return reply.code(204).send();
  });
}
