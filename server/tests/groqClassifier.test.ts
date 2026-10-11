import { describe, expect, test, vi } from "vitest";
import type { ClassifierInput } from "../src/pipeline/classify.ts";
import { buildUserMessage, createGroqClassifier } from "../src/pipeline/groqClassifier.ts";

const email: ClassifierInput = {
  senderName: "HackerRank Team",
  senderEmail: "support@hackerrankforwork.com",
  subject: "Databricks Coding Assessment Invitation",
  receivedAt: new Date("2026-10-05T14:30:00Z"),
  text: "Databricks has invited you to complete a coding assessment. Please complete it by October 12, 2026.",
};

const output = (overrides: Record<string, unknown> = {}) => ({
  job_related: true,
  kind: "oa",
  company: "Databricks",
  role: null,
  confidence: 0.96,
  evidence: "invited you to complete a coding assessment",
  summary: "Databricks sent a coding assessment due October 12.",
  deadline: "2026-10-12",
  interview_at: null,
  ...overrides,
});

const completion = (content: unknown) =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
const status = (code: number, headers?: Record<string, string>) => new Response("{}", { status: code, headers });

function setup(...responses: (Response | Error)[]) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn(async (_ms: number) => {});
  const classifier = createGroqClassifier({ apiKey: "test-key", model: "test-model", fetch: fetchMock, sleep });
  return { classifier, fetchMock, sleep };
}

describe("groq classifier", () => {
  test("sends the email with a strict JSON schema and returns the validated result", async () => {
    const { classifier, fetchMock } = setup(completion(output()));

    const result = await classifier.classify(email);
    expect(result).toMatchObject({ kind: "oa", company: "Databricks", confidence: 0.96, source: "llm" });
    expect(result.deadline?.toISOString()).toBe("2026-10-12T00:00:00.000Z");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(new Headers(init!.headers).get("authorization")).toBe("Bearer test-key");

    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe("test-model");
    expect(body.temperature).toBe(0);
    expect(body.messages[1].content).toBe(buildUserMessage(email));
    expect(body.response_format.json_schema.strict).toBe(true);

    const schema = body.response_format.json_schema.schema;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required.sort()).toEqual(Object.keys(schema.properties).sort());
    expect(schema.properties.kind.enum).toEqual(["applied", "oa", "interview", "offer", "rejected", "other"]);
  });

  test("puts the sender, subject, received date with weekday, and body in the user message", () => {
    expect(buildUserMessage(email)).toBe(
      [
        "<email>",
        "From: HackerRank Team <support@hackerrankforwork.com>",
        "Subject: Databricks Coding Assessment Invitation",
        "Received: 2026-10-05T14:30:00.000Z (Monday)",
        "Body:",
        email.text,
        "</email>",
      ].join("\n"),
    );
  });

  test("lists the tracked companies and limits known_company to exactly those names", async () => {
    const { classifier, fetchMock } = setup(completion(output({ company: "DBX", known_company: "Databricks" })));

    const result = await classifier.classify(email, { knownCompanies: ["Databricks", "Stripe", "Databricks"] });
    expect(result).toMatchObject({ company: "Databricks", companyAsWritten: "DBX" });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.messages[1].content).toBe(
      `<tracked_companies>\nDatabricks\nStripe\n</tracked_companies>\n${buildUserMessage(email)}`,
    );
    const schema = body.response_format.json_schema.schema;
    expect(schema.required).toContain("known_company");
    expect(schema.properties.known_company.anyOf).toEqual([
      { type: "string", enum: ["Databricks", "Stripe"] },
      { type: "null" },
    ]);
  });

  test("asks for no known_company when nothing is tracked", async () => {
    const { classifier, fetchMock } = setup(completion(output()));
    await classifier.classify(email, { knownCompanies: [] });
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.response_format.json_schema.schema.properties).not.toHaveProperty("known_company");
  });

  test("retries when the model names a company that is not tracked", async () => {
    const { classifier, fetchMock } = setup(
      completion(output({ known_company: "Snowflake" })),
      completion(output({ known_company: null })),
    );
    expect((await classifier.classify(email, { knownCompanies: ["Stripe"] })).company).toBe("Databricks");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("retries once when the evidence is not in the email, then succeeds", async () => {
    const { classifier, fetchMock } = setup(
      completion(output({ evidence: "you have been selected for an assessment" })),
      completion(output()),
    );
    expect((await classifier.classify(email)).kind).toBe("oa");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("gives up with invalid_output after two unusable answers", async () => {
    const { classifier, fetchMock } = setup(completion(output({ kind: "ghosted" })), completion({ nope: true }));
    await expect(classifier.classify(email)).rejects.toMatchObject({ code: "invalid_output" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("treats non-JSON content and a schema-validation 400 as invalid output", async () => {
    const notJson = new Response(JSON.stringify({ choices: [{ message: { content: "Sure! Here you go" } }] }));
    const { classifier } = setup(notJson, status(400));
    await expect(classifier.classify(email)).rejects.toMatchObject({ code: "invalid_output" });
  });

  test("waits for retry-after on a rate limit, then succeeds", async () => {
    const { classifier, sleep } = setup(status(429, { "retry-after": "7" }), completion(output()));
    expect((await classifier.classify(email)).kind).toBe("oa");
    expect(sleep).toHaveBeenCalledExactlyOnceWith(7000);
  });

  test("backs off exponentially on server and network errors", async () => {
    const { classifier, sleep } = setup(status(503), new TypeError("fetch failed"), completion(output()));
    expect((await classifier.classify(email)).kind).toBe("oa");
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
  });

  test("caps a long retry-after", async () => {
    const { classifier, sleep } = setup(status(429, { "retry-after": "900" }), completion(output()));
    await classifier.classify(email);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(30_000);
  });

  test("reports unavailable after repeated rate limits", async () => {
    const { classifier, fetchMock } = setup(status(429), status(429), status(429), status(429));
    await expect(classifier.classify(email)).rejects.toMatchObject({ code: "unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  test("reports a rejected API key without retrying", async () => {
    const { classifier, fetchMock, sleep } = setup(status(401));
    await expect(classifier.classify(email)).rejects.toMatchObject({ code: "auth" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
