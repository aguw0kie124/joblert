import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { applications, emails, events, reviewItems } from "../../db/schema.ts";
import { EMAIL_KINDS, STATUSES, type ReviewResolution, type Status } from "../../status.ts";
import { ApiError, idParams, notFound, type ProtectedOptions } from "../protected.ts";

// What the classifier stored on the email. Read leniently: old rows may predate newer fields.
const extractedSchema = z
  .object({
    kind: z.enum(EMAIL_KINDS),
    company: z.string().nullable(),
    role: z.string().nullable(),
    location: z.string().nullable(),
    jobId: z.string().nullable(),
    confidence: z.number(),
    evidence: z.string(),
    summary: z.string(),
    deadline: z.coerce.date().nullable(),
    interviewAt: z.coerce.date().nullable(),
  })
  .partial();

const readExtracted = (value: unknown) => extractedSchema.safeParse(value ?? {}).data ?? {};

const resolveBody = z.discriminatedUnion("action", [
  // Attach the email to an existing application. `status` overrides what the classifier proposed.
  z.strictObject({ action: z.literal("apply"), applicationId: z.uuid(), status: z.enum(STATUSES).optional() }),
  // Log a new application from the email. Company and role default to what the classifier read.
  z.strictObject({
    action: z.literal("create"),
    company: z.string().trim().min(1).max(200).optional(),
    role: z.string().trim().max(200).optional(),
    status: z.enum(STATUSES).optional(),
  }),
  z.strictObject({ action: z.literal("ignore") }),
]);

export async function reviewRoutes(app: FastifyInstance, { db }: ProtectedOptions) {
  app.get("/api/review", async (request) => {
    const userId = request.user.id;
    const rows = await db
      .select({ item: reviewItems, email: emails })
      .from(reviewItems)
      .innerJoin(emails, eq(emails.id, reviewItems.emailId))
      .where(and(eq(reviewItems.userId, userId), isNull(reviewItems.resolvedAt)))
      .orderBy(asc(emails.receivedAt));

    const candidateIds = [...new Set(rows.flatMap((r) => r.item.candidateApplicationIds))];
    const candidates = candidateIds.length
      ? await db
          .select({
            id: applications.id,
            company: applications.company,
            role: applications.role,
            status: applications.status,
            appliedAt: applications.appliedAt,
          })
          .from(applications)
          .where(and(eq(applications.userId, userId), inArray(applications.id, candidateIds)))
      : [];
    const byId = new Map(candidates.map((c) => [c.id, c]));

    return {
      items: rows.map(({ item, email }) => {
        const extracted = readExtracted(email.extracted);
        return {
          id: item.id,
          reason: item.reason,
          proposedStatus: item.proposedStatus,
          createdAt: item.createdAt,
          email: {
            subject: email.subject,
            sender: email.sender,
            receivedAt: email.receivedAt,
            gmailMessageId: email.gmailMessageId,
            threadId: email.threadId,
            company: extracted.company ?? null,
            role: extracted.role ?? null,
            confidence: extracted.confidence ?? null,
            summary: extracted.summary ?? null,
            evidence: extracted.evidence || null,
          },
          // A candidate deleted since the item was queued is simply left out.
          candidates: item.candidateApplicationIds.flatMap((id) => byId.get(id) ?? []),
        };
      }),
    };
  });

  app.post("/api/review/:id/resolve", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = resolveBody.parse(request.body);
    const userId = request.user.id;
    const now = new Date();

    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({ item: reviewItems, email: emails })
        .from(reviewItems)
        .innerJoin(emails, eq(emails.id, reviewItems.emailId))
        .where(and(eq(reviewItems.id, id), eq(reviewItems.userId, userId)))
        .for("update", { of: reviewItems });
      if (!row) throw notFound();
      const { item, email } = row;
      if (item.resolvedAt) throw new ApiError(409, "already_resolved");

      const extracted = readExtracted(email.extracted);
      const finish = async (resolution: ReviewResolution, applicationId: string | null) => {
        await tx.update(reviewItems).set({ resolution, resolvedAt: now }).where(eq(reviewItems.id, item.id));
        await tx
          .update(emails)
          .set({ processedState: applicationId ? "processed" : "ignored", applicationId })
          .where(eq(emails.id, email.id));
        return { resolution, applicationId };
      };

      if (body.action === "ignore") return finish("ignored", null);

      const status: Status | null = body.status ?? item.proposedStatus;
      if (!status) throw new ApiError(400, "status_required");

      // The email caused this change, even though a person confirmed it.
      const event = (applicationId: string, fromStatus: Status | null, toStatus: Status | null) => ({
        userId,
        applicationId,
        kind: extracted.kind ?? status,
        source: "email" as const,
        fromStatus,
        toStatus,
        emailId: email.id,
        confidence: extracted.confidence ?? null,
        evidenceQuote: extracted.evidence || null,
        summary: extracted.summary ?? null,
        deadline: extracted.deadline ?? null,
        interviewAt: extracted.interviewAt ?? null,
        occurredAt: email.receivedAt,
      });

      if (body.action === "create") {
        const company = body.company ?? extracted.company?.trim();
        if (!company) throw new ApiError(400, "company_required");
        const [created] = await tx
          .insert(applications)
          .values({
            userId,
            company,
            role: body.role ?? extracted.role?.trim() ?? "",
            location: extracted.location ?? null,
            jobId: extracted.jobId ?? null,
            appliedAt: email.receivedAt,
            status,
            statusUpdatedAt: email.receivedAt,
            source: "email",
          })
          .returning({ id: applications.id });
        await tx.insert(events).values(event(created!.id, null, status));
        return finish("created", created!.id);
      }

      const [application] = await tx
        .select()
        .from(applications)
        .where(and(eq(applications.id, body.applicationId), eq(applications.userId, userId)))
        .for("update");
      if (!application) throw new ApiError(404, "application_not_found");

      if (status === application.status) {
        await tx.insert(events).values(event(application.id, null, null));
      } else {
        // A person's decision overrides the state machine, so any status may follow any other.
        await tx
          .update(applications)
          .set({ status, statusUpdatedAt: now, updatedAt: now })
          .where(eq(applications.id, application.id));
        await tx.insert(events).values(event(application.id, application.status, status));
      }
      const suggested = item.candidateApplicationIds.includes(application.id);
      return finish(suggested ? "accepted" : "reassigned", application.id);
    });
  });
}
