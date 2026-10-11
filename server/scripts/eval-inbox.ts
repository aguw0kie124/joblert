// Scores the pipeline (rules, triage, classifier) on the hand-labelled inbox sample from eval:sample.
// Answers are saved as they arrive, so a run stopped by Groq's limits continues where it left off.
// Usage: npm run eval:inbox -w server -- [--fresh]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig, requireConfig } from "../src/config.ts";
import { ClassifierError } from "../src/pipeline/classify.ts";
import { createGroqClassifier } from "../src/pipeline/groqClassifier.ts";
import { createGroqTriager, SNIPPET_CHARS, TRIAGE_BATCH } from "../src/pipeline/triage.ts";
import { EMAIL_KINDS, type EmailKind } from "../src/status.ts";
import { LABELS_FILE, parseCsv, RESULTS_FILE, SAMPLE_FILE, type Sample, type SampleEmail } from "./evalFiles.ts";

/** What the pipeline did with one email. `kind` is null when it never reached the classifier or was unreadable. */
interface Result {
  /** Triage answer, for mail no rule settled. */
  triaged?: boolean;
  classified?: { jobRelated: boolean; kind: EmailKind | null; confidence: number };
}

interface Label {
  job: boolean;
  stage: EmailKind | null;
}

const RETRY_WAIT_MS = 60_000;
// Groq's per-minute limit clears in a minute; this many failures in a row means the daily cap.
const MAX_WAITS = 10;

const config = requireConfig(loadConfig(), ["GROQ_API_KEY"]);
const groq = { apiKey: config.GROQ_API_KEY, model: config.GROQ_MODEL };
const classifier = createGroqClassifier(groq);
const triager = createGroqTriager(groq);

if (!existsSync(SAMPLE_FILE) || !existsSync(LABELS_FILE)) throw new Error("Run eval:sample first");
const sample = JSON.parse(readFileSync(SAMPLE_FILE, "utf8")) as Sample;
const results: Record<string, Result> =
  existsSync(RESULTS_FILE) && !process.argv.includes("--fresh") ? JSON.parse(readFileSync(RESULTS_FILE, "utf8")) : {};
const save = () => writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));

function readLabels(): Map<string, Label> {
  const [header, ...rows] = parseCsv(readFileSync(LABELS_FILE, "utf8"));
  const column = (name: string) => {
    const index = header?.findIndex((h) => h.trim().toLowerCase() === name) ?? -1;
    if (index < 0) throw new Error(`labels.csv has no "${name}" column`);
    return index;
  };
  const [id, job, stage] = [column("id"), column("job"), column("stage")];

  const labels = new Map<string, Label>();
  for (const row of rows) {
    const answer = row[job]?.trim().toLowerCase() ?? "";
    if (!answer) continue;
    const isJob = ["y", "yes", "true", "1"].includes(answer);
    if (!isJob && !["n", "no", "false", "0"].includes(answer)) throw new Error(`job must be y or n, got "${row[job]}"`);

    const named = row[stage]?.trim().toLowerCase() ?? "";
    if (named && !(EMAIL_KINDS as readonly string[]).includes(named)) {
      throw new Error(`stage must be one of ${EMAIL_KINDS.join(", ")}; got "${row[stage]}"`);
    }
    labels.set(row[id]!.trim(), { job: isJob, stage: isJob ? ((named || "other") as EmailKind) : null });
  }
  return labels;
}

/** Runs one Groq request, waiting out rate limits. Gives up, with progress saved, once the daily cap is likely. */
async function patiently<T>(request: () => Promise<T>): Promise<T> {
  for (let waits = 0; ; waits++) {
    try {
      return await request();
    } catch (error) {
      if (!(error instanceof ClassifierError) || error.code !== "unavailable") throw error;
      if (waits >= MAX_WAITS) {
        save();
        console.log("\nGroq is still rate limiting, probably the daily cap. Progress is saved; run this again later.");
        process.exit(1);
      }
      process.stdout.write(" (rate limited, waiting a minute)");
      await new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS));
    }
  }
}

const labels = readLabels();
// Oldest first in windows, as a sync reads them.
const emails = sample.emails
  .filter((e) => labels.has(e.gmailMessageId))
  .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
if (emails.length === 0) throw new Error("No labelled rows: fill in the job column of labels.csv");
console.log(`${emails.length} of ${sample.emails.length} sampled emails are labelled. Model: ${groq.model}`);

for (let start = 0; start < emails.length; start += TRIAGE_BATCH) {
  const window = emails.slice(start, start + TRIAGE_BATCH);
  const result = (email: SampleEmail) => (results[email.gmailMessageId] ??= {});

  const unsure = window.filter((e) => e.rule === "unsure" && result(e).triaged === undefined);
  if (unsure.length) {
    let verdicts: boolean[];
    try {
      verdicts = await patiently(() =>
        triager.triage(
          unsure.map((e) => ({
            senderName: e.senderName,
            senderEmail: e.senderEmail,
            subject: e.subject,
            snippet: e.text.slice(0, SNIPPET_CHARS),
          })),
        ),
      );
    } catch (error) {
      // As in a sync: an unusable triage answer sends them all to the classifier.
      if (!(error instanceof ClassifierError) || error.code !== "invalid_output") throw error;
      verdicts = unsure.map(() => true);
    }
    unsure.forEach((email, index) => (result(email).triaged = verdicts[index] ?? true));
    save();
  }

  for (const email of window) {
    const entry = result(email);
    const reachesClassifier = email.rule === "relevant" || (email.rule === "unsure" && entry.triaged);
    if (!reachesClassifier || entry.classified) continue;
    try {
      const answer = await patiently(() => classifier.classify({ ...email, receivedAt: new Date(email.receivedAt) }));
      entry.classified = { jobRelated: answer.jobRelated, kind: answer.kind, confidence: answer.confidence };
    } catch (error) {
      if (!(error instanceof ClassifierError) || error.code !== "invalid_output") throw error;
      // Unreadable mail goes to the review queue, so it is not lost: it counts as kept, with no stage.
      entry.classified = { jobRelated: true, kind: null, confidence: 0 };
    }
    save();
    process.stdout.write(".");
  }
}
console.log();

// 95% Wilson interval for a proportion.
function interval(right: number, total: number): string {
  if (total === 0) return "n/a";
  const z = 1.96;
  const p = right / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  const scale = 1 + (z * z) / total;
  const percent = (x: number) => `${Math.round(Math.max(0, Math.min(1, x)) * 100)}%`;
  return `${right}/${total} = ${percent(p)} (95% interval ${percent((centre - spread) / scale)} to ${percent((centre + spread) / scale)})`;
}

const describe = (e: SampleEmail) => `  ${e.receivedAt.slice(0, 10)}  ${e.senderEmail}  "${e.subject.slice(0, 70)}"`;

let jobTotal = 0;
let jobCaught = 0;
let otherTotal = 0;
let otherKeptOut = 0;
let stageRight = 0;
let stageTotal = 0;
let confidentWrong = 0;
let unreadable = 0;
// Only part of each rule verdict was sampled and labelled, so each labelled email stands for several.
const labelled = { relevant: 0, unsure: 0, excluded: 0 };
for (const email of emails) labelled[email.rule]++;
let weightedRight = 0;
let weightedTotal = 0;
const misses: string[] = [];

for (const email of emails) {
  const label = labels.get(email.gmailMessageId)!;
  const classified = results[email.gmailMessageId]?.classified;
  const kept = classified?.jobRelated ?? false;
  const weight = sample.seen[email.rule] / labelled[email.rule];
  const where = email.rule === "excluded" ? "rules" : classified ? "classifier" : "triage";
  if (classified && classified.kind === null) unreadable++;

  weightedTotal += weight;
  if (kept === label.job) weightedRight += weight;

  if (label.job) {
    jobTotal++;
    if (kept) jobCaught++;
    else misses.push(`${describe(email)}\n    job mail dropped by the ${where}`);
  } else {
    otherTotal++;
    if (!kept) otherKeptOut++;
    else misses.push(`${describe(email)}\n    not job mail, but kept as ${classified?.kind ?? "unreadable"}`);
  }

  if (label.job && classified?.kind) {
    stageTotal++;
    if (classified.kind === label.stage) stageRight++;
    else misses.push(`${describe(email)}\n    stage: labelled ${label.stage}, read as ${classified.kind} at ${classified.confidence}`);
  }
  const wrong = kept !== label.job || (label.job && classified?.kind != null && classified.kind !== label.stage);
  if (wrong && classified && classified.confidence >= config.AUTO_APPLY_CONFIDENCE) confidentWrong++;
}

if (misses.length) console.log(`\nMisses:\n${misses.join("\n")}`);

console.log(`\nInbox sample: ${sample.inbox}, last ${sample.days} days, ${emails.length} labelled emails`);
console.log(`Job emails caught:               ${interval(jobCaught, jobTotal)}`);
console.log(`Other emails kept out:           ${interval(otherKeptOut, otherTotal)}`);
console.log(`Stage right, of job mail caught: ${interval(stageRight, stageTotal)}`);
console.log(
  `Job or not, across the whole inbox: ${Math.round((weightedRight / weightedTotal) * 100)}% ` +
`(the sample scaled up to all ${sample.seen.relevant + sample.seen.unsure + sample.seen.excluded} emails of the period)`,
);
console.log(`Wrong at ${config.AUTO_APPLY_CONFIDENCE} confidence or above (would act without review): ${confidentWrong}`);
if (unreadable) console.log(`Unreadable answers, sent to the review queue: ${unreadable}`);
