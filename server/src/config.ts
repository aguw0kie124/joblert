import { z } from "zod";

const optional = z.string().min(1).optional();

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  // Emails classified below this confidence go to the review queue instead of auto-applying.
  AUTO_APPLY_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.85),

  // Optional until the step that uses them; each consumer asserts its own.
  ANTHROPIC_API_KEY: optional,
  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  ALLOWED_EMAIL: optional,
  SESSION_SECRET: optional,
  TOKEN_ENCRYPTION_KEY: optional,
  CRON_SECRET: optional,
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat blank values (as in .env.example) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ""));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
