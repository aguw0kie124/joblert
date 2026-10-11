// Cron entrypoint: sync every connected inbox once, then exit.
import { createGoogleOAuth } from "../auth/google.ts";
import { deriveKey } from "../auth/secrets.ts";
import { loadConfig, publicUrl, requireConfig } from "../config.ts";
import { createDb } from "../db/client.ts";
import { createGmailConnector } from "../gmail/connect.ts";
import { createClassifier, createTriager } from "../pipeline/createClassifier.ts";
import { runPoll } from "../pipeline/ingest.ts";

const config = requireConfig(loadConfig(), ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY"]);
if (!config.GROQ_API_KEY) {
  console.warn("GROQ_API_KEY is not set: using keyword rules only, so only mail with a clear job signal is read and all of it goes to the review queue.");
}

const { db, pool } = createDb(config);
const oauth = createGoogleOAuth({
  clientId: config.GOOGLE_CLIENT_ID,
  clientSecret: config.GOOGLE_CLIENT_SECRET,
  redirectUri: `${publicUrl(config)}/auth/google/callback`,
});

try {
  const results = await runPoll({
    db,
    classifier: createClassifier(config),
    triager: createTriager(config),
    connect: createGmailConnector({ db, oauth, tokenKey: deriveKey(config.TOKEN_ENCRYPTION_KEY, "refresh-token") }),
    threshold: config.AUTO_APPLY_CONFIDENCE,
    backfillDays: config.BACKFILL_DAYS,
    log: (message, data) => console.log(message, data ?? ""),
  });

  if (results.length === 0) console.log("No connected inboxes. Sign in through the app first.");
  for (const result of results) console.log(JSON.stringify(result));
  if (results.some((result) => result.status === "failed")) process.exitCode = 1;
} finally {
  await pool.end();
}
