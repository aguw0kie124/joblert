import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { GoogleAuthError } from "../src/auth/google.ts";
import { decrypt, deriveKey } from "../src/auth/secrets.ts";
import * as schema from "../src/db/schema.ts";
import {
  completeSignIn as signInThrough,
  cookieFrom,
  fakeOAuth,
  googleSignIn as signIn,
  PUBSUB,
  startSignIn,
  testApp,
  TOKEN_SECRET,
  WEB_URL,
  type FakeOAuth,
} from "./helpers/app.ts";
import { freshDb, type TestDb } from "./helpers/db.ts";
import { FakeGmail, fakeClassifier, fakeTriager, mail } from "./helpers/inbox.ts";

let db: TestDb;
let app: FastifyInstance;
let oauth: FakeOAuth;
let exchangeCode: FakeOAuth["exchangeCode"];

beforeEach(async () => {
  db = await freshDb();
  oauth = fakeOAuth();
  exchangeCode = oauth.exchangeCode;
  app = await testApp(db, oauth);
});

const start = () => startSignIn(app);
const completeSignIn = () => signInThrough(app);

const me = (cookie?: string) =>
  app.inject({ method: "GET", url: "/api/me", headers: cookie ? { cookie } : {} });

describe("connecting an inbox", () => {
  test("starts Gmail's notifications and begins from now, without reading old mail", async () => {
    const gmail = new FakeGmail().add(mail("m1", "Thank you for applying to Stripe", new Date("2026-10-01T09:00:00Z")));
    gmail.historyId = "4242";
    const { classifier, classify } = fakeClassifier({});
    app = await testApp(db, oauth, {
      pubsub: PUBSUB,
      ingest: { classifier, triager: fakeTriager([]).triager, connect: async () => gmail, threshold: 0.85 },
    });

    await completeSignIn();

    await vi.waitFor(async () => expect(await db.select().from(schema.syncState)).toMatchObject([{ historyId: "4242" }]));
    expect(gmail.watched).toEqual([PUBSUB.topic]);
    expect(classify).not.toHaveBeenCalled();
    expect(await db.select().from(schema.emails)).toEqual([]);
  });
});

describe("signing in", () => {
  test("starts by sending the browser to Google with a fresh state", async () => {
    const first = await start();
    const second = await start();
    expect(first.response.statusCode).toBe(302);
    expect(first.response.headers.location).toContain("https://accounts.google.test/auth?state=");
    expect(first.state).not.toBe(second.state);
  });

  test("creates the user, stores the refresh token encrypted, and opens a session", async () => {
    const { response, cookie } = await completeSignIn();

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(WEB_URL);
    expect(exchangeCode).toHaveBeenCalledWith("the-code");

    const [user] = await db.select().from(schema.users);
    expect(user).toMatchObject({ googleSub: "google-sam", email: "sam@example.com" });
    const [token] = await db.select().from(schema.oauthTokens);
    expect(token!.refreshTokenEncrypted).not.toContain("refresh-token-1");
    expect(decrypt(token!.refreshTokenEncrypted, deriveKey(TOKEN_SECRET, "refresh-token"))).toBe("refresh-token-1");

    const profile = await me(cookie);
    expect(profile.json()).toEqual({ id: user!.id, email: "sam@example.com", gmailConnected: true, lastSyncAt: null });
  });

  test("signing in again keeps the same user and replaces the token", async () => {
    await completeSignIn();
    exchangeCode.mockResolvedValueOnce(signIn({ email: "sam.new@example.com", refreshToken: "refresh-token-2" }));
    await completeSignIn();

    const users = await db.select().from(schema.users);
    expect(users).toMatchObject([{ googleSub: "google-sam", email: "sam.new@example.com" }]);
    const tokens = await db.select().from(schema.oauthTokens);
    expect(tokens).toHaveLength(1);
    expect(decrypt(tokens[0]!.refreshTokenEncrypted, deriveKey(TOKEN_SECRET, "refresh-token"))).toBe(
      "refresh-token-2",
    );
  });

  test("two Google accounts become two users", async () => {
    await completeSignIn();
    exchangeCode.mockResolvedValueOnce(signIn({ sub: "google-alex", email: "alex@example.com" }));
    const alex = await completeSignIn();

    expect(await db.select().from(schema.users)).toHaveLength(2);
    expect((await me(alex.cookie)).json()).toMatchObject({ email: "alex@example.com" });
  });

  test("the session cookie is hidden from scripts, and Secure when served over HTTPS", async () => {
    const local = (await completeSignIn()).response.headers["set-cookie"] as string;
    expect(local).toMatch(/HttpOnly/i);
    expect(local).toMatch(/SameSite=Lax/i);
    expect(local).not.toMatch(/Secure/i);

    app = await testApp(db, oauth, { publicUrl: "https://joblert.example.com" });
    const hosted = (await start()).response.headers["set-cookie"] as string;
    expect(hosted).toMatch(/Secure/i);
  });
});

describe("sign-ins that must not succeed", () => {
  const expectRejected = async (response: { headers: Record<string, unknown> }, error: string) => {
    expect(response.headers.location).toBe(`${WEB_URL}?auth_error=${error}`);
    expect(await db.select().from(schema.users)).toEqual([]);
  };

  test("a state that doesn't match the one this browser was given", async () => {
    const { cookie } = await start();
    const response = await app.inject({
      method: "GET",
      url: "/auth/google/callback?code=the-code&state=forged",
      headers: { cookie },
    });
    await expectRejected(response, "failed");
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  test("a callback from a browser that never started a sign-in", async () => {
    const { state } = await start();
    const response = await app.inject({ method: "GET", url: `/auth/google/callback?code=the-code&state=${state}` });
    await expectRejected(response, "failed");
  });

  test("a state used a second time", async () => {
    const { cookie, state } = await start();
    const url = `/auth/google/callback?code=the-code&state=${state}`;
    const first = await app.inject({ method: "GET", url, headers: { cookie } });
    const replay = await app.inject({ method: "GET", url, headers: { cookie: cookieFrom(first) } });

    expect(replay.headers.location).toBe(`${WEB_URL}?auth_error=failed`);
    expect(exchangeCode).toHaveBeenCalledTimes(1);
  });

  test("the user cancelling at Google", async () => {
    const { cookie, state } = await start();
    const response = await app.inject({
      method: "GET",
      url: `/auth/google/callback?error=access_denied&state=${state}`,
      headers: { cookie },
    });
    await expectRejected(response, "denied");
  });

  test("the user leaving the Gmail permission unticked", async () => {
    exchangeCode.mockResolvedValueOnce(signIn({ scope: "openid email" }));
    await expectRejected((await completeSignIn()).response, "gmail_scope");
  });

  test("Google refusing the code", async () => {
    exchangeCode.mockRejectedValueOnce(new GoogleAuthError("invalid_grant", "code already used"));
    await expectRejected((await completeSignIn()).response, "failed");
  });
});

describe("sessions", () => {
  test("no cookie, or a made-up one, is not signed in", async () => {
    expect((await me()).statusCode).toBe(401);
    expect((await me("joblert_session=forged-value")).statusCode).toBe(401);
  });

  test("a cookie sealed with a different secret is not accepted", async () => {
    const { cookie } = await completeSignIn();
    const other = await testApp(db, oauth, { sessionSecret: "x".repeat(40) });
    expect((await other.inject({ method: "GET", url: "/api/me", headers: { cookie } })).statusCode).toBe(401);
  });

  test("logging out ends the session", async () => {
    const { cookie } = await completeSignIn();
    const logout = await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie } });

    expect(logout.statusCode).toBe(204);
    expect((await me(cookieFrom(logout))).statusCode).toBe(401);
  });

  test("a session for a deleted account is signed out", async () => {
    const { cookie } = await completeSignIn();
    await db.delete(schema.users);
    expect((await me(cookie)).statusCode).toBe(401);
  });

  test("the profile reports when Gmail needs reconnecting, and the last sync", async () => {
    const { cookie } = await completeSignIn();
    const [user] = await db.select().from(schema.users);
    const lastRunAt = new Date("2026-10-10T12:00:00Z");
    await db.insert(schema.syncState).values({ userId: user!.id, historyId: "1", lastRunAt });
    await db.delete(schema.oauthTokens).where(eq(schema.oauthTokens.userId, user!.id));

    expect((await me(cookie)).json()).toMatchObject({ gmailConnected: false, lastSyncAt: lastRunAt.toISOString() });
  });
});
