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
    expect(filterEmail(email({ senderEmail, subject }))).toEqual({ verdict: "excluded", reason: "alert" });
  });

  test.each([
    ["donotreply@successfactors.com", "One-Time Password for Candidate Account Verification"],
    ["system@successfactors.eu", "Your application for a job at Acme – One-Time Passcode"],
    ["noreply@careers.acme.com", "Acme verification code: 384863"],
    ["no-reply@us.greenhouse-mail.io", "Security code for your application to Acme"],
    ["no-reply@icims.com", "Verify your email address"],
    ["acme@otp.workday.com", "Your sign-in passcode"],
    ["careers@recruitment.acme.com", "Please verify your identity for Summer Internship Program"],
    ["sender@workflow.mail.us2.cloud.oracle.com", "Confirm your identity for job Software Engineering Intern"],
    ["noreply@acme.com", "Your Acme identity verification"],
    ["acme+autoreply@talent.icims.com", "User account with Acme, Inc."],
    ["acme@myworkday.com", "Create an account to track your application!"],
    ["acme@myworkday.com", "[Action Required] Please Create your Candidate Home"],
    ["no-reply@codesignal.com", "Your CodeSignal guest account information"],
    ["bizx@acme.ns2cloud.com", "Your Acme Careers Account"],
    ["noreply@mail.acme.jobs", "Keep track of your application"],
    ["acme+autoreply@talent.icims.com", "Candidate Survey"],
    ["noreply-accounts@google.com", "You shared some Google Account data with Acme"],
    ["messages-noreply@linkedin.com", "View Sam Lee’s post and your next steps"],
    ["messages-noreply@linkedin.com", "Follow Sam Lee and view your next steps"],
  ])("account housekeeping and nudges from %s: %j", (senderEmail, subject) => {
    expect(filterEmail(email({ senderEmail, subject }))).toEqual({ verdict: "excluded", reason: "alert" });
  });

  test.each([
    ["no-reply@codesignal.com", "Assessment completed: Acme Coding Assessment"],
    ["assessment@email.acme.com", "[Action Required] Your Acme Application"],
    ["talent@acme.com", "Your Acme Application: Next Steps"],
  ])("but keeps mail that can carry a status, from %s: %j", (senderEmail, subject) => {
    expect(filterEmail(email({ senderEmail, subject })).verdict).not.toBe("excluded");
  });

  test.each([
    ["orders@shop.com", "Your order has shipped", "Thanks for your purchase. Special offer inside."],
    ["friend@gmail.com", "Dinner on Friday?", "Unfortunately I can't make it."],
    ["billing@saas.com", "Invoice for October", undefined],
    ["notifications@instructure.com", "Assignment Graded: HW 5", "Your assignment has been graded."],
    // Not a company the user applied to, and nothing says job.
    ["jane@stripe.com", "Quick chat?", undefined],
  ])("mail with no hint of a job, from %s", (senderEmail, subject, body) => {
    expect(filterEmail(email({ senderEmail, subject, body }))).toEqual({ verdict: "excluded", reason: "no_signal" });
  });
});

describe("filterEmail leaves to the triage", () => {
  test.each<[string, Partial<FilterInput>]>([
    ["a recruiting address", { senderEmail: "dana@recruiting.stripe.com", subject: "Following up" }],
    ["a talent team's name", { senderName: "Oracle Talent Acquisition", subject: "A note from Oracle" }],
    ["HR at the end of a name", { senderName: "WellsFargoHR", subject: "Hello again" }],
    ["a job word in the subject", { subject: "Summer 2027 Internships" }],
    ["a thank-you for your time", { subject: "Thank You for Your Time" }],
    ["a job phrase in the body", { subject: "Hello", body: "Our recruiter will reach out about the analyst role." }],
  ])("mail that only hints at a job: %s", (_name, overrides) => {
    expect(filterEmail(email(overrides))).toEqual({ verdict: "unsure" });
  });

  // A sender alone says nothing: a tracked company also sends card offers and account notices.
  test.each([
    ["its domain", { senderEmail: "jane@stripe.com" }],
    ["its name", { senderEmail: "offers@member.example.com", senderName: "American Express" }],
  ])("mail from a tracked company, by %s", (_name, overrides) => {
    const input = email({ subject: "Quick chat?", trackedCompanies: ["Stripe", "American Express"], ...overrides });
    expect(filterEmail(input)).toEqual({ verdict: "unsure" });
  });

  test("a word that merely contains hr is not a hint", () => {
    const result = filterEmail(email({ senderName: "Chris Thrasher", senderEmail: "chris@example.com" }));
    expect(result).toEqual({ verdict: "excluded", reason: "no_signal" });
  });
});

test("isAtsDomain matches suffixes, not substrings", () => {
  expect(isAtsDomain("greenhouse.io")).toBe(true);
  expect(isAtsDomain("mail.greenhouse.io")).toBe(true);
  expect(isAtsDomain("notgreenhouse.io")).toBe(false);
  expect(isAtsDomain("greenhouse.io.evil.com")).toBe(false);
});
