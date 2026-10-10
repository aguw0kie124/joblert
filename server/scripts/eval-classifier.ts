// Runs the fixture emails through real classifiers and prints how many each gets right.
// Usage: npm run eval:classifier -w server -- [model ...]   (defaults to GROQ_MODEL; "rules" is always included)
import { loadConfig } from "../src/config.ts";
import type { Classifier } from "../src/pipeline/classify.ts";
import { companySimilarity } from "../src/pipeline/company.ts";
import { createGroqClassifier } from "../src/pipeline/groqClassifier.ts";
import { createRulesClassifier } from "../src/pipeline/rulesClassifier.ts";
import { emailFixtures } from "../tests/fixtures/emails.ts";

const config = loadConfig();
if (!config.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not set");

const models = process.argv.slice(2).length ? process.argv.slice(2) : [config.GROQ_MODEL];
const classifiers: [name: string, classifier: Classifier][] = [
  ["rules", createRulesClassifier()],
  ...models.map((model): [string, Classifier] => [model, createGroqClassifier({ apiKey: config.GROQ_API_KEY!, model })]),
];

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
