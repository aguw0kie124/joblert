CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"google_sub" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_google_sub_unique" UNIQUE("google_sub")
);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "applications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "emails" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "review_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sync_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "emails" DROP CONSTRAINT "emails_gmail_message_id_unique";--> statement-breakpoint
DROP INDEX "applications_status_idx";--> statement-breakpoint
DROP INDEX "applications_company_idx";--> statement-breakpoint
DROP INDEX "emails_thread_idx";--> statement-breakpoint
DROP INDEX "review_items_open_idx";--> statement-breakpoint
ALTER TABLE "oauth_tokens" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "oauth_tokens" DROP COLUMN "email";--> statement-breakpoint
ALTER TABLE "sync_state" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD COLUMN "user_id" uuid PRIMARY KEY NOT NULL;--> statement-breakpoint
ALTER TABLE "review_items" ADD COLUMN "user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_state" ADD COLUMN "user_id" uuid PRIMARY KEY NOT NULL;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "applications_user_status_idx" ON "applications" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "applications_user_company_idx" ON "applications" USING btree ("user_id","company");--> statement-breakpoint
CREATE INDEX "emails_user_thread_idx" ON "emails" USING btree ("user_id","thread_id");--> statement-breakpoint
CREATE INDEX "events_user_idx" ON "events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "review_items_user_open_idx" ON "review_items" USING btree ("user_id","resolved_at");--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_user_message_unique" UNIQUE("user_id","gmail_message_id");