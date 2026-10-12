import { beforeEach, describe, expect, test, vi } from "vitest";
import * as schema from "../src/db/schema.ts";
import { ClassifierError, type Classifier } from "../src/pipeline/classify.ts";
import { pollUser, type IngestDeps } from "../src/pipeline/ingest.ts";
import { createUser, freshDb, seedCursor, type TestDb } from "./helpers/db.ts";
import { FakeGmail, fakeClassifier, fakeTriager, mail, result } from "./helpers/inbox.ts";

const NOW = new Date("2026-10-10T12:00:00Z");
const day = (n: number) => new Date(Date.UTC(2026, 9, n, 9));

let db: TestDb;
let userId: string;
let gmail: FakeGmail;

beforeEach(async () => {
  db = await freshDb();
  userId = (await createUser(db, "sam")).id;
  await seedCursor(db, userId);
  gmail = new FakeGmail();
});

const deps = (classifier: Classifier, overrides: Partial<IngestDeps> = {}): IngestDeps => ({
  db,
  classifier,
  triager: fakeTriager([]).triager,
  connect: async () => gmail,
  threshold: 0.85,
  now: () => NOW,
  ...overrides,
});

const rows = {
  applications: () => db.select().from(schema.applications).orderBy(schema.applications.company),
  emails: () => db.select().from(schema.emails).orderBy(schema.emails.receivedAt),
  events: () => db.select().from(schema.events).orderBy(schema.events.occurredAt),
  reviews: () => db.select().from(schema.reviewItems),
  cursor: async () => (await db.select().from(schema.syncState))[0],
};

const CONFIRMATION = "Thank you for applying to Stripe";
const REJECTION = "Update on your Stripe application";

describe("a newly connected inbox", () => {
  test("starts from now: mail already in it is not read", async () => {
    await db.delete(schema.syncState);
    gmail.add(mail("m1", CONFIRMATION, day(1)));
    gmail.historyId = "4242";
    const { classifier, classify } = fakeClassifier({});

    const stats = await pollUser(deps(classifier), userId, gmail);

    expect(stats).toMatchObject({ fetched: 0, relevant: 0 });
    expect(classify).not.toHaveBeenCalled();
    expect(await rows.emails()).toEqual([]);
    expect(await rows.cursor()).toMatchObject({ userId, historyId: "4242", lastRunAt: NOW });
  });
});

describe("a sync", () => {
  test("a confirmation creates an application with its first event", async () => {
    gmail.add(mail("m1", CONFIRMATION, day(1)));
    const { classifier } = fakeClassifier({ [CONFIRMATION]: result("applied") });

    const stats = await pollUser(deps(classifier), userId, gmail);

    expect(stats).toMatchObject({ fetched: 1, relevant: 1, created: 1 });
    const [application] = await rows.applications();
    expect(application).toMatchObject({
      userId,
      company: "Stripe",
      role: "Backend Engineer",
      status: "applied",
      source: "email",
      ats: "greenhouse",
      appliedAt: day(1),
    });
    const [email] = await rows.emails();
    expect(email).toMatchObject({
      gmailMessageId: "m1",
      sender: "Recruiting <no-reply@greenhouse.io>",
      processedState: "processed",
      applicationId: application!.id,
      extracted: { kind: "applied", company: "Stripe", confidence: 0.95 },
    });
    expect(await rows.events()).toMatchObject([
      { applicationId: application!.id, kind: "applied", fromStatus: null, toStatus: "applied", emailId: email!.id },
    ]);
  });

  test("saves the cursor Gmail hands back", async () => {
    gmail.historyId = "4242";
    await pollUser(deps(fakeClassifier({}).classifier), userId, gmail);
    expect(await rows.cursor()).toMatchObject({ userId, historyId: "4242", lastRunAt: NOW });
  });

  test("mail with no hint of a job is dropped without asking a model, and counted", async () => {
    gmail.add(mail("m1", "Lunch on Friday?", day(1), { from: "Alex <alex@example.com>" }));
    const { classifier, classify } = fakeClassifier({});
    const { triager, triage } = fakeTriager([]);

    const stats = await pollUser(deps(classifier, { triager }), userId, gmail);

    expect(stats).toMatchObject({ fetched: 1, relevant: 0, unrelated: 1 });
    expect(triage).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
    expect(await rows.emails()).toEqual([]);
  });

  test("mail from a tracked company goes to the triage even with no hint of a job", async () => {
    gmail.add(mail("m1", CONFIRMATION, day(1)));
    const { classifier } = fakeClassifier({ [CONFIRMATION]: result("applied") });
    const { triager, triage } = fakeTriager([]);
    await pollUser(deps(classifier, { triager }), userId, gmail);

    gmail.add(mail("m2", "Quick chat?", day(3), { from: "Jane <jane@stripe.com>" }));
    gmail.history = ["m2"];
    const stats = await pollUser(deps(classifier, { triager }), userId, gmail);

    expect(triage).toHaveBeenCalledTimes(1);
    expect(stats).toMatchObject({ fetched: 1, relevant: 0, unrelated: 0 });
  });

  test("the user's own sent mail is skipped", async () => {
    gmail.add(mail("m1", CONFIRMATION, day(1), { labelIds: ["SENT"] }));
    const { classifier, classify } = fakeClassifier({});

    const stats = await pollUser(deps(classifier), userId, gmail);

    expect(stats.fetched).toBe(0);
    expect(classify).not.toHaveBeenCalled();
  });

  test("older mail is processed first, so a rejection finds its application", async () => {
    gmail.add(mail("m2", REJECTION, day(8)), mail("m1", CONFIRMATION, day(1)));
    const { classifier } = fakeClassifier({ [CONFIRMATION]: result("applied"), [REJECTION]: result("rejected") });

    const stats = await pollUser(deps(classifier), userId, gmail);

    expect(stats).toMatchObject({ created: 1, updated: 1 });
    expect(await rows.applications()).toMatchObject([{ status: "rejected", statusUpdatedAt: day(8) }]);
    expect(await rows.events()).toMatchObject([
      { kind: "applied", toStatus: "applied" },
      { kind: "rejected", fromStatus: "applied", toStatus: "rejected", summary: "Summary for rejected" },
    ]);
  });

  test("mail the classifier calls unrelated is stored as ignored, so it is never classified twice", async () => {
    gmail.add(mail("m1", "Reset your candidate portal password", day(1)));
    const { classifier, classify } = fakeClassifier({
      "Reset your candidate portal password": result("other", { jobRelated: false, company: null, role: null }),
    });

    await pollUser(deps(classifier), userId, gmail);
    gmail.history = ["m1"];
    await pollUser(deps(classifier), userId, gmail);

    expect(classify).toHaveBeenCalledTimes(1);
    expect(await rows.emails()).toMatchObject([{ processedState: "ignored", applicationId: null }]);
    expect(await rows.applications()).toEqual([]);
  });
});

describe("later syncs", () => {
  const confirmed = async () => {
    gmail.add(mail("m1", CONFIRMATION, day(1), { thread: "t-stripe" }));
    const fake = fakeClassifier({ [CONFIRMATION]: result("applied") });
    await pollUser(deps(fake.classifier), userId, gmail);
    return fake;
  };

  test("read only what Gmail's history reports as new", async () => {
    const { classifier, answers } = await confirmed();
    answers[REJECTION] = result("rejected");
    gmail.add(mail("m2", REJECTION, day(8)));
    gmail.history = ["m2"];
    gmail.historyId = "200";

    const stats = await pollUser(deps(classifier), userId, gmail);

    expect(stats).toMatchObject({ fetched: 1, updated: 1, created: 0 });
    expect(await rows.applications()).toMatchObject([{ status: "rejected" }]);
    expect((await rows.cursor())?.historyId).toBe("200");
  });

  test("seeing the same message again changes nothing", async () => {
    const { classifier, classify } = await confirmed();
    gmail.history = ["m1"];

    const stats = await pollUser(deps(classifier), userId, gmail);

    expect(stats).toMatchObject({ fetched: 0, relevant: 0, created: 0 });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(await rows.applications()).toHaveLength(1);
    expect(await rows.events()).toHaveLength(1);
  });

  test("a reply in a known thread is matched even when it names no company", async () => {
    const { classifier, answers } = await confirmed();
    answers["Re: next steps"] = result("interview", { company: null, role: null });
    gmail.add(mail("m2", "Re: next steps", day(5), { thread: "t-stripe", from: "Dana <dana@gmail.com>" }));
    gmail.history = ["m2"];

    await pollUser(deps(classifier), userId, gmail);

    expect(await rows.applications()).toMatchObject([{ status: "interview" }]);
  });

  test("a second confirmation is kept on the timeline without a duplicate application", async () => {
    const { classifier, answers } = await confirmed();
    answers["We received your application"] = result("applied");
    gmail.add(mail("m2", "We received your application", day(2)));
    gmail.history = ["m2"];

    const stats = await pollUser(deps(classifier), userId, gmail);

    expect(stats).toMatchObject({ recorded: 1, created: 0 });
    expect(await rows.applications()).toHaveLength(1);
    expect((await rows.events())[1]).toMatchObject({ kind: "applied", toStatus: null });
  });

  test("a confirmation for a different role at the same company creates a second application", async () => {
    const { classifier, answers } = await confirmed();
    answers["Thanks for applying"] = result("applied", { role: "Product Designer" });
    gmail.add(mail("m2", "Thanks for applying", day(2)));
    gmail.history = ["m2"];

    await pollUser(deps(classifier), userId, gmail);

    expect((await rows.applications()).map((a) => a.role).sort()).toEqual(["Backend Engineer", "Product Designer"]);
  });

  test("similar roles at one company stay separate, and a job id sends later mail to the right one", async () => {
    const confirmations = {
      "IBM: Software Engineer": result("applied", { company: "IBM", role: "Software Engineer", jobId: "R-100" }),
      "IBM: Software Engineer Intern": result("applied", { company: "IBM", role: "Software Engineer Intern", jobId: "R-200" }),
      "IBM: Software Engineer Intern (Austin)": result("applied", {
        company: "IBM",
        role: "Software Engineer Intern",
        location: "Austin, TX",
        jobId: "R-300",
      }),
    };
    Object.keys(confirmations).forEach((subject, index) => gmail.add(mail(`m${index}`, subject, day(index + 1))));
    gmail.add(mail("m9", "IBM: update", day(8)));
    const { classifier } = fakeClassifier({
      ...confirmations,
      "IBM: update": result("rejected", { company: "IBM", role: "Software Engineer", jobId: "R-200" }),
    });

    const stats = await pollUser(deps(classifier), userId, gmail);

    expect(stats).toMatchObject({ created: 3, updated: 1, review: 0 });
    const applications = await db.select().from(schema.applications).orderBy(schema.applications.appliedAt);
    expect(applications.map((a) => [a.role, a.location, a.jobId, a.status])).toEqual([
      ["Software Engineer", null, "R-100", "applied"],
      ["Software Engineer Intern", null, "R-200", "rejected"],
      ["Software Engineer Intern", "Austin, TX", "R-300", "applied"],
    ]);
  });

  test("a low-confidence result goes to review and leaves the status alone", async () => {
    const { classifier, answers } = await confirmed();
    answers[REJECTION] = result("rejected", { confidence: 0.6 });
    gmail.add(mail("m2", REJECTION, day(8)));
    gmail.history = ["m2"];

    const stats = await pollUser(deps(classifier), userId, gmail);

    const [application] = await rows.applications();
    expect(stats).toMatchObject({ review: 1, updated: 0 });
    expect(application!.status).toBe("applied");
    expect(await rows.reviews()).toMatchObject([
      { userId, reason: "low_confidence", proposedStatus: "rejected", candidateApplicationIds: [application!.id] },
    ]);
    expect((await rows.emails())[1]).toMatchObject({ processedState: "needs_review", applicationId: null });
    expect(await rows.events()).toHaveLength(1);
  });

  test("news after a rejection goes to review as a conflict", async () => {
    const { classifier, answers } = await confirmed();
    answers[REJECTION] = result("rejected");
    answers["Your offer from Stripe"] = result("offer");
    gmail.add(mail("m2", REJECTION, day(8)), mail("m3", "Your offer from Stripe", day(9)));
    gmail.history = ["m2", "m3"];

    await pollUser(deps(classifier), userId, gmail);

    expect(await rows.applications()).toMatchObject([{ status: "rejected" }]);
    expect(await rows.reviews()).toMatchObject([{ reason: "status_conflict", proposedStatus: "offer" }]);
  });

  test("two applications that fit equally well go to review with both as candidates", async () => {
    const { classifier, answers } = await confirmed();
    answers["Thanks for applying"] = result("applied", { role: "Product Designer" });
    answers[REJECTION] = result("rejected", { role: null });
    gmail.add(mail("m2", "Thanks for applying", day(2)), mail("m3", REJECTION, day(8)));
    gmail.history = ["m2", "m3"];

    await pollUser(deps(classifier), userId, gmail);

    const [review] = await rows.reviews();
    expect(review).toMatchObject({ reason: "ambiguous_match", proposedStatus: "rejected" });
    expect([...review!.candidateApplicationIds].sort()).toEqual((await rows.applications()).map((a) => a.id).sort());
    expect((await rows.applications()).map((a) => a.status)).toEqual(["applied", "applied"]);
  });

  test("starts again from now when Gmail has forgotten the cursor", async () => {
    const { classifier, classify } = await confirmed();
    gmail.add(mail("m2", REJECTION, day(8)));
    gmail.history = "expired";
    gmail.historyId = "900";
    const log = vi.fn();

    const stats = await pollUser(deps(classifier, { log }), userId, gmail);

    // What arrived while the cursor was stale is not read.
    expect(stats.fetched).toBe(0);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(await rows.applications()).toMatchObject([{ status: "applied" }]);
    expect((await rows.cursor())?.historyId).toBe("900");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("expired"), { userId });
  });
});

describe("emails with no application to attach to", () => {
  test("a rejection for an application the tracker never saw logs it as rejected", async () => {
    gmail.add(mail("m1", REJECTION, day(8)));
    const { classifier } = fakeClassifier({ [REJECTION]: result("rejected") });

    const stats = await pollUser(deps(classifier), userId, gmail);

    expect(stats).toMatchObject({ created: 1, review: 0 });
    const [application] = await rows.applications();
    expect(application).toMatchObject({ company: "Stripe", status: "rejected", appliedAt: day(8) });
    expect(await rows.events()).toMatchObject([
      { applicationId: application!.id, kind: "rejected", fromStatus: null, toStatus: "rejected" },
    ]);
    expect(await rows.reviews()).toEqual([]);
  });

  test("a later-stage email that names no company goes to review", async () => {
    gmail.add(mail("m1", REJECTION, day(8)));
    const { classifier } = fakeClassifier({ [REJECTION]: result("rejected", { company: null }) });

    await pollUser(deps(classifier), userId, gmail);

    expect(await rows.applications()).toEqual([]);
    expect(await rows.reviews()).toMatchObject([
      { reason: "no_match", proposedStatus: "rejected", candidateApplicationIds: [] },
    ]);
  });

  test("a confirmation that names no company goes to review", async () => {
    gmail.add(mail("m1", CONFIRMATION, day(1)));
    const { classifier } = fakeClassifier({ [CONFIRMATION]: result("applied", { company: null }) });

    await pollUser(deps(classifier), userId, gmail);

    expect(await rows.applications()).toEqual([]);
    expect(await rows.reviews()).toMatchObject([{ reason: "no_match", proposedStatus: "applied" }]);
  });

  test("an unsure confirmation does not create an application", async () => {
    gmail.add(mail("m1", CONFIRMATION, day(1)));
    const { classifier } = fakeClassifier({ [CONFIRMATION]: result("applied", { confidence: 0.6 }) });

    await pollUser(deps(classifier), userId, gmail);

    expect(await rows.applications()).toEqual([]);
    expect(await rows.reviews()).toMatchObject([{ reason: "low_confidence" }]);
  });

  test("a confirmation with no role still creates an application that later mail can match", async () => {
    gmail.add(mail("m1", CONFIRMATION, day(1)), mail("m2", REJECTION, day(8)));
    const { classifier } = fakeClassifier({
      [CONFIRMATION]: result("applied", { role: null }),
      [REJECTION]: result("rejected", { role: "Backend Engineer" }),
    });

    await pollUser(deps(classifier), userId, gmail);

    expect(await rows.applications()).toMatchObject([{ role: "", status: "rejected" }]);
  });
});

describe("mail no rule settles", () => {
  // A recruiting address hints at a job; the subjects below settle nothing.
  const from = { from: "Dana Lee <dana@recruiting.stripe.com>" };
  const CHAT = "Following up on our conversation";
  const CARD = "Your statement is ready";
  const LUNCH = "Lunch on Friday?";

  test("is triaged in one request, and only what the triage keeps is classified and stored", async () => {
    gmail.add(mail("m1", CHAT, day(2), from), mail("m2", CARD, day(3), from), mail("m3", LUNCH, day(4), from));
    const { classifier, classify } = fakeClassifier({ [CHAT]: result("interview") });
    const { triager, triage } = fakeTriager([CHAT]);

    const stats = await pollUser(deps(classifier, { triager }), userId, gmail);

    expect(triage).toHaveBeenCalledTimes(1);
    expect(triage.mock.calls[0]![0]).toEqual([
      { senderName: "Dana Lee", senderEmail: "dana@recruiting.stripe.com", subject: CHAT, snippet: `Body of: ${CHAT}` },
      { senderName: "Dana Lee", senderEmail: "dana@recruiting.stripe.com", subject: CARD, snippet: `Body of: ${CARD}` },
      { senderName: "Dana Lee", senderEmail: "dana@recruiting.stripe.com", subject: LUNCH, snippet: `Body of: ${LUNCH}` },
    ]);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(stats).toMatchObject({ fetched: 3, relevant: 1, created: 1 });
    expect((await rows.emails()).map((e) => e.subject)).toEqual([CHAT]);
  });

  test("mail a rule already settles is not sent to the triage", async () => {
    gmail.add(mail("m1", CONFIRMATION, day(1)), mail("m2", "30 new jobs for you", day(2), from));
    const { classifier } = fakeClassifier({ [CONFIRMATION]: result("applied") });
    const { triager, triage } = fakeTriager([]);

    await pollUser(deps(classifier, { triager }), userId, gmail);

    expect(triage).not.toHaveBeenCalled();
  });

  test("the triage is told which companies are tracked", async () => {
    gmail.add(mail("m1", CONFIRMATION, day(1)));
    const { classifier } = fakeClassifier({ [CONFIRMATION]: result("applied") });
    const { triager, triage } = fakeTriager([]);
    await pollUser(deps(classifier, { triager }), userId, gmail);

    gmail.add(mail("m2", CARD, day(3), from));
    gmail.history = ["m2"];
    await pollUser(deps(classifier, { triager }), userId, gmail);

    expect(triage.mock.calls[0]![1]).toEqual(["Stripe"]);
  });

  test("triaged mail keeps its place in time among mail the filter passed", async () => {
    gmail.add(mail("m2", CHAT, day(8), from), mail("m1", CONFIRMATION, day(1)));
    const { classifier } = fakeClassifier({ [CONFIRMATION]: result("applied"), [CHAT]: result("rejected") });

    const stats = await pollUser(deps(classifier, { triager: fakeTriager([CHAT]).triager }), userId, gmail);

    expect(stats).toMatchObject({ created: 1, updated: 1 });
    expect(await rows.applications()).toMatchObject([{ status: "rejected" }]);
  });

  test("a rate-limited triage ends the run with nothing stored, and the next run does the work", async () => {
    gmail.add(mail("m1", CHAT, day(2), from), mail("m2", CARD, day(3), from), mail("m3", CONFIRMATION, day(4)));
    const { classifier, classify } = fakeClassifier({ [CHAT]: result("interview"), [CONFIRMATION]: result("applied") });
    const down = fakeTriager(new ClassifierError("unavailable", "rate limited"));

    await expect(pollUser(deps(classifier, { triager: down.triager }), userId, gmail)).rejects.toMatchObject({
      code: "unavailable",
    });

    // The classifier shares the model's quota, so it is not called either.
    expect(classify).not.toHaveBeenCalled();
    expect(await rows.emails()).toEqual([]);
    expect((await rows.cursor())?.historyId).toBe("1");

    const second = await pollUser(deps(classifier, { triager: fakeTriager([CHAT]).triager }), userId, gmail);

    // The confirmation is for the application the earlier message already logged.
    expect(second).toMatchObject({ fetched: 3, relevant: 2, created: 1, recorded: 1 });
    expect((await rows.emails()).map((e) => e.subject)).toEqual([CHAT, CONFIRMATION]);
    expect((await rows.cursor())?.historyId).toBe("100");
  });

  test("goes to the classifier when the triage answer can't be used", async () => {
    gmail.add(mail("m1", CHAT, day(2), from));
    const { classifier, classify } = fakeClassifier({ [CHAT]: result("other", { jobRelated: false }) });
    const broken = fakeTriager(new ClassifierError("invalid_output", "bad json"));

    await pollUser(deps(classifier, { triager: broken.triager }), userId, gmail);

    expect(classify).toHaveBeenCalledTimes(1);
    expect(await rows.emails()).toMatchObject([{ processedState: "ignored" }]);
  });

  test("a rejected API key at the triage ends the run", async () => {
    gmail.add(mail("m1", CHAT, day(2), from));
    const { triager } = fakeTriager(new ClassifierError("auth", "bad key"));

    await expect(pollUser(deps(fakeClassifier({}).classifier, { triager }), userId, gmail)).rejects.toMatchObject({
      code: "auth",
    });
    expect((await rows.cursor())?.historyId).toBe("1");
  });
});

describe("company names", () => {
  test("the classifier is given the tracked companies, newest application first", async () => {
    gmail.add(mail("m1", CONFIRMATION, day(1)), mail("m2", "Thanks for applying to Ramp", day(2)));
    const { classifier, classify } = fakeClassifier({
      [CONFIRMATION]: result("applied"),
      "Thanks for applying to Ramp": result("applied", { company: "Ramp" }),
      [REJECTION]: result("rejected"),
    });
    await pollUser(deps(classifier), userId, gmail);

    gmail.add(mail("m3", REJECTION, day(8)));
    gmail.history = ["m3"];
    await pollUser(deps(classifier), userId, gmail);

    expect(classify.mock.calls.map(([, context]) => context?.knownCompanies)).toEqual([[], ["Stripe"], ["Ramp", "Stripe"]]);
  });

  test("mail the classifier resolves to a tracked company updates it instead of adding a duplicate", async () => {
    const PG = "Thank you for applying to Procter & Gamble";
    const UPDATE = "An update from P&G";
    gmail.add(mail("m1", PG, day(1)), mail("m2", UPDATE, day(8)));
    const { classifier } = fakeClassifier({
      [PG]: result("applied", { company: "Procter & Gamble", role: "Brand Manager" }),
      [UPDATE]: result("rejected", { company: "Procter & Gamble", companyAsWritten: "P&G", role: null }),
    });

    const stats = await pollUser(deps(classifier), userId, gmail);

    expect(stats).toMatchObject({ created: 1, updated: 1 });
    expect(await rows.applications()).toMatchObject([{ company: "Procter & Gamble", status: "rejected" }]);
    expect((await rows.emails())[1]).toMatchObject({
      extracted: { company: "Procter & Gamble", companyAsWritten: "P&G" },
    });
  });
});

describe("when the classifier can't answer", () => {
  const down = new ClassifierError("unavailable", "rate limited");

  test("a rate limit ends the run without moving the cursor, and the next run finishes the work", async () => {
    gmail.add(mail("m1", CONFIRMATION, day(1)), mail("m2", REJECTION, day(8)));
    gmail.historyId = "500";
    const { classifier, classify, answers } = fakeClassifier({ [CONFIRMATION]: result("applied"), [REJECTION]: down });

    await expect(pollUser(deps(classifier), userId, gmail)).rejects.toMatchObject({ code: "unavailable" });

    // What was classified before the limit is kept; the rest is not stored at all.
    expect(await rows.applications()).toMatchObject([{ status: "applied" }]);
    expect((await rows.emails()).map((e) => e.processedState)).toEqual(["processed"]);
    expect((await rows.cursor())?.historyId).toBe("1");

    answers[REJECTION] = result("rejected");
    const second = await pollUser(deps(classifier), userId, gmail);

    // The confirmation is already stored, so it is neither fetched nor classified again.
    expect(second).toMatchObject({ fetched: 1, relevant: 1, created: 0, updated: 1 });
    expect(classify).toHaveBeenCalledTimes(3);
    expect(await rows.applications()).toMatchObject([{ status: "rejected" }]);
    expect(await rows.events()).toHaveLength(2);
    expect((await rows.cursor())?.historyId).toBe("500");
  });

  test("an answer that can't be used sends the email to review and the run carries on", async () => {
    gmail.add(mail("m1", CONFIRMATION, day(1)), mail("m2", "Thanks for applying to Ramp", day(2)));
    const { classifier } = fakeClassifier({
      [CONFIRMATION]: new ClassifierError("invalid_output", "bad json"),
      "Thanks for applying to Ramp": result("applied", { company: "Ramp" }),
    });

    const stats = await pollUser(deps(classifier), userId, gmail);

    expect(stats).toMatchObject({ review: 1, created: 1 });
    expect((await rows.emails()).map((e) => e.processedState)).toEqual(["needs_review", "processed"]);
    expect(await rows.reviews()).toMatchObject([
      { reason: "unreadable", proposedStatus: null, candidateApplicationIds: [] },
    ]);
  });
});

describe("more than one user", () => {
  test("each inbox is synced into its owner's data, even with the same message ids", async () => {
    const alex = (await createUser(db, "alex")).id;
    await seedCursor(db, alex);
    gmail.add(mail("m1", CONFIRMATION, day(1)), mail("m2", REJECTION, day(8)));
    // Same Gmail message id and company as the other inbox, but no rejection.
    const theirs = new FakeGmail().add(mail("m1", CONFIRMATION, day(1)));
    const { classifier } = fakeClassifier({ [CONFIRMATION]: result("applied"), [REJECTION]: result("rejected") });

    await pollUser(deps(classifier), userId, gmail);
    await pollUser(deps(classifier), alex, theirs);

    const applications = await rows.applications();
    expect(applications).toHaveLength(2);
    expect(applications.find((a) => a.userId === userId)?.status).toBe("rejected");
    expect(applications.find((a) => a.userId === alex)?.status).toBe("applied");
    expect((await rows.emails()).filter((e) => e.userId === alex).map((e) => e.gmailMessageId)).toEqual(["m1"]);
  });
});

describe("when a run can't finish", () => {
  test("a Gmail failure leaves the cursor alone", async () => {
    gmail.add(mail("m1", CONFIRMATION, day(1)));
    gmail.failOn = "m1";
    const { classifier } = fakeClassifier({ [CONFIRMATION]: result("applied") });

    await expect(pollUser(deps(classifier), userId, gmail)).rejects.toMatchObject({ code: "failed" });

    expect((await rows.cursor())?.historyId).toBe("1");
    expect(await rows.applications()).toEqual([]);
  });

  test("a rejected classifier API key leaves the cursor alone", async () => {
    gmail.add(mail("m1", CONFIRMATION, day(1)));
    const { classifier } = fakeClassifier({ [CONFIRMATION]: new ClassifierError("auth", "bad key") });

    await expect(pollUser(deps(classifier), userId, gmail)).rejects.toMatchObject({ code: "auth" });
    expect((await rows.cursor())?.historyId).toBe("1");
  });
});
