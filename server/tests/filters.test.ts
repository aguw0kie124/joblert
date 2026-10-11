import { describe, expect, test } from "vitest";
import { filterEmail, isAtsDomain, type FilterInput } from "../src/gmail/filters.ts";

const email = (overrides: Partial<FilterInput>): FilterInput => ({
  senderEmail: "someone@example.com",
  subject: "Hello",
  ...overrides,
});

describe("filterEmail keeps", () => {
  test.each([
    ["Greenhouse", "no-reply@greenhouse.io"],
    ["Greenhouse subdomain", "no-reply@us.greenhouse-mail.io"],
    ["Lever", "no-reply@hire.lever.co"],
    ["Workday", "acme@myworkday.com"],
    ["Ashby", "notifications@ashbyhq.com"],
    ["HackerRank", "support@hackerrankforwork.com"],
  ])("mail from %s", (_name, senderEmail) => {
    expect(filterEmail(email({ senderEmail }))).toEqual({ verdict: "relevant", reason: "ats_domain" });
  });

  test.each([
    "Thank you for applying to Acme",
    "Your application to Acme",
    "Application received - Backend Engineer",
    "Interview availability",
    "Acme Online Assessment",
    "Next steps with Acme",
    "Update on your candidacy",
    "Your offer letter from Acme",
  ])("subject %j", (subject) => {
    expect(filterEmail(email({ subject }))).toEqual({ verdict: "relevant", reason: "keyword" });
  });

  test("an unambiguous phrase in the body", () => {
    const body = "Hi Sam,\n\nUnfortunately, we have decided not to proceed with your application at this time.";
    expect(filterEmail(email({ subject: "Acme update", body }))).toEqual({ verdict: "relevant", reason: "keyword" });
  });

  test("any reply in a thread already linked to an application, even an alert-like one", () => {
    const result = filterEmail(email({ subject: "Re: apply now", inKnownThread: true }));
    expect(result).toEqual({ verdict: "relevant", reason: "known_thread" });
  });
});

describe("filterEmail drops", () => {
  test.each([
    ["jobalerts-noreply@linkedin.com", "Software Engineer roles: your application could be next"],
    ["alert@indeed.com", "Interview tips and 12 jobs"],
    ["hello@startup.com", "30 new jobs for you"],
    ["news@acme.com", "Acme is hiring! Apply now"],
    ["team@careersite.com", "Weekly digest: interview prep"],
    ["no-reply@greenhouse.io", "Job alert: new roles at Acme"],
  ])("alerts and marketing from %s: %j", (senderEmail, subject) => {
    expect(filterEmail(email({ senderEmail, subject }))).toEqual({ verdict: "excluded" });
  });

});

describe("filterEmail leaves to the triage", () => {
  test.each([
    ["orders@shop.com", "Your order has shipped", "Thanks for your purchase. Special offer inside."],
    ["friend@gmail.com", "Dinner on Friday?", "Unfortunately I can't make it."],
    ["billing@saas.com", "Invoice for October", undefined],
    // A sender alone says nothing: a tracked company also sends card offers and account notices.
    ["jane@stripe.com", "Quick chat?", undefined],
  ])("mail no rule settles, from %s", (senderEmail, subject, body) => {
    expect(filterEmail(email({ senderEmail, subject, body }))).toEqual({ verdict: "unsure" });
  });
});

test("isAtsDomain matches suffixes, not substrings", () => {
  expect(isAtsDomain("greenhouse.io")).toBe(true);
  expect(isAtsDomain("mail.greenhouse.io")).toBe(true);
  expect(isAtsDomain("notgreenhouse.io")).toBe(false);
  expect(isAtsDomain("greenhouse.io.evil.com")).toBe(false);
});
