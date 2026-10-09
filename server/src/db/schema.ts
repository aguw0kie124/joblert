import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import {
  EMAIL_KINDS,
  PROCESSED_STATES,
  REVIEW_REASONS,
  REVIEW_RESOLUTIONS,
  SOURCES,
  STATUSES,
} from "../status.ts";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

export const applications = pgTable(
  "applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    company: text("company").notNull(),
    role: text("role").notNull(),
    jobUrl: text("job_url"),
    ats: text("ats"),
    location: text("location"),
    appliedAt: timestamptz("applied_at").notNull(),
    status: text("status", { enum: STATUSES }).notNull().default("applied"),
    statusUpdatedAt: timestamptz("status_updated_at").notNull().defaultNow(),
    notes: text("notes"),
    source: text("source", { enum: SOURCES }).notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [index("applications_status_idx").on(t.status), index("applications_company_idx").on(t.company)],
);

// Extracted fields only; full bodies are never stored.
export const emails = pgTable(
  "emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Unique so reprocessing the same message is a no-op.
    gmailMessageId: text("gmail_message_id").notNull().unique(),
    threadId: text("thread_id").notNull(),
    sender: text("sender").notNull(),
    subject: text("subject").notNull(),
    receivedAt: timestamptz("received_at").notNull(),
    extracted: jsonb("extracted"),
    processedState: text("processed_state", { enum: PROCESSED_STATES }).notNull().default("pending"),
    applicationId: uuid("application_id").references(() => applications.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [index("emails_thread_idx").on(t.threadId), index("emails_application_idx").on(t.applicationId)],
);

// Audit log: every status change records what caused it, so it can be reverted.
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: EMAIL_KINDS }).notNull(),
    source: text("source", { enum: SOURCES }).notNull(),
    fromStatus: text("from_status", { enum: STATUSES }),
    // Null when the event is recorded on the timeline without changing status.
    toStatus: text("to_status", { enum: STATUSES }),
    emailId: uuid("email_id").references(() => emails.id, { onDelete: "set null" }),
    confidence: real("confidence"),
    evidenceQuote: text("evidence_quote"),
    summary: text("summary"),
    deadline: timestamptz("deadline"),
    interviewAt: timestamptz("interview_at"),
    occurredAt: timestamptz("occurred_at").notNull(),
    revertedAt: timestamptz("reverted_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [index("events_application_idx").on(t.applicationId, t.occurredAt)],
);

export const reviewItems = pgTable(
  "review_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    emailId: uuid("email_id")
      .notNull()
      .references(() => emails.id, { onDelete: "cascade" }),
    reason: text("reason", { enum: REVIEW_REASONS }).notNull(),
    candidateApplicationIds: jsonb("candidate_application_ids")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    proposedStatus: text("proposed_status", { enum: STATUSES }),
    resolution: text("resolution", { enum: REVIEW_RESOLUTIONS }),
    resolvedAt: timestamptz("resolved_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [index("review_items_open_idx").on(t.resolvedAt)],
);

// Single row ("gmail") holding the poll cursor.
export const syncState = pgTable("sync_state", {
  id: text("id").primaryKey(),
  historyId: text("history_id"),
  lastRunAt: timestamptz("last_run_at"),
});

// Single row ("google").
export const oauthTokens = pgTable("oauth_tokens", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  refreshTokenEncrypted: text("refresh_token_encrypted").notNull(),
  scope: text("scope").notNull(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});
