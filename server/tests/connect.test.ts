import { beforeEach, expect, test, vi } from "vitest";
import { GoogleAuthError, type GoogleOAuth } from "../src/auth/google.ts";
import { deriveKey, encrypt } from "../src/auth/secrets.ts";
import * as schema from "../src/db/schema.ts";
import { createGmailConnector } from "../src/gmail/connect.ts";
import { createUser, freshDb, type TestDb } from "./helpers/db.ts";

const tokenKey = deriveKey("k".repeat(32), "refresh-token");

let db: TestDb;
let userId: string;
let refreshAccessToken: ReturnType<typeof vi.fn<GoogleOAuth["refreshAccessToken"]>>;

beforeEach(async () => {
  db = await freshDb();
  userId = (await createUser(db, "sam")).id;
  refreshAccessToken = vi.fn<GoogleOAuth["refreshAccessToken"]>(async () => "fresh-access-token");
});

const storeToken = () =>
  db.insert(schema.oauthTokens).values({
    userId,
    refreshTokenEncrypted: encrypt("stored-refresh-token", tokenKey),
    scope: "gmail.readonly",
  });

function connector(fetchMock?: typeof fetch) {
  const oauth: GoogleOAuth = { authUrl: () => "", exchangeCode: async () => Promise.reject(), refreshAccessToken };
  return createGmailConnector({ db, oauth, tokenKey, fetch: fetchMock });
}

test("opens the inbox with an access token minted from the stored refresh token", async () => {
  await storeToken();
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ historyId: "77" })),
  );

  const gmail = await connector(fetchMock)(userId);

  expect(refreshAccessToken).toHaveBeenCalledWith("stored-refresh-token");
  await expect(gmail!.getHistoryId()).resolves.toBe("77");
  expect(fetchMock.mock.calls[0]![1]).toEqual({ headers: { Authorization: "Bearer fresh-access-token" } });
});

test("a user with no stored token has no inbox", async () => {
  expect(await connector()(userId)).toBeNull();
  expect(refreshAccessToken).not.toHaveBeenCalled();
});

test("a revoked token is deleted so the user is asked to reconnect", async () => {
  await storeToken();
  refreshAccessToken.mockRejectedValueOnce(new GoogleAuthError("invalid_grant", "revoked"));

  expect(await connector()(userId)).toBeNull();
  expect(await db.select().from(schema.oauthTokens)).toEqual([]);
});

test("a temporary Google failure keeps the token for the next run", async () => {
  await storeToken();
  refreshAccessToken.mockRejectedValueOnce(new GoogleAuthError("failed", "HTTP 503"));

  await expect(connector()(userId)).rejects.toMatchObject({ code: "failed" });
  expect(await db.select().from(schema.oauthTokens)).toHaveLength(1);
});
