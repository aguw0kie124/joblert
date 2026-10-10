import { describe, expect, test } from "vitest";
import {
  ClassifierError,
  evidenceAppearsIn,
  finalizeClassification,
  withFallback,
  type Classification,
  type Classifier,
  type ClassifierInput,
} from "../src/pipeline/classify.ts";
import { createRulesClassifier, RULES_CONFIDENCE } from "../src/pipeline/rulesClassifier.ts";
import { emailFixtures } from "./fixtures/emails.ts";

const email: ClassifierInput = {
  senderName: "Stripe Recruiting",
  senderEmail: "no-reply@greenhouse.io",
  subject: "Update on your application",
  receivedAt: new Date("2026-10-05T14:30:00Z"),
  text: "Hi Sam,\n\nUnfortunately, we’ve decided not to move\nforward with your application. Please reply by October 12.",
};

const raw = (overrides: Record<string, unknown> = {}) => ({
  job_related: true,
  kind: "rejected",
  company: "Stripe",
  role: "Backend Engineer",
  confidence: 0.95,
  evidence: "we've decided not to move forward with your application",
  summary: "Stripe rejected the application.",
  deadline: null,
  interview_at: null,
  ...overrides,
});

const expectInvalid = (fn: () => unknown) => {
  expect(fn).toThrow(ClassifierError);
  expect(fn).toThrow(expect.objectContaining({ code: "invalid_output" }));
};

describe("finalizeClassification", () => {
  test("accepts valid output and maps it to the internal shape", () => {
    expect(finalizeClassification(raw(), email, "llm")).toEqual({
      jobRelated: true,
      kind: "rejected",
      company: "Stripe",
      role: "Backend Engineer",
      confidence: 0.95,
      evidence: "we've decided not to move forward with your application",
      summary: "Stripe rejected the application.",
      deadline: null,
      interviewAt: null,
      source: "llm",
    });
  });

  test.each([
    ["an unknown kind", { kind: "ghosted" }],
    ["confidence above 1", { confidence: 1.4 }],
    ["a missing field", { summary: undefined }],
    ["a wrong type", { job_related: "yes" }],
  ])("rejects %s", (_name, overrides) => {
    expectInvalid(() => finalizeClassification(raw(overrides), email, "llm"));
  });

  test("rejects output that is not an object", () => {
    expectInvalid(() => finalizeClassification("rejected", email, "llm"));
  });

  test("rejects evidence the email does not contain", () => {
    expectInvalid(() => finalizeClassification(raw({ evidence: "we regret to inform you" }), email, "llm"));
  });

  test("rejects empty or trivially short evidence for a status", () => {
    expectInvalid(() => finalizeClassification(raw({ evidence: "" }), email, "llm"));
    expectInvalid(() => finalizeClassification(raw({ evidence: "we" }), email, "llm"));
  });

  test("forces kind to other when the email is not job related, and needs no evidence", () => {
    const result = finalizeClassification(raw({ job_related: false, kind: "offer", evidence: "made up" }), email, "llm");
    expect(result).toMatchObject({ jobRelated: false, kind: "other", evidence: "" });
  });

  test("turns blank company and role into null", () => {
    const result = finalizeClassification(raw({ company: "  ", role: "" }), email, "llm");
    expect(result).toMatchObject({ company: null, role: null });
  });

  test("keeps plausible dates, including a date-only deadline on the day of the email", () => {
    const result = finalizeClassification(
      raw({ deadline: "2026-10-05", interview_at: "2026-10-08T21:00:00Z" }),
      email,
      "llm",
    );
    expect(result.deadline?.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(result.interviewAt?.toISOString()).toBe("2026-10-08T21:00:00.000Z");
  });

  test.each([
    ["unparseable", "next Friday"],
    ["in the past", "2025-10-12"],
    ["more than a year out", "2028-01-01"],
  ])("drops a deadline that is %s", (_name, deadline) => {
    expect(finalizeClassification(raw({ deadline }), email, "llm").deadline).toBeNull();
  });
});

describe("evidenceAppearsIn", () => {
  test.each([
    ["different case and line wrapping", "UNFORTUNATELY, we've decided not to move forward"],
    ["straight quotes for curly ones", "we've decided not to move"],
    ["wrapping quotes and a trailing ellipsis", '"decided not to move forward…"'],
    ["a quote from the subject", "Update on your application"],
  ])("accepts %s", (_name, evidence) => {
    expect(evidenceAppearsIn(evidence, email)).toBe(true);
  });

  test("rejects a paraphrase", () => {
    expect(evidenceAppearsIn("decided to not move forward", email)).toBe(false);
  });
});

describe("withFallback", () => {
  const fallbackResult = { kind: "rejected", source: "rules" } as Classification;
  const fallback: Classifier = { classify: async () => fallbackResult };
  const failing = (code: ClassifierError["code"]): Classifier => ({
    classify: async () => {
      throw new ClassifierError(code, "boom");
    },
  });

  test("returns the primary result when it succeeds", async () => {
    const primaryResult = { kind: "offer", source: "llm" } as Classification;
    const classifier = withFallback({ classify: async () => primaryResult }, fallback);
    expect(await classifier.classify(email)).toBe(primaryResult);
  });

  test("falls back when the primary's output is unusable", async () => {
    expect(await withFallback(failing("invalid_output"), fallback).classify(email)).toBe(fallbackResult);
  });

  test.each(["unavailable", "auth"] as const)("does not hide an %s error", async (code) => {
    await expect(withFallback(failing(code), fallback).classify(email)).rejects.toMatchObject({ code });
  });
});

describe("rules classifier", () => {
  const rules = createRulesClassifier();

  for (const fixture of emailFixtures.filter((f) => !f.hard)) {
    test(`classifies "${fixture.name}"`, async () => {
      const result = await rules.classify(fixture.email);
      expect(result.kind).toBe(fixture.expected.kind);
      expect(result.jobRelated).toBe(fixture.expected.jobRelated);
    });
  }

  test("stays below the auto-apply threshold and quotes the email", async () => {
    const result = await rules.classify(email);
    expect(result).toMatchObject({ kind: "rejected", confidence: RULES_CONFIDENCE, source: "rules" });
    expect(RULES_CONFIDENCE).toBeLessThan(0.85);
    expect(evidenceAppearsIn(result.evidence, email)).toBe(true);
  });

  test("guesses the company from the subject, then the sender name", async () => {
    const [stripe] = emailFixtures;
    expect((await rules.classify(stripe!.email)).company).toBe("Stripe");
    expect((await rules.classify(email)).company).toBe("Stripe");
  });
});
