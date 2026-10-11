import { beforeEach, describe, expect, test, vi } from "vitest";
import * as schema from "../src/db/schema.ts";
import { GmailError } from "../src/gmail/client.ts";
import { ClassifierError } from "../src/pipeline/classify.ts";
import { createSyncRunner, type SyncRunnerOptions } from "../src/pipeline/syncRunner.ts";
import { createUser, freshDb, seedCursor, type TestDb } from "./helpers/db.ts";
import { FakeGmail, fakeClassifier, fakeTriager, mail, result } from "./helpers/inbox.ts";

const TOPIC = "projects/joblert/topics/gmail";
const CONFIRMATION = "Thank you for applying to Stripe";
const REJECTION = "Update on your Stripe application";
const day = (n: number) => new Date(Date.UTC(2026, 9, n, 9));

let db: TestDb;
let sam: string;
let inboxes: Map<string, FakeGmail>;

/** A user with a Gmail token and a cursor, and the inbox their syncs read. */
async function connected(name: string) {
  const { id } = await createUser(db, name);
  await seedCursor(db, id);
  await db.insert(schema.oauthTokens).values({ userId: id, refreshTokenEncrypted: "ciphertext", scope: "gmail" });
  const gmail = new FakeGmail();
  inboxes.set(id, gmail);
  return { id, gmail };
}

const answers = () =>
  fakeClassifier({ [CONFIRMATION]: result("applied"), [REJECTION]: result("rejected") });

const runner = (overrides: Partial<SyncRunnerOptions> = {}) =>
  createSyncRunner({
    db,
    classifier: answers().classifier,
    triager: fakeTriager([]).triager,
    connect: async (userId) => inboxes.get(userId) ?? null,
    threshold: 0.85,
    topic: TOPIC,
    ...overrides,
  });

const applications = () => db.select().from(schema.applications);
const cursorOf = async (userId: string) =>
  (await db.select().from(schema.syncState)).find((row) => row.userId === userId)?.historyId;

beforeEach(async () => {
  db = await freshDb();
  inboxes = new Map();
  sam = (await connected("sam")).id;
});

describe("sync", () => {
  test("reads the inbox and reports ok", async () => {
    inboxes.get(sam)!.add(mail("m1", CONFIRMATION, day(1)));

    expect(await runner().sync(sam)).toBe("ok");

    expect(await applications()).toMatchObject([{ userId: sam, company: "Stripe", status: "applied" }]);
    expect(await cursorOf(sam)).toBe("100");
  });

  test("notifications that arrive during a sync cause exactly one more pass", async () => {
    const gmail = inboxes.get(sam)!.add(mail("m1", CONFIRMATION, day(1)));
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const listAddedSince = vi.spyOn(gmail, "listAddedSince");
    listAddedSince.mockImplementationOnce(async () => {
      await gate;
      return { messageIds: ["m1"], historyId: "100" };
    });
    const sync = runner();

    const first = sync.sync(sam);
    await vi.waitFor(() => expect(listAddedSince).toHaveBeenCalledTimes(1));
    expect(sync.isRunning(sam)).toBe(true);
    gmail.add(mail("m2", REJECTION, day(8)));
    expect(await Promise.all([sync.sync(sam), sync.sync(sam), sync.sync(sam)])).toEqual(["running", "running", "running"]);
    release();

    expect(await first).toBe("ok");
    expect(listAddedSince).toHaveBeenCalledTimes(2);
    expect(await applications()).toMatchObject([{ status: "rejected" }]);
    expect(sync.isRunning(sam)).toBe(false);
  });

  test.each([
    ["a rate limit", new ClassifierError("unavailable", "rate limited"), "retry"],
    ["a rejected API key", new ClassifierError("auth", "bad key"), "failed"],
  ] as const)("%s is reported, and leaves the cursor for the next sync", async (_name, error, outcome) => {
    inboxes.get(sam)!.add(mail("m1", CONFIRMATION, day(1)));
    const { classifier } = fakeClassifier({ [CONFIRMATION]: error });

    expect(await runner({ classifier }).sync(sam)).toBe(outcome);
    expect(await cursorOf(sam)).toBe("1");
  });

  test("a Gmail failure is worth retrying; a refused token is not", async () => {
    const gmail = inboxes.get(sam)!.add(mail("m1", CONFIRMATION, day(1)));
    gmail.failOn = "m1";
    expect(await runner().sync(sam)).toBe("retry");

    vi.spyOn(gmail, "listAddedSince").mockRejectedValue(new GmailError("auth", "Gmail rejected the access token"));
    expect(await runner().sync(sam)).toBe("failed");
  });

  test("an inbox whose access has lapsed is reported as disconnected", async () => {
    expect(await runner({ connect: async () => null }).sync(sam)).toBe("disconnected");
  });

  test("Google being unreachable is worth retrying, and doesn't leave the inbox marked as syncing", async () => {
    const sync = runner({
      connect: async () => {
        throw new Error("offline");
      },
    });
    expect(await sync.sync(sam)).toBe("retry");
    expect(sync.isRunning(sam)).toBe(false);
  });

  test("failures are logged, never thrown", async () => {
    inboxes.get(sam)!.add(mail("m1", CONFIRMATION, day(1)));
    const log = vi.fn();
    const { classifier } = fakeClassifier({ [CONFIRMATION]: new ClassifierError("unavailable", "rate limited") });

    await runner({ classifier, log }).sync(sam);

    expect(log).toHaveBeenCalledWith("Sync failed", { userId: sam, error: "rate limited" });
  });
});

describe("begin", () => {
  test("returns once the sync is under way, and settles `done` when it ends", async () => {
    inboxes.get(sam)!.add(mail("m1", CONFIRMATION, day(1)));
    const sync = runner();

    const start = await sync.begin(sam);

    expect(start.status).toBe("started");
    expect(sync.isRunning(sam)).toBe(true);
    expect(start.status === "started" && (await start.done)).toBe("ok");
    expect(sync.isRunning(sam)).toBe(false);
  });
});

describe("refresh", () => {
  test("renews the watch, then syncs", async () => {
    const gmail = inboxes.get(sam)!.add(mail("m1", CONFIRMATION, day(1)));

    expect(await runner().refresh(sam)).toBe("ok");

    expect(gmail.watched).toEqual([TOPIC]);
    expect(await applications()).toHaveLength(1);
  });

  test("a plain sync does not touch the watch", async () => {
    await runner().sync(sam);
    expect(inboxes.get(sam)!.watched).toEqual([]);
  });

  test("without a topic there is nothing to watch", async () => {
    expect(await runner({ topic: undefined }).refresh(sam)).toBe("ok");
    expect(inboxes.get(sam)!.watched).toEqual([]);
  });

  test("still syncs when the watch is refused", async () => {
    const gmail = inboxes.get(sam)!.add(mail("m1", CONFIRMATION, day(1)));
    gmail.watchError = new GmailError("auth", "Gmail returned HTTP 403 for watch: forbidden");
    const log = vi.fn();

    expect(await runner({ log }).refresh(sam)).toBe("ok");

    expect(await applications()).toHaveLength(1);
    expect(log).toHaveBeenCalledWith("Could not watch the inbox", expect.objectContaining({ userId: sam }));
  });
});

describe("refreshAll", () => {
  test("covers every connected inbox, keeps each user's data apart, and skips users without Gmail", async () => {
    const alex = await connected("alex");
    const unconnected = await createUser(db, "pat");
    inboxes.get(sam)!.add(mail("m1", CONFIRMATION, day(1)));
    // Same Gmail message id as the other inbox.
    alex.gmail.add(mail("m1", CONFIRMATION, day(1)), mail("m2", REJECTION, day(8)));
    const connect = vi.fn(async (userId: string) => inboxes.get(userId) ?? null);

    await runner({ connect }).refreshAll();

    const rows = await applications();
    expect(rows.find((a) => a.userId === sam)?.status).toBe("applied");
    expect(rows.find((a) => a.userId === alex.id)?.status).toBe("rejected");
    expect(rows).toHaveLength(2);
    expect(inboxes.get(sam)!.watched).toEqual([TOPIC]);
    expect(alex.gmail.watched).toEqual([TOPIC]);
    expect(connect).not.toHaveBeenCalledWith(unconnected.id);
  });

  test("one inbox failing does not stop the next", async () => {
    const alex = await connected("alex");
    const broken = inboxes.get(sam)!.add(mail("m1", CONFIRMATION, day(1)));
    broken.failOn = "m1";
    alex.gmail.add(mail("m1", CONFIRMATION, day(1)));

    await runner().refreshAll();

    expect(await applications()).toMatchObject([{ userId: alex.id }]);
    expect(await cursorOf(sam)).toBe("1");
  });
});

describe("the timer", () => {
  test("refreshes every inbox as soon as it starts", async () => {
    const sync = runner();
    sync.startTimer();
    await vi.waitFor(() => expect(inboxes.get(sam)!.watched).toEqual([TOPIC]));
    sync.stopTimer();
  });
});

describe("unwatch", () => {
  test("stops Gmail's notifications when push is in use", async () => {
    await runner().unwatch(sam);
    expect(inboxes.get(sam)!.stops).toBe(1);
  });

  test("does nothing without a topic, and never throws", async () => {
    await runner({ topic: undefined }).unwatch(sam);
    expect(inboxes.get(sam)!.stops).toBe(0);

    const offline = runner({
      connect: async () => {
        throw new Error("offline");
      },
    });
    await expect(offline.unwatch(sam)).resolves.toBeUndefined();
  });
});
