import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, real, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import {
  EMAIL_KINDS,
  PROCESSED_STATES,
  REVIEW_REASONS,
  REVIEW_RESOLUTIONS,
  SOURCES,
  STATUSES,
} from "../status.ts";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

// Row-level security is enabled on every table with no policies. That shuts out Supabase's auto-generated
// web API; the app connects to Postgres directly as the owner role, which is not subject to it.

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Google's stable account id. Email addresses can change; this cannot.
  googleSub: text("google_sub").notNull().unique(),
  email: text("email").notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
}).enableRLS();

// Every row below belongs to exactly one user, and every query must filter by it.
const userId = () =>
  uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" });

export const applications = pgTable(
  "applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userId(),
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
  (t) => [
    index("applications_user_status_idx").on(t.userId, t.status),
    index("applications_user_company_idx").on(t.userId, t.company),
  ],
).enableRLS();

// Extracted fields only; full bodies are never stored.
export const emails = pgTable(
  "emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userId(),
    gmailMessageId: text("gmail_message_id").notNull(),
    threadId: text("thread_id").notNull(),
    sender: text("sender").notNull(),
    subject: text("subject").notNull(),
    receivedAt: timestamptz("received_at").notNull(),
    extracted: jsonb("extracted"),
    processedState: text("processed_state", { enum: PROCESSED_STATES }).notNull(),
    applicationId: uuid("application_id").references(() => applications.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    // Unique per inbox, so reprocessing the same message is a no-op.
    unique("emails_user_message_unique").on(t.userId, t.gmailMessageId),
    index("emails_user_thread_idx").on(t.userId, t.threadId),
    index("emails_application_idx").on(t.applicationId),
  ],
).enableRLS();

// Audit log: every status change records what caused it, so it can be reverted.
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userId(),
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
  (t) => [index("events_application_idx").on(t.applicationId, t.occurredAt), index("events_user_idx").on(t.userId)],
).enableRLS();

export const reviewItems = pgTable(
  "review_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userId(),
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
  (t) => [index("review_items_user_open_idx").on(t.userId, t.resolvedAt)],
).enableRLS();

// One row per user: the Gmail poll cursor.
export const syncState = pgTable("sync_state", {
  userId: userId().primaryKey(),
  historyId: text("history_id"),
  lastRunAt: timestamptz("last_run_at"),
}).enableRLS();

// One row per user: the Gmail refresh token, encrypted with TOKEN_ENCRYPTION_KEY.
export const oauthTokens = pgTable("oauth_tokens", {
  userId: userId().primaryKey(),
  refreshTokenEncrypted: text("refresh_token_encrypted").notNull(),
  scope: text("scope").notNull(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
}).enableRLS();
