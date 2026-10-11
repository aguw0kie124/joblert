import { describe, expect, test } from "vitest";
import {
  ClassifierError,
  evidenceAppearsIn,
  finalizeClassification,
  type ClassifierInput,
} from "../src/pipeline/classify.ts";

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
    expect(finalizeClassification(raw(), email)).toEqual({
      jobRelated: true,
      kind: "rejected",
      company: "Stripe",
      companyAsWritten: "Stripe",
      role: "Backend Engineer",
      confidence: 0.95,
      evidence: "we've decided not to move forward with your application",
      summary: "Stripe rejected the application.",
      deadline: null,
      interviewAt: null,
    });
  });

  test.each([
    ["an unknown kind", { kind: "ghosted" }],
    ["confidence above 1", { confidence: 1.4 }],
    ["a missing field", { summary: undefined }],
    ["a wrong type", { job_related: "yes" }],
  ])("rejects %s", (_name, overrides) => {
    expectInvalid(() => finalizeClassification(raw(overrides), email));
  });

  test("rejects output that is not an object", () => {
    expectInvalid(() => finalizeClassification("rejected", email));
  });

  test("rejects evidence the email does not contain", () => {
    expectInvalid(() => finalizeClassification(raw({ evidence: "we regret to inform you" }), email));
  });

  test("rejects empty or trivially short evidence for a status", () => {
    expectInvalid(() => finalizeClassification(raw({ evidence: "" }), email));
    expectInvalid(() => finalizeClassification(raw({ evidence: "we" }), email));
  });

  test("forces kind to other when the email is not job related, and needs no evidence", () => {
    const result = finalizeClassification(raw({ job_related: false, kind: "offer", evidence: "made up" }), email);
    expect(result).toMatchObject({ jobRelated: false, kind: "other", evidence: "" });
  });

  test("turns blank company and role into null", () => {
    const result = finalizeClassification(raw({ company: "  ", role: "" }), email);
    expect(result).toMatchObject({ company: null, role: null });
  });

  test("keeps plausible dates, including a date-only deadline on the day of the email", () => {
    const result = finalizeClassification(
      raw({ deadline: "2026-10-05", interview_at: "2026-10-08T21:00:00Z" }),
      email,
    );
    expect(result.deadline?.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(result.interviewAt?.toISOString()).toBe("2026-10-08T21:00:00.000Z");
  });

  test.each([
    ["unparseable", "next Friday"],
    ["in the past", "2025-10-12"],
    ["more than a year out", "2028-01-01"],
  ])("drops a deadline that is %s", (_name, deadline) => {
    expect(finalizeClassification(raw({ deadline }), email).deadline).toBeNull();
  });
});

describe("finalizeClassification with tracked companies", () => {
  const tracked = ["Procter & Gamble", "Stripe"];

  test("uses the tracked name when the model says it is the same employer, and keeps what the email said", () => {
    const result = finalizeClassification(raw({ company: "P&G", known_company: "Procter & Gamble" }), email, tracked);
    expect(result).toMatchObject({ company: "Procter & Gamble", companyAsWritten: "P&G" });
  });

  test("keeps the email's own name when the model matches none", () => {
    const result = finalizeClassification(raw({ company: "Ramp", known_company: null }), email, tracked);
    expect(result).toMatchObject({ company: "Ramp", companyAsWritten: "Ramp" });
  });

  test("rejects a company that is not on the list", () => {
    expectInvalid(() => finalizeClassification(raw({ known_company: "Procter and Gamble" }), email, tracked));
  });

  test("rejects an answer that leaves the field out", () => {
    expectInvalid(() => finalizeClassification(raw(), email, tracked));
  });

  test("ignores a tracked company on mail that is not job related", () => {
    const result = finalizeClassification(raw({ job_related: false, known_company: "Stripe" }), email, tracked);
    expect(result).toMatchObject({ jobRelated: false, companyAsWritten: "Stripe" });
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
