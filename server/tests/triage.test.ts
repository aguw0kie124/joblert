import { describe, expect, test, vi } from "vitest";
import { ClassifierError } from "../src/pipeline/classify.ts";
import {
  buildTriageMessage,
  createGroqTriager,
  finalizeTriage,
  TRIAGE_BATCH,
  type TriageItem,
} from "../src/pipeline/triage.ts";

const item = (subject: string, overrides: Partial<TriageItem> = {}): TriageItem => ({
  senderName: "Dana Lee",
  senderEmail: "dana@stripe.com",
  subject,
  snippet: `Hi Sam, about ${subject}`,
  ...overrides,
});

const answers = (...verdicts: boolean[]) => ({
  results: verdicts.map((job_related, index) => ({ index, job_related })),
});
const completion = (content: unknown) =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
const status = (code: number) => new Response("{}", { status: code });

function setup(...responses: Response[]) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    return next;
  });
  const sleep = vi.fn(async (_ms: number) => {});
  const triager = createGroqTriager({ apiKey: "test-key", model: "test-model", fetch: fetchMock, sleep });
  const body = (call: number) => JSON.parse(fetchMock.mock.calls[call]![1]!.body as string);
  return { triager, fetchMock, body };
}

describe("finalizeTriage", () => {
  test("returns the answers in the order the emails were sent", () => {
    const raw = { results: [{ index: 1, job_related: false }, { index: 0, job_related: true }] };
    expect(finalizeTriage(raw, 2)).toEqual([true, false]);
  });

  test.each([
    ["a missing answer", answers(true), 2],
    ["an extra answer", answers(true, false, true), 2],
    ["a repeated index", { results: [{ index: 0, job_related: true }, { index: 0, job_related: false }] }, 2],
    ["an index out of range", { results: [{ index: 5, job_related: true }] }, 1],
    ["a wrong type", { results: [{ index: 0, job_related: "yes" }] }, 1],
    ["output that is not an object", "true", 1],
  ])("rejects %s", (_name, raw, count) => {
    expect(() => finalizeTriage(raw, count)).toThrow(expect.objectContaining({ code: "invalid_output" }));
  });
});

describe("buildTriageMessage", () => {
  test("numbers each email and gives only its sender, subject and first lines", () => {
    const long = item("Hello", { senderName: null, snippet: `line one\n\nline two ${"x".repeat(400)}` });
    const message = buildTriageMessage([item("Quick chat?"), long], ["Stripe"]);

    expect(message.split("\n").slice(0, 9)).toEqual([
      "<tracked_companies>",
      "Stripe",
      "</tracked_companies>",
      '<email index="0">',
      "From: Dana Lee <dana@stripe.com>",
      "Subject: Quick chat?",
      "Starts: Hi Sam, about Quick chat?",
      "</email>",
      '<email index="1">',
    ]);
    expect(message).toContain("From: dana@stripe.com\n");
    expect(message).toContain(`Starts: line one line two ${"x".repeat(182)}\n`);
  });

  test("leaves out the tracked list when nothing is tracked", () => {
    expect(buildTriageMessage([item("Hello")])).not.toContain("tracked_companies");
  });
});

describe("groq triager", () => {
  test("sends one strict-schema request for a small batch and returns one verdict per email", async () => {
    const { triager, fetchMock, body } = setup(completion(answers(true, false)));
    const items = [item("Quick chat?"), item("Your statement is ready")];

    expect(await triager.triage(items, ["Stripe"])).toEqual([true, false]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body(0).messages[1].content).toBe(buildTriageMessage(items, ["Stripe"]));
    expect(body(0).response_format.json_schema).toMatchObject({ name: "email_triage", strict: true });
    expect(body(0).response_format.json_schema.schema.additionalProperties).toBe(false);
  });

  test("splits a long list into batches and keeps the order", async () => {
    const items = Array.from({ length: TRIAGE_BATCH + 2 }, (_, i) => item(`Subject ${i}`));
    const first = answers(...Array.from({ length: TRIAGE_BATCH }, () => false));
    const { triager, fetchMock, body } = setup(completion(first), completion(answers(true, false)));

    const verdicts = await triager.triage(items);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(verdicts).toHaveLength(TRIAGE_BATCH + 2);
    expect(verdicts.slice(-2)).toEqual([true, false]);
    expect(body(1).messages[1].content).toContain(`Subject ${TRIAGE_BATCH}`);
  });

  test("makes no request for an empty list", async () => {
    const { triager, fetchMock } = setup();
    expect(await triager.triage([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("retries once when an answer is missing, then succeeds", async () => {
    const { triager, fetchMock } = setup(completion(answers(true)), completion(answers(false, true)));
    expect(await triager.triage([item("a"), item("b")])).toEqual([false, true]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("keeps every email after two unusable answers, so none is lost", async () => {
    const { triager, fetchMock } = setup(completion({ nope: true }), status(400));
    expect(await triager.triage([item("a"), item("b")])).toEqual([true, true]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("reports unavailable after repeated rate limits", async () => {
    const { triager } = setup(status(429), status(429), status(429), status(429));
    const failure = triager.triage([item("a")]);
    await expect(failure).rejects.toBeInstanceOf(ClassifierError);
    await expect(failure).rejects.toMatchObject({ code: "unavailable" });
  });

  test("reports a rejected API key", async () => {
    const { triager } = setup(status(401));
    await expect(triager.triage([item("a")])).rejects.toMatchObject({ code: "auth" });
  });
});
