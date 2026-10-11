// Runs the fixture emails through real classifiers and prints how many each gets right,
// then how well each model screens mail (triage) and recognises a tracked company under another name.
// Usage: npm run eval:classifier -w server -- [model ...]   (defaults to GROQ_MODEL)
import { loadConfig } from "../src/config.ts";
import type { Classifier } from "../src/pipeline/classify.ts";
import { companySimilarity } from "../src/pipeline/company.ts";
import { createGroqClassifier } from "../src/pipeline/groqClassifier.ts";
import { createGroqTriager, SNIPPET_CHARS } from "../src/pipeline/triage.ts";
import { aliasFixtures, emailFixtures, triageFixtures } from "../tests/fixtures/emails.ts";

const config = loadConfig();
if (!config.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not set");

const models = process.argv.slice(2).length ? process.argv.slice(2) : [config.GROQ_MODEL];
const classifiers = models.map((model): [name: string, classifier: Classifier] => [
  model,
  createGroqClassifier({ apiKey: config.GROQ_API_KEY!, model }),
]);

const summary: Record<string, string | number>[] = [];

for (const [name, classifier] of classifiers) {
  let kindRight = 0;
  let companyRight = 0;
  let companyTotal = 0;
  let confidentWrong = 0;
  let errors = 0;
  const misses: string[] = [];
  const started = Date.now();

  for (const fixture of emailFixtures) {
    try {
      const result = await classifier.classify(fixture.email);
      const kindOk = result.kind === fixture.expected.kind && result.jobRelated === fixture.expected.jobRelated;
      if (kindOk) kindRight++;
      else {
        if (result.confidence >= config.AUTO_APPLY_CONFIDENCE) confidentWrong++;
        misses.push(
          `  ${fixture.name}\n    expected ${fixture.expected.kind} (job: ${fixture.expected.jobRelated}), ` +
            `got ${result.kind} (job: ${result.jobRelated}) at ${result.confidence}`,
        );
      }
      if (fixture.expected.company) {
        companyTotal++;
        if (result.company && companySimilarity(result.company, fixture.expected.company) > 0) companyRight++;
        else misses.push(`  ${fixture.name}\n    company: expected ${fixture.expected.company}, got ${result.company}`);
      }
    } catch (error) {
      errors++;
      misses.push(`  ${fixture.name}\n    error: ${(error as Error).message}`);
    }
  }

  summary.push({
    classifier: name,
    kind: `${kindRight}/${emailFixtures.length}`,
    company: `${companyRight}/${companyTotal}`,
    "wrong but confident": confidentWrong,
    errors,
    "avg ms": Math.round((Date.now() - started) / emailFixtures.length),
  });
  if (misses.length) console.log(`\n${name} misses:\n${misses.join("\n")}`);
}

console.log();
console.table(summary);

// Triage: every classifier fixture is also a screening case, plus the mail only the triage sees.
const screening = [
  ...emailFixtures.map((f) => ({ name: f.name, email: f.email, knownCompanies: ["Amazon"], expected: f.expected.jobRelated })),
  ...triageFixtures,
];
const extras: Record<string, string | number>[] = [];

for (const model of models) {
  const misses: string[] = [];
  const triager = createGroqTriager({ apiKey: config.GROQ_API_KEY, model });
  let kept = 0;
  let lost = 0;
  let passed = 0;
  let triageErrors = 0;
  // One fixture per request with its own tracked list would hide how the model does on a full batch.
  const tracked = [...new Set(screening.flatMap((f) => f.knownCompanies))];
  try {
    const verdicts = await triager.triage(
      screening.map(({ email }) => ({
        senderName: email.senderName,
        senderEmail: email.senderEmail,
        subject: email.subject,
        snippet: email.text.slice(0, SNIPPET_CHARS),
      })),
      tracked,
    );
    for (const [index, fixture] of screening.entries()) {
      if (verdicts[index] === fixture.expected) kept++;
      else if (fixture.expected) {
        lost++;
        misses.push(`  ${fixture.name}\n    triage dropped job mail`);
      } else {
        passed++;
        misses.push(`  ${fixture.name}\n    triage let non-job mail through`);
      }
    }
  } catch (error) {
    triageErrors++;
    misses.push(`  triage error: ${(error as Error).message}`);
  }

  const classifier = createGroqClassifier({ apiKey: config.GROQ_API_KEY, model });
  let aliasRight = 0;
  let aliasErrors = 0;
  for (const fixture of aliasFixtures) {
    try {
      const result = await classifier.classify(fixture.email, { knownCompanies: fixture.knownCompanies });
      const resolved = fixture.knownCompanies.includes(result.company ?? "") ? result.company : null;
      if (resolved === fixture.expected) aliasRight++;
      else misses.push(`  ${fixture.name}\n    expected ${fixture.expected}, got ${resolved} (read as ${result.companyAsWritten})`);
    } catch (error) {
      aliasErrors++;
      misses.push(`  ${fixture.name}\n    error: ${(error as Error).message}`);
    }
  }

  extras.push({
    model,
    triage: `${kept}/${screening.length}`,
    "job mail dropped": lost,
    "non-job passed": passed,
    alias: `${aliasRight}/${aliasFixtures.length}`,
    errors: triageErrors + aliasErrors,
  });
  if (misses.length) console.log(`\n${model} triage and alias misses:\n${misses.join("\n")}`);
}

console.log();
console.table(extras);
