import { expect, test, vi } from "vitest";
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
  const gmail = createGmailClient({ accessToken: "access-token", fetch: fetchMock, sleep });
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

test("an empty history still moves the cursor forward", async () => {
  const { gmail } = setup(json({ historyId: "300" }));
  await expect(gmail.listAddedSince("100")).resolves.toEqual({ messageIds: [], historyId: "300" });
});

test("a cursor Gmail has forgotten is reported as history_expired", async () => {
  const { gmail } = setup(json({ error: {} }, 404));
  await expect(gmail.listAddedSince("1")).rejects.toMatchObject({ code: "history_expired" });
});

test("a search is paged", async () => {
  const { gmail, url } = setup(
    json({ messages: [{ id: "m3" }, { id: "m2" }], nextPageToken: "next" }),
    json({ messages: [{ id: "m1" }] }),
  );
  await expect(gmail.listMessageIds("after:123")).resolves.toEqual(["m3", "m2", "m1"]);
  expect(url(0).searchParams.get("q")).toBe("after:123");
  expect(url(1).searchParams.get("pageToken")).toBe("next");
});

test("a search with no results returns nothing", async () => {
  await expect(setup(json({ resultSizeEstimate: 0 })).gmail.listMessageIds("after:1")).resolves.toEqual([]);
});

test("a message is fetched in full, and a deleted one is null", async () => {
  const { gmail, url } = setup(json({ id: "m1", threadId: "t1", payload: { headers: [] } }), json({}, 404));
  await expect(gmail.getMessage("m1")).resolves.toMatchObject({ id: "m1", threadId: "t1", payload: { headers: [] } });
  expect(url(0).pathname).toBe("/gmail/v1/users/me/messages/m1");
  expect(url(0).searchParams.get("format")).toBe("full");
  await expect(gmail.getMessage("gone")).resolves.toBeNull();
});

test("rate limits, server errors and network failures are retried", async () => {
  const { gmail, sleep } = setup(json({}, 429), json({}, 503), new Error("reset"), json({ historyId: "5" }));
  await expect(gmail.getHistoryId()).resolves.toBe("5");
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000]);
});

test("retries give up eventually", async () => {
  const { gmail, fetchMock } = setup(json({}, 500), json({}, 500), json({}, 500), json({}, 500));
  await expect(gmail.getHistoryId()).rejects.toMatchObject({ code: "failed" });
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

test("a rejected token fails at once with an auth error", async () => {
  const { gmail, fetchMock } = setup(json({}, 401));
  await expect(gmail.getHistoryId()).rejects.toMatchObject({ code: "auth" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("an unexpected response shape is an error, not a silent empty result", async () => {
  await expect(setup(json({ nope: true })).gmail.getHistoryId()).rejects.toMatchObject({ code: "failed" });
});

test("sent mail, drafts, chats, spam and trash are skipped", () => {
  expect(hasSkippedLabel(["INBOX", "UNREAD"])).toBe(false);
  expect(hasSkippedLabel(["INBOX", "SENT"])).toBe(true);
  expect(hasSkippedLabel(undefined)).toBe(false);
});
