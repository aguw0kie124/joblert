import { existsSync } from "node:fs";
import path from "node:path";
import { createGoogleOAuth } from "../auth/google.ts";
import { loadConfig, publicUrl, pubsubConfig, requireConfig } from "../config.ts";
import { deriveKey } from "../auth/secrets.ts";
import { createDb } from "../db/client.ts";
import { createGmailConnector } from "../gmail/connect.ts";
import { createGroqClassifier } from "../pipeline/groqClassifier.ts";
import { createGroqTriager } from "../pipeline/triage.ts";
import { buildApp } from "./app.ts";

const config = requireConfig(loadConfig(), [
  "GROQ_API_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "SESSION_SECRET",
  "TOKEN_ENCRYPTION_KEY",
]);
const { db, pool } = createDb(config);
const baseUrl = publicUrl(config);
// Resolves to web/dist from both src/api and dist/api. Absent in development, where Vite serves the dashboard.
const webDir = path.resolve(import.meta.dirname, "../../../web/dist");
const groq = { apiKey: config.GROQ_API_KEY, model: config.GROQ_MODEL };

const oauth = createGoogleOAuth({
  clientId: config.GOOGLE_CLIENT_ID,
  clientSecret: config.GOOGLE_CLIENT_SECRET,
  redirectUri: `${baseUrl}/auth/google/callback`,
});

const app = await buildApp({
  db,
  oauth,
  sessionSecret: config.SESSION_SECRET,
  tokenEncryptionKey: config.TOKEN_ENCRYPTION_KEY,
  ingest: {
    classifier: createGroqClassifier(groq),
    triager: createGroqTriager(groq),
    connect: createGmailConnector({ db, oauth, tokenKey: deriveKey(config.TOKEN_ENCRYPTION_KEY, "refresh-token") }),
    threshold: config.AUTO_APPLY_CONFIDENCE,
  },
  pubsub: pubsubConfig(config),
  publicUrl: baseUrl,
  webUrl: config.WEB_URL ?? baseUrl,
  webDir: existsSync(webDir) ? webDir : undefined,
  logger: true,
});

app.addHook("onClose", async () => {
  await pool.end();
});

await app.listen({ port: config.PORT, host: "0.0.0.0" });
app.syncRunner.startTimer();
