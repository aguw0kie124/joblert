import { expect, test, vi } from "vitest";
import { createGoogleOAuth, GMAIL_SCOPE, GoogleAuthError, hasGmailScope } from "../src/auth/google.ts";

const idToken = (claims: Record<string, unknown>) =>
  `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;

const claims = { aud: "client-id", sub: "google-123", email: "Sam@Example.com", email_verified: true };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function setup(response: Response | Error) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    if (response instanceof Error) throw response;
    return response;
  });
  const oauth = createGoogleOAuth({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost:3000/auth/google/callback",
    fetch: fetchMock,
  });
  return { oauth, fetchMock };
}

const sentBody = (fetchMock: ReturnType<typeof setup>["fetchMock"]) =>
  Object.fromEntries(fetchMock.mock.calls[0]![1]!.body as URLSearchParams);

test("the sign-in URL asks for read-only Gmail and a refresh token", () => {
  const url = new URL(setup(json({})).oauth.authUrl("state-abc"));
  expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    client_id: "client-id",
    redirect_uri: "http://localhost:3000/auth/google/callback",
    response_type: "code",
    state: "state-abc",
    access_type: "offline",
    prompt: "consent",
  });
  expect(url.searchParams.get("scope")!.split(" ")).toEqual(["openid", "email", GMAIL_SCOPE]);
});

test("exchanging a code returns the account and its refresh token", async () => {
  const { oauth, fetchMock } = setup(
    json({ access_token: "at", refresh_token: "rt", scope: `openid ${GMAIL_SCOPE}`, id_token: idToken(claims) }),
  );
  await expect(oauth.exchangeCode("the-code")).resolves.toEqual({
    sub: "google-123",
    email: "sam@example.com",
    refreshToken: "rt",
    scope: `openid ${GMAIL_SCOPE}`,
  });
  expect(sentBody(fetchMock)).toEqual({
    client_id: "client-id",
    client_secret: "client-secret",
    code: "the-code",
    grant_type: "authorization_code",
    redirect_uri: "http://localhost:3000/auth/google/callback",
  });
});

test.each([
  ["issued to another app", { ...claims, aud: "someone-else" }],
  ["with an unverified email", { ...claims, email_verified: false }],
  ["without an account id", { ...claims, sub: "" }],
])("an ID token %s is rejected", async (_name, badClaims) => {
  const { oauth } = setup(json({ access_token: "at", id_token: idToken(badClaims) }));
  await expect(oauth.exchangeCode("code")).rejects.toBeInstanceOf(GoogleAuthError);
});

test("a missing or garbled ID token is rejected", async () => {
  await expect(setup(json({ access_token: "at" })).oauth.exchangeCode("code")).rejects.toThrow("ID token");
  await expect(setup(json({ access_token: "at", id_token: "garbage" })).oauth.exchangeCode("code")).rejects.toThrow(
    "unreadable",
  );
});

test("refreshing returns a new access token", async () => {
  const { oauth, fetchMock } = setup(json({ access_token: "fresh", scope: GMAIL_SCOPE }));
  await expect(oauth.refreshAccessToken("rt")).resolves.toBe("fresh");
  expect(sentBody(fetchMock)).toMatchObject({ refresh_token: "rt", grant_type: "refresh_token" });
});

test("a revoked refresh token is reported as invalid_grant", async () => {
  const { oauth } = setup(json({ error: "invalid_grant" }, 400));
  await expect(oauth.refreshAccessToken("rt")).rejects.toMatchObject({ code: "invalid_grant" });
});

test("other failures are reported as retryable", async () => {
  await expect(setup(json({ error: "server_error" }, 500)).oauth.refreshAccessToken("rt")).rejects.toMatchObject({
    code: "failed",
  });
  await expect(setup(new Error("offline")).oauth.refreshAccessToken("rt")).rejects.toMatchObject({ code: "failed" });
  await expect(setup(json({ unexpected: true })).oauth.refreshAccessToken("rt")).rejects.toMatchObject({
    code: "failed",
  });
});

test("the Gmail scope is matched exactly", () => {
  expect(hasGmailScope(`openid email ${GMAIL_SCOPE}`)).toBe(true);
  expect(hasGmailScope("openid email")).toBe(false);
  expect(hasGmailScope(`${GMAIL_SCOPE}.extra`)).toBe(false);
});

test("revoking posts the token, and treats an already-dead token as done", async () => {
  const live = setup(new Response("{}", { status: 200 }));
  await expect(live.oauth.revokeToken("rt")).resolves.toBeUndefined();
  expect(String(live.fetchMock.mock.calls[0]![0])).toBe("https://oauth2.googleapis.com/revoke");
  expect(sentBody(live.fetchMock)).toEqual({ token: "rt" });

  await expect(setup(json({ error: "invalid_token" }, 400)).oauth.revokeToken("rt")).resolves.toBeUndefined();
});

test("a failed revoke is reported", async () => {
  await expect(setup(json({}, 503)).oauth.revokeToken("rt")).rejects.toMatchObject({ code: "failed" });
  await expect(setup(new Error("offline")).oauth.revokeToken("rt")).rejects.toMatchObject({ code: "failed" });
});
