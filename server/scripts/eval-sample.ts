// Pulls recent mail from a connected inbox into server/eval/ so it can be labelled by hand and scored
// with eval:inbox. The files hold real email text and are gitignored.
// Usage: npm run eval:sample -w server -- [days=60] [inbox@address] [--force]
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createGoogleOAuth } from "../src/auth/google.ts";
import { deriveKey } from "../src/auth/secrets.ts";
import { loadConfig, publicUrl, requireConfig } from "../src/config.ts";
import { createDb } from "../src/db/client.ts";
import { oauthTokens, users } from "../src/db/schema.ts";
import { hasSkippedLabel } from "../src/gmail/client.ts";
import { createGmailConnector } from "../src/gmail/connect.ts";
import { filterEmail } from "../src/gmail/filters.ts";
import { parseMessage, type ParsedEmail } from "../src/gmail/parser.ts";
import { SNIPPET_CHARS } from "../src/pipeline/triage.ts";
import { EVAL_DIR, LABELS_FILE, SAMPLE_FILE, toCsv, type Rule, type Sample, type SampleEmail } from "./evalFiles.ts";

// How many emails of each rule verdict are sampled, at random. Most mail is "unsure", so it is sampled rather
// than taken whole. The rules drop most mail outright, so as many dropped emails are sampled, to catch job
// mail the rules lose.
const SAMPLE_SIZE: Record<Rule, number> = { relevant: 100, unsure: 130, excluded: 130 };
const FETCH_CONCURRENCY = 5;

const args = process.argv.slice(2);
const force = args.includes("--force");
const days = Number(args.find((a) => /^\d+$/.test(a)) ?? 60);
const inbox = args.find((a) => a.includes("@"))?.toLowerCase();

if (existsSync(LABELS_FILE) && !force) {
  throw new Error(`${path.relative(process.cwd(), LABELS_FILE)} already exists; pass --force to replace it and its labels`);
}

const config = requireConfig(loadConfig(), ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY"]);
const { db, pool } = createDb(config);

try {
  const connected = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .innerJoin(oauthTokens, eq(oauthTokens.userId, users.id));
  const user = inbox ? connected.find((u) => u.email.toLowerCase() === inbox) : connected[0];
  if (!user) throw new Error(inbox ? `${inbox} is not a connected inbox` : "No connected inbox: sign in to the app first");
  if (connected.length > 1 && !inbox) {
    console.log(`Connected inboxes: ${connected.map((u) => u.email).join(", ")}. Sampling ${user.email}; pass an address to pick another.`);
  }

  const oauth = createGoogleOAuth({
    clientId: config.GOOGLE_CLIENT_ID,
    clientSecret: config.GOOGLE_CLIENT_SECRET,
    redirectUri: `${publicUrl(config)}/auth/google/callback`,
  });
  const connect = createGmailConnector({ db, oauth, tokenKey: deriveKey(config.TOKEN_ENCRYPTION_KEY, "refresh-token") });
  const gmail = await connect(user.id);
  if (!gmail) throw new Error("Gmail access has expired: sign in to the app again");

  const ids = await gmail.listRecent(days);
  console.log(`${ids.length} messages in the last ${days} days; reading newest first`);

  const byRule: Record<Rule, SampleEmail[]> = { relevant: [], unsure: [], excluded: [] };
  let unparsed = 0;

  for (let i = 0; i < ids.length; i += FETCH_CONCURRENCY) {
    const batch = await Promise.all(ids.slice(i, i + FETCH_CONCURRENCY).map((id) => gmail.getMessage(id)));
    for (const message of batch) {
      if (!message || hasSkippedLabel(message.labelIds)) continue;
      let email: ParsedEmail;
      try {
        email = parseMessage(message);
      } catch {
        unparsed++;
        continue;
      }
      const { verdict } = filterEmail({
        senderEmail: email.senderEmail,
        senderName: email.senderName,
        subject: email.subject,
        body: email.text,
      });
      byRule[verdict].push({ ...email, receivedAt: email.receivedAt.toISOString(), rule: verdict });
    }
    if (i % 100 === 0 && i > 0) console.log(`  ${i} of ${ids.length}`);
  }

  // Fisher-Yates. The label sheet is in random order too, so labelling only the first rows is still a fair sample.
  const shuffle = <T>(items: T[]) => {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
  };
  const rules = ["relevant", "unsure", "excluded"] as const;
  const emails = shuffle(rules.flatMap((rule) => shuffle(byRule[rule]).slice(0, SAMPLE_SIZE[rule])));
  const seen = { relevant: byRule.relevant.length, unsure: byRule.unsure.length, excluded: byRule.excluded.length };
  const sample: Sample = { inbox: user.email, days, seen, emails };

  mkdirSync(EVAL_DIR, { recursive: true });
  writeFileSync(SAMPLE_FILE, JSON.stringify(sample, null, 2));
  writeFileSync(
    LABELS_FILE,
    toCsv([
      ["id", "date", "from", "subject", "preview", "job", "stage"],
      ...emails.map((e) => [
        e.gmailMessageId,
        e.receivedAt.slice(0, 10),
        e.senderName ? `${e.senderName} <${e.senderEmail}>` : e.senderEmail,
        e.subject,
        e.text.slice(0, SNIPPET_CHARS).replace(/\s+/g, " "),
        "",
        "",
      ]),
    ]),
  );

  console.log(`\nRead ${seen.relevant + seen.unsure + seen.excluded} emails (${unparsed} could not be parsed).`);
  for (const rule of rules) {
    console.log(`  ${rule.padEnd(9)} ${String(seen[rule]).padStart(4)} seen, ${Math.min(seen[rule], SAMPLE_SIZE[rule])} sampled`);
  }
  console.log(`\nNow fill in ${path.relative(process.cwd(), LABELS_FILE)}:`);
  console.log("  job    y or n: is this email about a job application of yours?");
  console.log("  stage  for job mail only: applied, oa, interview, offer, rejected, or other");
  console.log("Then run: npm run eval:inbox -w server");
} finally {
  await pool.end();
}
