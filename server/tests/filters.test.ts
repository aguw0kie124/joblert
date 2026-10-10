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
    expect(filterEmail(email({ senderEmail }))).toEqual({ relevant: true, reason: "ats_domain" });
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
    expect(filterEmail(email({ subject }))).toEqual({ relevant: true, reason: "keyword" });
  });

  test("an unambiguous phrase in the body", () => {
    const body = "Hi Sam,\n\nUnfortunately, we have decided not to proceed with your application at this time.";
    expect(filterEmail(email({ subject: "Acme update", body }))).toEqual({ relevant: true, reason: "keyword" });
  });

  test("a recruiter writing from a tracked company's domain", () => {
    const result = filterEmail(
      email({ senderEmail: "jane@stripe.com", subject: "Quick chat?", knownCompanies: ["Stripe, Inc."] }),
    );
    expect(result).toEqual({ relevant: true, reason: "known_company" });
  });

  test("a tracked company named in the sender display name", () => {
    const result = filterEmail(
      email({
        senderEmail: "notifications@mail.example-ats.com",
        senderName: "Palantir Technologies",
        subject: "An update",
        knownCompanies: ["Palantir"],
      }),
    );
    expect(result).toEqual({ relevant: true, reason: "known_company" });
  });

  test("any reply in a thread already linked to an application, even an alert-like one", () => {
    const result = filterEmail(email({ subject: "Re: apply now", inKnownThread: true }));
    expect(result).toEqual({ relevant: true, reason: "known_thread" });
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
    expect(filterEmail(email({ senderEmail, subject }))).toEqual({ relevant: false, reason: "excluded" });
  });

  test.each([
    ["orders@shop.com", "Your order has shipped", "Thanks for your purchase. Special offer inside."],
    ["friend@gmail.com", "Dinner on Friday?", "Unfortunately I can't make it."],
    ["billing@saas.com", "Invoice for October", undefined],
  ])("unrelated mail from %s", (senderEmail, subject, body) => {
    expect(filterEmail(email({ senderEmail, subject, body }))).toEqual({ relevant: false, reason: "no_signal" });
  });

  test("mail from a company that is not tracked", () => {
    const result = filterEmail(
      email({ senderEmail: "jane@stripe.com", subject: "Quick chat?", knownCompanies: ["Square"] }),
    );
    expect(result.relevant).toBe(false);
  });
});

test("isAtsDomain matches suffixes, not substrings", () => {
  expect(isAtsDomain("greenhouse.io")).toBe(true);
  expect(isAtsDomain("mail.greenhouse.io")).toBe(true);
  expect(isAtsDomain("notgreenhouse.io")).toBe(false);
  expect(isAtsDomain("greenhouse.io.evil.com")).toBe(false);
});
