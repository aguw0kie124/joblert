-- Emails held for a retry, or given up on, by the old sync. Nothing reads these states any more.
DELETE FROM "emails" WHERE "processed_state" IN ('pending', 'failed');--> statement-breakpoint
ALTER TABLE "emails" ALTER COLUMN "processed_state" DROP DEFAULT;
