import { z } from "zod";

const optional = z.string().min(1).optional();

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  // Path to the database provider's CA certificate (PEM). Enables certificate verification.
  DATABASE_CA_CERT: optional,
  PORT: z.coerce.number().int().positive().default(3000),
  // Emails classified below this confidence go to the review queue instead of auto-applying.
  AUTO_APPLY_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.85),
  // How far back the first sync of a newly connected inbox reads.
  BACKFILL_DAYS: z.coerce.number().int().positive().default(30),
  // Where the API is reachable from a browser; the Google redirect URI is built from it.
  PUBLIC_URL: z.url().optional(),
  // Where to send the browser after sign-in when the dashboard is served from another origin (Vite in dev).
  WEB_URL: z.url().optional(),

  // Optional until the step that uses them; each consumer asserts its own.
  GROQ_API_KEY: optional,
  GROQ_MODEL: z.string().min(1).default("openai/gpt-oss-120b"),
  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
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

type Present<K extends keyof Config> = Config & { [P in K]-?: NonNullable<Config[P]> };

/** Narrows the settings a given entrypoint cannot run without, naming all the missing ones at once. */
export function requireConfig<K extends keyof Config>(config: Config, keys: readonly K[]): Present<K> {
  const missing = keys.filter((key) => config[key] === undefined);
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  return config as Present<K>;
}

export function publicUrl(config: Pick<Config, "PUBLIC_URL" | "PORT">): string {
  return (config.PUBLIC_URL ?? `http://localhost:${config.PORT}`).replace(/\/+$/, "");
}
