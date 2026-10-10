import type { Config } from "../config.ts";
import { withFallback, type Classifier } from "./classify.ts";
import { createGroqClassifier } from "./groqClassifier.ts";
import { createRulesClassifier } from "./rulesClassifier.ts";

/** Groq with keyword rules behind it; rules alone when no API key is configured. */
export function createClassifier(config: Pick<Config, "GROQ_API_KEY" | "GROQ_MODEL">): Classifier {
  const rules = createRulesClassifier();
  if (!config.GROQ_API_KEY) return rules;
  return withFallback(createGroqClassifier({ apiKey: config.GROQ_API_KEY, model: config.GROQ_MODEL }), rules);
}
