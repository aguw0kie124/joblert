CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company" text NOT NULL,
	"role" text NOT NULL,
	"job_url" text,
	"ats" text,
	"location" text,
	"applied_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'applied' NOT NULL,
	"status_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gmail_message_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"sender" text NOT NULL,
	"subject" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"extracted" jsonb,
	"processed_state" text DEFAULT 'pending' NOT NULL,
	"application_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "emails_gmail_message_id_unique" UNIQUE("gmail_message_id")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"email_id" uuid,
	"confidence" real,
	"evidence_quote" text,
	"summary" text,
	"deadline" timestamp with time zone,
	"interview_at" timestamp with time zone,
	"occurred_at" timestamp with time zone NOT NULL,
	"reverted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"refresh_token_encrypted" text NOT NULL,
	"scope" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"candidate_application_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proposed_status" text,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"id" text PRIMARY KEY NOT NULL,
	"history_id" text,
	"last_run_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "applications_status_idx" ON "applications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "applications_company_idx" ON "applications" USING btree ("company");--> statement-breakpoint
CREATE INDEX "emails_thread_idx" ON "emails" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "emails_application_idx" ON "emails" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "events_application_idx" ON "events" USING btree ("application_id","occurred_at");--> statement-breakpoint
CREATE INDEX "review_items_open_idx" ON "review_items" USING btree ("resolved_at");