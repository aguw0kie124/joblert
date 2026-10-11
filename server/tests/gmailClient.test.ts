import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createGmailClient, hasSkippedLabel } from "../src/gmail/client.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function setup(...responses: (Response | Error)[]) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn(async (_ms: number) => {});
  const gmail = createGmailClient({ accessToken: "access-token", fetch: fetchMock, sleep, pace: false });
  const url = (call: number) => fetchMock.mock.calls[call]![0] as URL;
  return { gmail, fetchMock, sleep, url };
}

test("requests carry the access token", async () => {
  const { gmail, fetchMock, url } = setup(json({ historyId: "900" }));
  await expect(gmail.getHistoryId()).resolves.toBe("900");
  expect(url(0).pathname).toBe("/gmail/v1/users/me/profile");
  expect(fetchMock.mock.calls[0]![1]).toEqual({ headers: { Authorization: "Bearer access-token" } });
});

test("history is paged, de-duplicated, and skips sent mail", async () => {
  const { gmail, url } = setup(
    json({
      history: [
        { messagesAdded: [{ message: { id: "m1", labelIds: ["INBOX"] } }] },
        { messagesAdded: [{ message: { id: "m2", labelIds: ["SENT"] } }, { message: { id: "m3" } }] },
        {},
      ],
      nextPageToken: "page-2",
      historyId: "150",
    }),
    json({ history: [{ messagesAdded: [{ message: { id: "m1" } }, { message: { id: "m4" } }] }], historyId: "200" }),
  );

  await expect(gmail.listAddedSince("100")).resolves.toEqual({ messageIds: ["m1", "m3", "m4"], historyId: "200" });
  expect(Object.fromEntries(url(0).searchParams)).toMatchObject({ startHistoryId: "100", historyTypes: "messageAdded" });
  expect(url(1).searchParams.get("pageToken")).toBe("page-2");
});

test("watching posts the topic and limits notifications to the inbox", async () => {
  const { gmail, fetchMock, url } = setup(json({ historyId: "900", expiration: "1791561367454" }));

  await gmail.watch("projects/joblert/topics/gmail");

  expect(url(0).pathname).toBe("/gmail/v1/users/me/watch");
  const init = fetchMock.mock.calls[0]![1]!;
  expect(init.method).toBe("POST");
  expect(new Headers(init.headers).get("authorization")).toBe("Bearer access-token");
  expect(JSON.parse(init.body as string)).toEqual({
    topicName: "projects/joblert/topics/gmail",
    labelIds: ["INBOX"],
    labelFilterBehavior: "include",
  });
});

test("a refused watch is an error, with Gmail's reason", async () => {
  const refused = json({ error: { errors: [{ reason: "forbidden" }] } }, 403);
  await expect(setup(refused).gmail.watch("projects/joblert/topics/gmail")).rejects.toMatchObject({
    code: "auth",
    message: expect.stringContaining("forbidden"),
  });
});

test("stopping a watch posts, and copes with the empty answer", async () => {
  const { gmail, fetchMock, url } = setup(new Response(null, { status: 204 }));
  await expect(gmail.stopWatch()).resolves.toBeUndefined();
  expect(url(0).pathname).toBe("/gmail/v1/users/me/stop");
  expect(fetchMock.mock.calls[0]![1]!.method).toBe("POST");
});

test("an empty history still moves the cursor forward", async () => {
  const { gmail } = setup(json({ historyId: "300" }));
  await expect(gmail.listAddedSince("100")).resolves.toEqual({ messageIds: [], historyId: "300" });
});

test("a cursor Gmail has forgotten is reported as history_expired", async () => {
  const { gmail } = setup(json({ error: {} }, 404));
  await expect(gmail.listAddedSince("1")).rejects.toMatchObject({ code: "history_expired" });
});

test("a message is fetched in full, and a deleted one is null", async () => {
  const { gmail, url } = setup(json({ id: "m1", threadId: "t1", payload: { headers: [] } }), json({}, 404));
  await expect(gmail.getMessage("m1")).resolves.toMatchObject({ id: "m1", threadId: "t1", payload: { headers: [] } });
  expect(url(0).pathname).toBe("/gmail/v1/users/me/messages/m1");
  expect(url(0).searchParams.get("format")).toBe("full");
  await expect(gmail.getMessage("gone")).resolves.toBeNull();
});

test("server errors and network failures are retried with growing waits", async () => {
  const { gmail, sleep } = setup(json({}, 503), new Error("reset"), json({}, 500), json({ historyId: "5" }));
  await expect(gmail.getHistoryId()).resolves.toBe("5");
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000]);
});

test("retries give up eventually", async () => {
  const { gmail, fetchMock, sleep } = setup(...Array.from({ length: 6 }, () => json({}, 500)));
  await expect(gmail.getHistoryId()).rejects.toMatchObject({ code: "failed" });
  expect(fetchMock).toHaveBeenCalledTimes(6);
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000, 8000, 16000]);
});

test("a rejected token fails at once with an auth error", async () => {
  const { gmail, fetchMock } = setup(json({}, 401));
  await expect(gmail.getHistoryId()).rejects.toMatchObject({ code: "auth" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

const googleError = (status: number, reason: string) => json({ error: { errors: [{ reason }] } }, status);

test("a disabled Gmail API fails at once and says what to fix", async () => {
  const { gmail, fetchMock } = setup(googleError(403, "accessNotConfigured"));
  await expect(gmail.getHistoryId()).rejects.toMatchObject({
    code: "auth",
    message: "Gmail returned HTTP 403 for profile: the Gmail API is not enabled in the Google Cloud project",
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("rate limits are waited out, whether Gmail reports them as 429 or 403", async () => {
  const { gmail, sleep } = setup(
    json({}, 429),
    googleError(403, "rateLimitExceeded"),
    googleError(403, "userRateLimitExceeded"),
    json({ historyId: "5" }),
  );
  await expect(gmail.getHistoryId()).resolves.toBe("5");
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([2000, 4000, 8000]);
});

test("a rate limit outlasts far more retries than an outage, but not forever", async () => {
  const { gmail, fetchMock, sleep } = setup(...Array.from({ length: 11 }, () => json({}, 429)));
  await expect(gmail.getHistoryId()).rejects.toMatchObject({ code: "failed", message: /kept rate limiting/ });
  expect(fetchMock).toHaveBeenCalledTimes(11);
  expect(sleep.mock.calls.reduce((total, [ms]) => total + ms, 0)).toBeGreaterThan(4 * 60_000);
});

test("an unexpected response shape is an error, not a silent empty result", async () => {
  await expect(setup(json({ nope: true })).gmail.getHistoryId()).rejects.toMatchObject({ code: "failed" });
});

test("sent mail, drafts, chats, spam and trash are skipped", () => {
  expect(hasSkippedLabel(["INBOX", "UNREAD"])).toBe(false);
  expect(hasSkippedLabel(["INBOX", "SENT"])).toBe(true);
  expect(hasSkippedLabel(undefined)).toBe(false);
});

describe("pacing", () => {
  const paced = (...responses: Response[]) => {
    const fetchMock = vi.fn(async () => responses.shift() ?? json({ id: "m", threadId: "t" }));
    // Waiting moves the clock, as it would for real.
    const sleep = vi.fn(async (ms: number) => void vi.advanceTimersByTime(ms));
    return { gmail: createGmailClient({ accessToken: "t", fetch: fetchMock, sleep }), sleep, fetchMock };
  };
  const waits = (sleep: ReturnType<typeof paced>["sleep"]) => sleep.mock.calls.map(([ms]) => Math.round(ms));

  beforeEach(() => void vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] }));
  afterEach(() => void vi.useRealTimers());

  test("requests made together are spaced out instead of sent at once", async () => {
    const { gmail, sleep } = paced();
    await Promise.all(["a", "b", "c", "d"].map((id) => gmail.getMessage(id)));
    // Each wait is measured from when the one before it ended.
    expect(waits(sleep)).toEqual([100, 100, 100]);
  });

  test("a rate limit doubles the gap for the requests that follow", async () => {
    const { gmail, sleep } = paced(json({}, 429));
    await gmail.getMessage("a");
    await gmail.getMessage("b");
    // 2000 is the wait after the rate limit; then the gap is 200 instead of 100.
    expect(waits(sleep)).toEqual([2000, 200]);
  });

  test("the gap shrinks while requests succeed, down to a floor", async () => {
    const { gmail, sleep } = paced();
    for (let i = 0; i < 80; i++) await gmail.getMessage(`m${i}`);
    const gaps = waits(sleep);
    expect(gaps[0]).toBe(100);
    expect(gaps.at(-1)).toBe(50);
    expect(gaps.every((gap) => gap >= 50 && gap <= 100)).toBe(true);
    expect(gaps[20]).toBeLessThan(80);
  });
});
