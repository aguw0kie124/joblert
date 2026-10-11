import type { Config } from "../config.ts";
import { withFallback, type Classifier } from "./classify.ts";
import { createGroqClassifier } from "./groqClassifier.ts";
import { createRulesClassifier } from "./rulesClassifier.ts";
import { createGroqTriager, type Triager } from "./triage.ts";

type GroqConfig = Pick<Config, "GROQ_API_KEY" | "GROQ_MODEL">;

/** Groq with keyword rules behind it; rules alone when no API key is configured. */
export function createClassifier(config: GroqConfig): Classifier {
  const rules = createRulesClassifier();
  if (!config.GROQ_API_KEY) return rules;
  return withFallback(createGroqClassifier({ apiKey: config.GROQ_API_KEY, model: config.GROQ_MODEL }), rules);
}

/** Null when no API key is configured: mail the filter is unsure about is then dropped. */
export function createTriager(config: GroqConfig): Triager | null {
  if (!config.GROQ_API_KEY) return null;
  return createGroqTriager({ apiKey: config.GROQ_API_KEY, model: config.GROQ_MODEL });
}
