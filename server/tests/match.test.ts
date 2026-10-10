import { describe, expect, test } from "vitest";
import {
  matchEmail,
  roleSimilarity,
  roleTokens,
  type MatchCandidate,
  type MatchEmail,
} from "../src/pipeline/match.ts";

const day = (n: number) => new Date(Date.UTC(2026, 8, n));

const application = (overrides: Partial<MatchCandidate> & { id: string }): MatchCandidate => ({
  company: "Stripe",
  role: "Backend Engineer",
  appliedAt: day(1),
  threadIds: [],
  ...overrides,
});

const email = (overrides: Partial<MatchEmail> = {}): MatchEmail => ({
  threadId: "thread-new",
  senderEmail: "no-reply@greenhouse.io",
  company: "Stripe",
  role: "Backend Engineer",
  receivedAt: day(10),
  ...overrides,
});

describe("matchEmail", () => {
  test("matches the one application at the named company", () => {
    const result = matchEmail(email(), [
      application({ id: "stripe" }),
      application({ id: "square", company: "Square" }),
    ]);
    expect(result).toMatchObject({ type: "match", applicationId: "stripe", via: "score" });
  });

  test("matches across company name variants and aliases", () => {
    expect(matchEmail(email({ company: "Stripe, Inc." }), [application({ id: "a" })])).toMatchObject({
      type: "match",
      applicationId: "a",
    });
    expect(
      matchEmail(email({ company: "Facebook", role: null }), [application({ id: "m", company: "Meta" })]),
    ).toMatchObject({ type: "match", applicationId: "m" });
  });

  test("uses the role title to pick between two applications at the same company", () => {
    const result = matchEmail(email({ role: "Data Scientist" }), [
      application({ id: "backend" }),
      application({ id: "data", role: "Data Scientist" }),
    ]);
    expect(result).toMatchObject({ type: "match", applicationId: "data" });
  });

  test("is ambiguous when two applications at the company fit and the email names no role", () => {
    const result = matchEmail(email({ role: null }), [
      application({ id: "backend" }),
      application({ id: "data", role: "Data Scientist" }),
    ]);
    expect(result.type).toBe("ambiguous");
    expect(result.type === "ambiguous" && result.candidates.map((c) => c.applicationId).sort()).toEqual([
      "backend",
      "data",
    ]);
  });

  test("is ambiguous when the role fits two applications about equally", () => {
    const result = matchEmail(email({ role: "Software Engineer" }), [
      application({ id: "new-grad", role: "Software Engineer, New Grad" }),
      application({ id: "intern", role: "Software Engineer Intern" }),
    ]);
    expect(result.type).toBe("ambiguous");
  });

  test("prefers the exact title over a longer variant", () => {
    const result = matchEmail(email({ role: "Software Engineer" }), [
      application({ id: "exact", role: "Software Engineer" }),
      application({ id: "intern", role: "Software Engineer Intern, Summer 2027" }),
    ]);
    expect(result).toMatchObject({ type: "match", applicationId: "exact" });
  });

  test("a known thread wins over everything else", () => {
    const result = matchEmail(email({ threadId: "thread-7", company: "Square", role: "Designer" }), [
      application({ id: "stripe", threadIds: ["thread-7"] }),
      application({ id: "square", company: "Square", role: "Designer" }),
    ]);
    expect(result).toEqual({ type: "match", applicationId: "stripe", score: 1, via: "thread" });
  });

  test("matches on the sender's domain when the email names no company", () => {
    const result = matchEmail(email({ senderEmail: "jane@careers.stripe.com", company: null, role: null }), [
      application({ id: "stripe" }),
      application({ id: "square", company: "Square" }),
    ]);
    expect(result).toMatchObject({ type: "match", applicationId: "stripe" });
  });

  test("returns none for an unknown company", () => {
    expect(matchEmail(email({ company: "Initech" }), [application({ id: "stripe" })])).toEqual({ type: "none" });
  });

  test("returns none when the company matches but the role is a different job", () => {
    const result = matchEmail(email({ role: "Product Designer" }), [application({ id: "backend" })]);
    expect(result).toEqual({ type: "none" });
  });

  test("ignores applications made after the email arrived", () => {
    const result = matchEmail(email({ receivedAt: day(10) }), [application({ id: "later", appliedAt: day(20) })]);
    expect(result).toEqual({ type: "none" });
  });

  test("allows a confirmation timestamped just before the logged application", () => {
    const appliedAt = new Date(day(10).getTime() + 60 * 60 * 1000);
    const result = matchEmail(email({ receivedAt: day(10) }), [application({ id: "a", appliedAt })]);
    expect(result).toMatchObject({ type: "match", applicationId: "a" });
  });

  test("returns none with no candidates", () => {
    expect(matchEmail(email(), [])).toEqual({ type: "none" });
  });
});

describe("role titles", () => {
  test("expands abbreviations and ignores word order and punctuation", () => {
    expect(roleTokens("Sr. SWE, Backend")).toEqual(new Set(["senior", "software", "engineer", "backend"]));
    expect(roleSimilarity("Software Engineer, Backend", "Backend Software Engineer").jaccard).toBe(1);
  });

  test("a shorter title contained in a longer one overlaps fully but ranks lower", () => {
    const similarity = roleSimilarity("Software Engineer", "Software Engineer Intern");
    expect(similarity.overlap).toBe(1);
    expect(similarity.jaccard).toBeCloseTo(2 / 3);
  });

  test("keeps language names like C++ and C# distinct", () => {
    expect(roleTokens("C++ Developer")).toEqual(new Set(["c++", "developer"]));
    expect(roleSimilarity("C++ Developer", "C# Developer").jaccard).toBeCloseTo(1 / 3);
  });
});
