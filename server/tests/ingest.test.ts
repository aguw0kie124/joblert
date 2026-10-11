import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import * as schema from "../src/db/schema.ts";
import { ClassifierError, type Classifier } from "../src/pipeline/classify.ts";
import { pollUser, runPoll, type IngestDeps } from "../src/pipeline/ingest.ts";
import { createUser, freshDb, type TestDb } from "./helpers/db.ts";
import { FakeGmail, fakeClassifier, mail, result } from "./helpers/inbox.ts";

const NOW = new Date("2026-10-10T12:00:00Z");
const day = (n: number) => new Date(Date.UTC(2026, 9, n, 9));

let db: TestDb;
let userId: string;
let gmail: FakeGmail;

beforeEach(async () => {
  db = await freshDb();
  userId = (await createUser(db, "sam")).id;
  gmail = new FakeGmail();
});

const deps = (classifier: Classifier, overrides: Partial<IngestDeps> = {}): IngestDeps => ({
  db,
  classifier,
  connect: async () => gmail,
  threshold: 0.85,
  backfillDays: 90,
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

describe("first sync", () => {
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

  test("searches back the configured number of days and saves the cursor", async () => {
    gmail.historyId = "4242";
    await pollUser(deps(fakeClassifier({}).classifier, { backfillDays: 30 }), userId, gmail);

    const thirtyDaysAgo = Math.floor((NOW.getTime() - 30 * 86_400_000) / 1000);
    expect(gmail.searches).toEqual([`after:${thirtyDaysAgo} -in:sent -in:chats -in:drafts`]);
    expect(await rows.cursor()).toMatchObject({ userId, historyId: "4242", lastRunAt: NOW });
  });

  test("mail with no job signal is neither classified nor stored", async () => {
    gmail.add(mail("m1", "Lunch on Friday?", day(1), { from: "Alex <alex@example.com>" }));
    const { classifier, classify } = fakeClassifier({});

    const stats = await pollUser(deps(classifier), userId, gmail);

    expect(stats).toMatchObject({ fetched: 1, relevant: 0 });
    expect(classify).not.toHaveBeenCalled();
    expect(await rows.emails()).toEqual([]);
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
    expect(gmail.searches).toHaveLength(1);
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

  test("falls back to a dated search when Gmail has forgotten the cursor", async () => {
    const { classifier, answers } = await confirmed();
    answers[REJECTION] = result("rejected");
    gmail.add(mail("m2", REJECTION, day(8)));
    gmail.history = "expired";
    gmail.historyId = "900";

    await pollUser(deps(classifier), userId, gmail);

    const dayBeforeLastRun = Math.floor((NOW.getTime() - 86_400_000) / 1000);
    expect(gmail.searches[1]).toContain(`after:${dayBeforeLastRun}`);
    expect(await rows.applications()).toMatchObject([{ status: "rejected" }]);
    expect((await rows.cursor())?.historyId).toBe("900");
  });
});

describe("emails with no application to attach to", () => {
  test("a rejection for an application the tracker never saw goes to review", async () => {
    gmail.add(mail("m1", REJECTION, day(8)));
    const { classifier } = fakeClassifier({ [REJECTION]: result("rejected") });

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
    const { classifier } = fakeClassifier({ [CONFIRMATION]: result("applied", { confidence: 0.6, source: "rules" }) });

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

describe("when the classifier is unavailable", () => {
  const down = new ClassifierError("unavailable", "rate limited");

  test("emails are held for the next run and the cursor still moves on", async () => {
    gmail.add(mail("m1", CONFIRMATION, day(1)), mail("m2", REJECTION, day(8)));
    gmail.historyId = "500";
    const { classifier, classify, answers } = fakeClassifier({ [CONFIRMATION]: down, [REJECTION]: down });

    const first = await pollUser(deps(classifier), userId, gmail);

    expect(first).toMatchObject({ relevant: 2, deferred: 2, created: 0 });
    // One failure is enough; the second email is not sent to a classifier that is already down.
    expect(classify).toHaveBeenCalledTimes(1);
    expect((await rows.emails()).map((e) => e.processedState)).toEqual(["pending", "pending"]);
    expect((await rows.cursor())?.historyId).toBe("500");

    answers[CONFIRMATION] = result("applied");
    answers[REJECTION] = result("rejected");
    gmail.history = [];
    const second = await pollUser(deps(classifier), userId, gmail);

    expect(second).toMatchObject({ relevant: 0, created: 1, updated: 1, deferred: 0 });
    expect(await rows.applications()).toMatchObject([{ status: "rejected" }]);
    expect((await rows.emails()).map((e) => e.processedState)).toEqual(["processed", "processed"]);
  });

  test("a held email that is still unclassifiable stays held, without a duplicate row", async () => {
    gmail.add(mail("m1", CONFIRMATION, day(1)));
    const { classifier } = fakeClassifier({ [CONFIRMATION]: down });

    await pollUser(deps(classifier), userId, gmail);
    gmail.history = [];
    const second = await pollUser(deps(classifier), userId, gmail);

    expect(second).toMatchObject({ deferred: 1, relevant: 0 });
    expect(await rows.emails()).toMatchObject([{ processedState: "pending" }]);
  });

  test("a held email since deleted from Gmail is dropped", async () => {
    gmail.add(mail("m1", CONFIRMATION, day(1)));
    const { classifier } = fakeClassifier({ [CONFIRMATION]: down });
    await pollUser(deps(classifier), userId, gmail);

    gmail.messages.clear();
    gmail.history = [];
    await pollUser(deps(classifier), userId, gmail);

    expect(await rows.emails()).toMatchObject([{ processedState: "ignored" }]);
  });

  test("an answer that can't be used marks the email failed and the run carries on", async () => {
    gmail.add(mail("m1", CONFIRMATION, day(1)), mail("m2", "Thanks for applying to Ramp", day(2)));
    const { classifier } = fakeClassifier({
      [CONFIRMATION]: new ClassifierError("invalid_output", "bad json"),
      "Thanks for applying to Ramp": result("applied", { company: "Ramp" }),
    });

    const stats = await pollUser(deps(classifier), userId, gmail);

    expect(stats).toMatchObject({ failed: 1, created: 1 });
    expect((await rows.emails()).map((e) => e.processedState)).toEqual(["failed", "processed"]);
  });
});

describe("runPoll", () => {
  const connect = async (db: TestDb, id: string) => {
    await db.insert(schema.oauthTokens).values({ userId: id, refreshTokenEncrypted: "ciphertext", scope: "gmail" });
  };

  test("syncs each connected user into their own data", async () => {
    const alex = (await createUser(db, "alex")).id;
    await connect(db, userId);
    await connect(db, alex);
    const inboxes: Record<string, FakeGmail> = {
      [userId]: new FakeGmail().add(mail("m1", CONFIRMATION, day(1)), mail("m2", REJECTION, day(8))),
      // Same Gmail message id and company as the other inbox, but no rejection.
      [alex]: new FakeGmail().add(mail("m1", CONFIRMATION, day(1))),
    };
    const { classifier } = fakeClassifier({ [CONFIRMATION]: result("applied"), [REJECTION]: result("rejected") });

    const results = await runPoll(deps(classifier, { connect: async (id) => inboxes[id]! }));

    expect(results.map((r) => r.status)).toEqual(["ok", "ok"]);
    const applications = await rows.applications();
    expect(applications.find((a) => a.userId === userId)?.status).toBe("rejected");
    expect(applications.find((a) => a.userId === alex)?.status).toBe("applied");
    expect(applications).toHaveLength(2);
  });

  test("users who never connected Gmail are skipped", async () => {
    const connector = vi.fn(async () => gmail);
    expect(await runPoll(deps(fakeClassifier({}).classifier, { connect: connector }))).toEqual([]);
    expect(connector).not.toHaveBeenCalled();
  });

  test("a user whose access was revoked is reported, not synced", async () => {
    await connect(db, userId);
    const results = await runPoll(deps(fakeClassifier({}).classifier, { connect: async () => null }));
    expect(results).toEqual([{ userId, status: "disconnected" }]);
  });

  test("a Gmail failure leaves that user's cursor alone and the next user still syncs", async () => {
    const alex = (await createUser(db, "alex")).id;
    await connect(db, userId);
    await connect(db, alex);
    const broken = new FakeGmail().add(mail("m1", CONFIRMATION, day(1)));
    broken.failOn = "m1";
    const inboxes: Record<string, FakeGmail> = {
      [userId]: broken,
      [alex]: new FakeGmail().add(mail("m1", CONFIRMATION, day(1))),
    };
    const { classifier } = fakeClassifier({ [CONFIRMATION]: result("applied") });

    const results = await runPoll(deps(classifier, { connect: async (id) => inboxes[id]! }));

    expect(results.find((r) => r.userId === userId)).toMatchObject({ status: "failed" });
    expect(results.find((r) => r.userId === alex)).toMatchObject({ status: "ok" });
    const cursors = await db.select().from(schema.syncState);
    expect(cursors.map((c) => c.userId)).toEqual([alex]);
    expect(await db.select().from(schema.applications).where(eq(schema.applications.userId, userId))).toEqual([]);
  });

  test("a rejected classifier API key stops the whole poll", async () => {
    await connect(db, userId);
    gmail.add(mail("m1", CONFIRMATION, day(1)));
    const { classifier } = fakeClassifier({ [CONFIRMATION]: new ClassifierError("auth", "bad key") });

    await expect(runPoll(deps(classifier))).rejects.toMatchObject({ code: "auth" });
    expect(await rows.cursor()).toBeUndefined();
  });
});
