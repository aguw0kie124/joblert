CREATE TABLE "groq_keys" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"key_encrypted" text NOT NULL,
	"invalid_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "groq_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "groq_keys" ADD CONSTRAINT "groq_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;