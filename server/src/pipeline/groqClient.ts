import { z } from "zod";
import { ClassifierError } from "./classify.ts";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export interface GroqOptions {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  /** Injected in tests so retries don't actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

export interface GroqJsonRequest {
  system: string;
  user: string;
  schemaName: string;
  /** JSON Schema the answer must follow; Groq enforces it in strict mode. */
  schema: Record<string, unknown>;
}

/** One chat completion that returns the model's JSON answer, still unvalidated. */
export type GroqJson = (request: GroqJsonRequest) => Promise<unknown>;

// Rate limits and server errors.
const MAX_TRANSIENT_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 30_000;

const responseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
});

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  const ms = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
  return Math.min(ms, MAX_RETRY_WAIT_MS);
}

/** Zod schema → the JSON Schema Groq expects, without the `$schema` marker it rejects. */
export function toGroqSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _unused, ...jsonSchema } = z.toJSONSchema(schema);
  return jsonSchema;
}

/**
 * Waits out rate limits and server errors, then reports what went wrong as a ClassifierError:
 * `unavailable` when Groq can't be reached, `auth` for a rejected key, `invalid_output` for an unusable answer.
 */
export function createGroqJson(options: GroqOptions): GroqJson {
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function send(body: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetchImpl(GROQ_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
          body,
        });
      } catch (error) {
        if (attempt >= MAX_TRANSIENT_RETRIES) throw new ClassifierError("unavailable", "Groq request failed", { cause: error });
        await sleep(1000 * 2 ** attempt);
        continue;
      }

      if (response.status !== 429 && response.status < 500) return response;
      if (attempt >= MAX_TRANSIENT_RETRIES) {
        throw new ClassifierError("unavailable", `Groq returned HTTP ${response.status} after ${attempt + 1} attempts`);
      }
      await sleep(retryDelayMs(response, attempt));
    }
  }

  return async ({ system, user, schemaName, schema }) => {
    const response = await send(
      JSON.stringify({
        model: options.model,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } },
      }),
    );

    if (response.status === 401 || response.status === 403) {
      throw new ClassifierError("auth", `Groq rejected the API key (HTTP ${response.status})`);
    }
    if (!response.ok) {
      // Includes the 400 Groq returns when the model's output fails schema validation.
      const detail = (await response.text()).slice(0, 300);
      throw new ClassifierError("invalid_output", `Groq returned HTTP ${response.status}: ${detail}`);
    }

    try {
      const parsed = responseSchema.parse(await response.json());
      return JSON.parse(parsed.choices[0]!.message.content ?? "");
    } catch (error) {
      throw new ClassifierError("invalid_output", "Groq response was not valid JSON", { cause: error });
    }
  };
}
