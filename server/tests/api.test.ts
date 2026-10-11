import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { GoogleAuthError } from "../src/auth/google.ts";
import * as schema from "../src/db/schema.ts";
import type { ReviewReason, Status } from "../src/status.ts";
import { completeSignIn, fakeOAuth, googleSignIn, testApp, type FakeOAuth } from "./helpers/app.ts";
import { freshDb, type TestDb } from "./helpers/db.ts";
import { FakeGmail, fakeClassifier, mail, result } from "./helpers/inbox.ts";

const MISSING = "00000000-0000-4000-8000-000000000000";
const day = (n: number) => new Date(Date.UTC(2026, 9, n, 9));

let db: TestDb;
let oauth: FakeOAuth;
let app: FastifyInstance;
/** Sam is the user under test; Alex exists to prove one user can't reach another's data. */
let sam: { id: string; cookie: string };
let alex: { id: string; cookie: string };

async function signIn(name: string) {
  oauth.exchangeCode.mockResolvedValueOnce(
    googleSignIn({ sub: `google-${name}`, email: `${name}@example.com`, refreshToken: `refresh-${name}` }),
  );
  const { cookie } = await completeSignIn(app);
  const [user] = await db.select().from(schema.users).where(eq(schema.users.googleSub, `google-${name}`));
  return { id: user!.id, cookie };
}

beforeEach(async () => {
  db = await freshDb();
  oauth = fakeOAuth();
  app = await testApp(db, oauth);
  sam = await signIn("sam");
  alex = await signIn("alex");
});

type Method = "GET" | "POST" | "PATCH" | "DELETE";
const call = (who: { cookie: string } | null, method: Method, url: string, payload?: object) =>
  app.inject({ method, url, headers: who ? { cookie: who.cookie } : {}, ...(payload ? { payload } : {}) });

async function addApplication(userId: string, values: Partial<typeof schema.applications.$inferInsert> = {}) {
  const [row] = await db
    .insert(schema.applications)
    .values({ userId, company: "Stripe", role: "Backend Engineer", appliedAt: day(1), source: "email", ...values })
    .returning();
  return row!;
}

async function addEmail(userId: string, id: string, extracted: object | null = result("rejected")) {
  const [row] = await db
    .insert(schema.emails)
    .values({
      userId,
      gmailMessageId: id,
      threadId: `thread-${id}`,
      sender: "Stripe Recruiting <no-reply@greenhouse.io>",
      subject: "Update on your application",
      receivedAt: day(8),
      extracted,
      processedState: "needs_review",
    })
    .returning();
  return row!;
}

async function addReview(
  userId: string,
  options: { reason?: ReviewReason; candidates?: string[]; proposed?: Status | null; extracted?: object } = {},
) {
  const email = await addEmail(userId, `msg-${Math.random()}`, options.extracted ?? result("rejected"));
  const [item] = await db
    .insert(schema.reviewItems)
    .values({
      userId,
      emailId: email.id,
      reason: options.reason ?? "low_confidence",
      candidateApplicationIds: options.candidates ?? [],
      proposedStatus: options.proposed === undefined ? "rejected" : options.proposed,
    })
    .returning();
  return { item: item!, email };
}

const application = async (id: string) =>
  (await db.select().from(schema.applications).where(eq(schema.applications.id, id)))[0];
const eventsFor = (applicationId: string) =>
  db
    .select()
    .from(schema.events)
    .where(eq(schema.events.applicationId, applicationId))
    .orderBy(schema.events.createdAt);

describe("every data route needs a session", () => {
  test.each<[Method, string]>([
    ["GET", "/api/applications"],
    ["POST", "/api/applications"],
    ["GET", `/api/applications/${MISSING}`],
    ["PATCH", `/api/applications/${MISSING}`],
    ["DELETE", `/api/applications/${MISSING}`],
    ["GET", "/api/review"],
    ["POST", `/api/review/${MISSING}/resolve`],
    ["POST", `/api/events/${MISSING}/revert`],
    ["POST", "/api/sync"],
    ["DELETE", "/api/me"],
  ])("%s %s", async (method, url) => {
    const response = await call(null, method, url);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "not_signed_in" });
  });
});

describe("applications", () => {
  test("adding one by hand records its first event", async () => {
    const response = await call(sam, "POST", "/api/applications", {
      company: "  Figma ",
      role: "Product Engineer",
      jobUrl: "https://figma.com/careers/1",
      status: "interview",
    });

    expect(response.statusCode).toBe(201);
    const created = response.json().application;
    expect(created).toMatchObject({ company: "Figma", role: "Product Engineer", status: "interview", source: "manual" });
    expect(created).not.toHaveProperty("userId");
    expect((await application(created.id))!.userId).toBe(sam.id);
    expect(await eventsFor(created.id)).toMatchObject([
      { kind: "interview", source: "manual", fromStatus: null, toStatus: "interview" },
    ]);
  });

  test.each([
    ["no company", { role: "Engineer" }],
    ["a blank company", { company: "   " }],
    ["an unknown status", { company: "Figma", status: "ghosted" }],
    ["a field that doesn't exist", { company: "Figma", userId: MISSING }],
    ["a link that isn't http", { company: "Figma", jobUrl: "javascript:alert(1)" }],
    ["a date that isn't one", { company: "Figma", appliedAt: "soon" }],
  ])("adding one with %s is refused", async (_name, payload) => {
    const response = await call(sam, "POST", "/api/applications", payload);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_request");
    expect(await db.select().from(schema.applications)).toEqual([]);
  });

  test("the list is the user's own, most recently changed first, with counts for every status", async () => {
    await addApplication(sam.id, { company: "Stripe", statusUpdatedAt: day(2) });
    await addApplication(sam.id, { company: "Ramp", status: "rejected", statusUpdatedAt: day(5) });
    await addApplication(sam.id, { company: "Figma", status: "rejected", statusUpdatedAt: day(3) });
    await addApplication(alex.id, { company: "Alex Only" });

    const body = (await call(sam, "GET", "/api/applications")).json();

    expect(body.applications.map((a: { company: string }) => a.company)).toEqual(["Ramp", "Figma", "Stripe"]);
    expect(body.counts).toEqual({ applied: 1, oa: 0, interview: 0, offer: 0, rejected: 2 });
  });

  test("filtering by status and search narrows the list but not the counts", async () => {
    await addApplication(sam.id, { company: "Stripe", role: "Backend Engineer" });
    await addApplication(sam.id, { company: "Ramp", role: "Data Engineer", status: "oa" });
    await addApplication(sam.id, { company: "Figma", role: "Designer", status: "oa" });
    const companies = async (query: string) =>
      (await call(sam, "GET", `/api/applications?${query}`)).json().applications.map((a: { company: string }) => a.company);

    expect((await companies("status=oa")).sort()).toEqual(["Figma", "Ramp"]);
    expect((await companies("q=ENGINEER")).sort()).toEqual(["Ramp", "Stripe"]);
    expect(await companies("q=stri")).toEqual(["Stripe"]);
    expect(await companies("status=oa&q=engineer")).toEqual(["Ramp"]);
    // "%" and "_" are searched for literally rather than matching everything.
    expect(await companies("q=%25")).toEqual([]);
    expect(await companies("q=_")).toEqual([]);
    expect((await call(sam, "GET", "/api/applications?status=oa")).json().counts).toMatchObject({ applied: 1, oa: 2 });
    expect((await call(sam, "GET", "/api/applications?status=nope")).statusCode).toBe(400);
  });

  test("the list shows each application's next deadline and interview, ignoring past and undone ones", async () => {
    vi.useFakeTimers({ now: day(10), toFake: ["Date"] });
    try {
      const stripe = await addApplication(sam.id);
      const event = { userId: sam.id, applicationId: stripe.id, kind: "oa" as const, source: "email" as const };
      await db.insert(schema.events).values([
        { ...event, occurredAt: day(2), deadline: day(5) },
        { ...event, occurredAt: day(6), deadline: day(20), interviewAt: day(25) },
        { ...event, occurredAt: day(7), deadline: day(15) },
        { ...event, occurredAt: day(8), deadline: day(12), revertedAt: day(9) },
      ]);

      const [listed] = (await call(sam, "GET", "/api/applications")).json().applications;
      expect(listed).toMatchObject({ nextDeadline: day(15).toISOString(), nextInterviewAt: day(25).toISOString() });
    } finally {
      vi.useRealTimers();
    }
  });

  test("one application comes with its timeline and the emails behind it", async () => {
    const stripe = await addApplication(sam.id, { status: "rejected" });
    const email = await addEmail(sam.id, "msg-1");
    await db.insert(schema.events).values([
      { userId: sam.id, applicationId: stripe.id, kind: "applied", source: "email", toStatus: "applied", occurredAt: day(1) },
      {
        userId: sam.id,
        applicationId: stripe.id,
        kind: "rejected",
        source: "email",
        fromStatus: "applied",
        toStatus: "rejected",
        emailId: email.id,
        evidenceQuote: "not moving forward",
        summary: "Stripe rejected the application.",
        occurredAt: day(8),
      },
    ]);

    const body = (await call(sam, "GET", `/api/applications/${stripe.id}`)).json();

    expect(body.application).toMatchObject({ id: stripe.id, company: "Stripe", status: "rejected" });
    expect(body.events).toMatchObject([
      {
        kind: "rejected",
        fromStatus: "applied",
        toStatus: "rejected",
        evidenceQuote: "not moving forward",
        email: { subject: "Update on your application", gmailMessageId: "msg-1", threadId: "thread-msg-1" },
      },
      { kind: "applied", email: null },
    ]);
  });

  test("editing changes only the fields sent, and an empty value clears a field", async () => {
    const stripe = await addApplication(sam.id, { notes: "Referred by Dana", location: "Remote" });

    const response = await call(sam, "PATCH", `/api/applications/${stripe.id}`, { role: "Staff Engineer", notes: "" });

    expect(response.json().application).toMatchObject({
      company: "Stripe",
      role: "Staff Engineer",
      notes: null,
      location: "Remote",
    });
    expect(await eventsFor(stripe.id)).toEqual([]);
  });

  test("changing the status by hand is recorded, and can skip stages or go backwards", async () => {
    const stripe = await addApplication(sam.id, { status: "rejected" });

    await call(sam, "PATCH", `/api/applications/${stripe.id}`, { status: "interview" });
    await call(sam, "PATCH", `/api/applications/${stripe.id}`, { status: "interview" });

    expect((await application(stripe.id))!.status).toBe("interview");
    expect(await eventsFor(stripe.id)).toMatchObject([
      { kind: "interview", source: "manual", fromStatus: "rejected", toStatus: "interview" },
    ]);
  });

  test("deleting removes the application and its timeline", async () => {
    const stripe = await addApplication(sam.id);
    await db
      .insert(schema.events)
      .values({ userId: sam.id, applicationId: stripe.id, kind: "applied", source: "email", occurredAt: day(1) });

    expect((await call(sam, "DELETE", `/api/applications/${stripe.id}`)).statusCode).toBe(204);

    expect(await application(stripe.id)).toBeUndefined();
    expect(await db.select().from(schema.events)).toEqual([]);
  });

  test("another user's application looks like it doesn't exist", async () => {
    const theirs = await addApplication(alex.id, { company: "Alex Only" });
    const url = `/api/applications/${theirs.id}`;

    expect((await call(sam, "GET", url)).statusCode).toBe(404);
    expect((await call(sam, "PATCH", url, { company: "Hijacked" })).statusCode).toBe(404);
    expect((await call(sam, "DELETE", url)).statusCode).toBe(404);
    expect(await application(theirs.id)).toMatchObject({ company: "Alex Only", userId: alex.id });
  });

  test("ids that aren't ids are a bad request, not a server error", async () => {
    expect((await call(sam, "GET", "/api/applications/not-a-uuid")).statusCode).toBe(400);
    expect((await call(sam, "GET", `/api/applications/${MISSING}`)).statusCode).toBe(404);
  });
});

describe("review queue", () => {
  const resolve = (who: { cookie: string }, id: string, payload: object) =>
    call(who, "POST", `/api/review/${id}/resolve`, payload);
  const reviewRow = async (id: string) =>
    (await db.select().from(schema.reviewItems).where(eq(schema.reviewItems.id, id)))[0];
  const emailRow = async (id: string) => (await db.select().from(schema.emails).where(eq(schema.emails.id, id)))[0];

  test("lists open items with the email, what was read from it, and the suggested applications", async () => {
    const stripe = await addApplication(sam.id);
    const { item } = await addReview(sam.id, { candidates: [stripe.id, MISSING] });
    const done = await addReview(sam.id);
    await db.update(schema.reviewItems).set({ resolvedAt: day(9) }).where(eq(schema.reviewItems.id, done.item.id));
    await addReview(alex.id);

    const body = (await call(sam, "GET", "/api/review")).json();

    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: item.id,
      reason: "low_confidence",
      proposedStatus: "rejected",
      email: {
        subject: "Update on your application",
        sender: "Stripe Recruiting <no-reply@greenhouse.io>",
        company: "Stripe",
        role: "Backend Engineer",
        confidence: 0.95,
        summary: "Summary for rejected",
        evidence: "Body of",
      },
      candidates: [{ id: stripe.id, company: "Stripe", status: "applied" }],
    });
  });

  test("applying to the suggested application changes its status and links the email", async () => {
    const stripe = await addApplication(sam.id);
    const { item, email } = await addReview(sam.id, { candidates: [stripe.id] });

    const response = await resolve(sam, item.id, { action: "apply", applicationId: stripe.id });

    expect(response.json()).toEqual({ resolution: "accepted", applicationId: stripe.id });
    expect((await application(stripe.id))!.status).toBe("rejected");
    expect(await eventsFor(stripe.id)).toMatchObject([
      {
        kind: "rejected",
        source: "email",
        fromStatus: "applied",
        toStatus: "rejected",
        emailId: email.id,
        evidenceQuote: "Body of",
        occurredAt: day(8),
      },
    ]);
    expect(await reviewRow(item.id)).toMatchObject({ resolution: "accepted" });
    expect((await reviewRow(item.id))!.resolvedAt).not.toBeNull();
    expect(await emailRow(email.id)).toMatchObject({ processedState: "processed", applicationId: stripe.id });
    expect((await call(sam, "GET", "/api/review")).json().items).toEqual([]);
  });

  test("applying to an application that wasn't suggested counts as reassigned", async () => {
    const suggested = await addApplication(sam.id);
    const other = await addApplication(sam.id, { company: "Ramp" });
    const { item } = await addReview(sam.id, { candidates: [suggested.id] });

    const response = await resolve(sam, item.id, { action: "apply", applicationId: other.id });

    expect(response.json().resolution).toBe("reassigned");
    expect((await application(other.id))!.status).toBe("rejected");
    expect((await application(suggested.id))!.status).toBe("applied");
  });

  test("a person can pick a different status, including one the state machine would refuse", async () => {
    const stripe = await addApplication(sam.id, { status: "rejected" });
    const { item } = await addReview(sam.id, { reason: "status_conflict", candidates: [stripe.id], proposed: "oa" });

    await resolve(sam, item.id, { action: "apply", applicationId: stripe.id, status: "interview" });

    expect((await application(stripe.id))!.status).toBe("interview");
    expect(await eventsFor(stripe.id)).toMatchObject([{ fromStatus: "rejected", toStatus: "interview" }]);
  });

  test("applying a status the application already has just adds the email to its timeline", async () => {
    const stripe = await addApplication(sam.id, { status: "rejected" });
    const { item } = await addReview(sam.id, { candidates: [stripe.id] });

    await resolve(sam, item.id, { action: "apply", applicationId: stripe.id });

    expect(await eventsFor(stripe.id)).toMatchObject([{ kind: "rejected", fromStatus: null, toStatus: null }]);
  });

  test("creating logs a new application from what the email said", async () => {
    const extracted = result("oa", { company: "Capital One", role: "Technology Intern", deadline: day(20) });
    const { item, email } = await addReview(sam.id, { reason: "no_match", proposed: "oa", extracted });

    const response = await resolve(sam, item.id, { action: "create" });

    const { applicationId } = response.json();
    expect(response.json().resolution).toBe("created");
    expect(await application(applicationId)).toMatchObject({
      userId: sam.id,
      company: "Capital One",
      role: "Technology Intern",
      status: "oa",
      source: "email",
      appliedAt: day(8),
    });
    expect(await eventsFor(applicationId)).toMatchObject([
      { kind: "oa", fromStatus: null, toStatus: "oa", emailId: email.id, deadline: day(20) },
    ]);
    expect(await emailRow(email.id)).toMatchObject({ processedState: "processed", applicationId });
  });

  test("creating accepts a corrected company, role and status", async () => {
    const { item } = await addReview(sam.id, { reason: "no_match", extracted: result("applied", { company: null }) });

    expect((await resolve(sam, item.id, { action: "create" })).json()).toEqual({ error: "company_required" });

    const response = await resolve(sam, item.id, { action: "create", company: "Mercor", role: "Analyst", status: "offer" });
    expect(await application(response.json().applicationId)).toMatchObject({
      company: "Mercor",
      role: "Analyst",
      status: "offer",
    });
  });

  test("ignoring dismisses the item and changes nothing else", async () => {
    const stripe = await addApplication(sam.id);
    const { item, email } = await addReview(sam.id, { candidates: [stripe.id] });

    const response = await resolve(sam, item.id, { action: "ignore" });

    expect(response.json()).toEqual({ resolution: "ignored", applicationId: null });
    expect((await application(stripe.id))!.status).toBe("applied");
    expect(await eventsFor(stripe.id)).toEqual([]);
    expect(await emailRow(email.id)).toMatchObject({ processedState: "ignored", applicationId: null });
  });

  test("an item can only be resolved once", async () => {
    const stripe = await addApplication(sam.id);
    const { item } = await addReview(sam.id, { candidates: [stripe.id] });
    await resolve(sam, item.id, { action: "ignore" });

    const again = await resolve(sam, item.id, { action: "apply", applicationId: stripe.id });

    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "already_resolved" });
    expect((await application(stripe.id))!.status).toBe("applied");
  });

  test("an item with no proposed status needs one to be chosen", async () => {
    const stripe = await addApplication(sam.id);
    const { item } = await addReview(sam.id, { proposed: null });

    const response = await resolve(sam, item.id, { action: "apply", applicationId: stripe.id });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "status_required" });
  });

  test("malformed requests are refused", async () => {
    const { item } = await addReview(sam.id);
    expect((await resolve(sam, item.id, { action: "apply" })).statusCode).toBe(400);
    expect((await resolve(sam, item.id, { action: "approve" })).statusCode).toBe(400);
    expect((await resolve(sam, item.id, { action: "ignore", applicationId: MISSING })).statusCode).toBe(400);
    expect((await reviewRow(item.id))!.resolvedAt).toBeNull();
  });

  test("one user can't resolve another's item, or attach their own item to another's application", async () => {
    const theirApplication = await addApplication(alex.id);
    const theirs = await addReview(alex.id, { candidates: [theirApplication.id] });
    const mine = await addReview(sam.id);

    expect((await resolve(sam, theirs.item.id, { action: "ignore" })).statusCode).toBe(404);
    const crossed = await resolve(sam, mine.item.id, { action: "apply", applicationId: theirApplication.id });

    expect(crossed.statusCode).toBe(404);
    expect(crossed.json()).toEqual({ error: "application_not_found" });
    expect((await application(theirApplication.id))!.status).toBe("applied");
    expect((await reviewRow(theirs.item.id))!.resolvedAt).toBeNull();
    expect((await reviewRow(mine.item.id))!.resolvedAt).toBeNull();
  });
});

describe("undoing a status change", () => {
  const revert = (who: { cookie: string }, id: string) => call(who, "POST", `/api/events/${id}/revert`);

  /** An application that went applied → oa → rejected, with one event per step. */
  async function history(userId: string) {
    const stripe = await addApplication(userId);
    const step = async (fromStatus: Status | null, toStatus: Status | null) => {
      const [event] = await db
        .insert(schema.events)
        .values({
          userId,
          applicationId: stripe.id,
          kind: toStatus ?? "other",
          source: "email",
          fromStatus,
          toStatus,
          occurredAt: day(1),
          // Explicit, so the order doesn't depend on rows being inserted in different milliseconds.
          createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, sequence++)),
        })
        .returning();
      if (toStatus) await db.update(schema.applications).set({ status: toStatus }).where(eq(schema.applications.id, stripe.id));
      return event!;
    };
    let sequence = 0;
    const created = await step(null, "applied");
    const toOa = await step("applied", "oa");
    const toRejected = await step("oa", "rejected");
    const note = await step(null, null);
    return { stripe, created, toOa, toRejected, note };
  }

  test("puts back the status it replaced and marks the event undone", async () => {
    const { stripe, toRejected } = await history(sam.id);

    const response = await revert(sam, toRejected.id);

    expect(response.json()).toEqual({ applicationId: stripe.id, status: "oa" });
    expect((await application(stripe.id))!.status).toBe("oa");
    const [event] = await db.select().from(schema.events).where(eq(schema.events.id, toRejected.id));
    expect(event!.revertedAt).not.toBeNull();
  });

  test("changes can be undone one at a time, newest first", async () => {
    const { stripe, toOa, toRejected } = await history(sam.id);

    expect((await revert(sam, toOa.id)).json()).toEqual({ error: "not_latest_change" });
    await revert(sam, toRejected.id);
    expect((await revert(sam, toOa.id)).statusCode).toBe(200);
    expect((await application(stripe.id))!.status).toBe("applied");
  });

  test("the same change can't be undone twice", async () => {
    const { toRejected } = await history(sam.id);
    await revert(sam, toRejected.id);

    const again = await revert(sam, toRejected.id);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "already_reverted" });
  });

  test("events that changed nothing, or created the application, can't be undone", async () => {
    const { stripe, created, toOa, toRejected, note } = await history(sam.id);
    expect((await revert(sam, note.id)).json()).toEqual({ error: "not_a_status_change" });

    await revert(sam, toRejected.id);
    await revert(sam, toOa.id);
    expect((await revert(sam, created.id)).json()).toEqual({ error: "nothing_to_restore" });
    expect((await application(stripe.id))!.status).toBe("applied");
  });

  test("a change made by hand since then blocks undoing the older one", async () => {
    const { stripe, toRejected } = await history(sam.id);
    await call(sam, "PATCH", `/api/applications/${stripe.id}`, { status: "offer" });

    expect((await revert(sam, toRejected.id)).json()).toEqual({ error: "not_latest_change" });
    expect((await application(stripe.id))!.status).toBe("offer");
  });

  test("one user can't undo another's change", async () => {
    const { stripe, toRejected } = await history(alex.id);
    expect((await revert(sam, toRejected.id)).statusCode).toBe(404);
    expect((await application(stripe.id))!.status).toBe("rejected");
  });
});

describe("syncing from the dashboard", () => {
  const CONFIRMATION = "Thank you for applying to Stripe";

  async function appWithInbox(gmail: FakeGmail | null) {
    const { classifier } = fakeClassifier({ [CONFIRMATION]: result("applied") });
    app = await testApp(db, oauth, {
      ingest: { classifier, triager: null, connect: async () => gmail, threshold: 0.85, backfillDays: 30 },
    });
    return signIn("sam");
  }

  test("starts in the background and syncs only the signed-in user", async () => {
    sam = await appWithInbox(new FakeGmail().add(mail("m1", CONFIRMATION, day(1))));

    const response = await call(sam, "POST", "/api/sync");

    expect(response.statusCode).toBe(202);
    await vi.waitFor(async () => expect(await db.select().from(schema.syncState)).toHaveLength(1));
    expect(await db.select().from(schema.applications)).toMatchObject([{ userId: sam.id, company: "Stripe" }]);
    const profile = (await call(sam, "GET", "/api/me")).json();
    expect(profile.lastSyncAt).not.toBeNull();
  });

  test("a second request while one is running is refused, and allowed again afterwards", async () => {
    const gmail = new FakeGmail().add(mail("m1", CONFIRMATION, day(1)));
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const listMessageIds = gmail.listMessageIds.bind(gmail);
    gmail.listMessageIds = async (query) => {
      await gate;
      return listMessageIds(query);
    };
    sam = await appWithInbox(gmail);

    expect((await call(sam, "POST", "/api/sync")).statusCode).toBe(202);
    const second = await call(sam, "POST", "/api/sync");
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "sync_in_progress" });

    release();
    await vi.waitFor(async () => expect(await db.select().from(schema.syncState)).toHaveLength(1));
    await vi.waitFor(async () => expect((await call(sam, "POST", "/api/sync")).statusCode).toBe(202));
  });

  test("is refused when Gmail access has lapsed", async () => {
    sam = await appWithInbox(null);
    const response = await call(sam, "POST", "/api/sync");
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "gmail_disconnected" });
    expect((await call(sam, "POST", "/api/sync")).json()).toEqual({ error: "gmail_disconnected" });
  });
});

describe("deleting an account", () => {
  test("removes everything the user owns, revokes Google access, and ends the session", async () => {
    const stripe = await addApplication(sam.id);
    await addReview(sam.id, { candidates: [stripe.id] });
    const theirs = await addApplication(alex.id);

    const response = await call(sam, "DELETE", "/api/me");

    expect(response.statusCode).toBe(204);
    expect(oauth.revokeToken).toHaveBeenCalledExactlyOnceWith("refresh-sam");
    expect((await db.select().from(schema.users)).map((u) => u.id)).toEqual([alex.id]);
    for (const table of [schema.applications, schema.emails, schema.reviewItems, schema.oauthTokens]) {
      expect((await db.select({ userId: table.userId }).from(table)).every((r) => r.userId === alex.id)).toBe(true);
    }
    expect(await application(theirs.id)).toBeDefined();
    expect((await call(sam, "GET", "/api/me")).statusCode).toBe(401);
    expect((await call(alex, "GET", "/api/me")).statusCode).toBe(200);
  });

  test("still deletes the data when Google can't be reached", async () => {
    oauth.revokeToken.mockRejectedValueOnce(new GoogleAuthError("failed", "offline"));

    expect((await call(sam, "DELETE", "/api/me")).statusCode).toBe(204);
    expect((await db.select().from(schema.users)).map((u) => u.id)).toEqual([alex.id]);
  });
});
