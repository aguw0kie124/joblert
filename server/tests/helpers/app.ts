import type { FastifyInstance } from "fastify";
import { vi } from "vitest";
import { buildApp, type AppOptions } from "../../src/api/app.ts";
import { GMAIL_SCOPE, type GoogleOAuth, type GoogleSignIn } from "../../src/auth/google.ts";
import { saveGroqKey } from "../../src/auth/groqKeys.ts";
import { deriveKey } from "../../src/auth/secrets.ts";
import type { Classifier } from "../../src/pipeline/classify.ts";
import type { Triager } from "../../src/pipeline/triage.ts";
import type { TestDb } from "./db.ts";

export const TOKEN_SECRET = "t".repeat(40);
export const WEB_URL = "http://localhost:5173";
export const PUBSUB = {
  topic: "projects/joblert/topics/gmail",
  token: "p".repeat(40),
};

export const googleSignIn = (overrides: Partial<GoogleSignIn> = {}): GoogleSignIn => ({
  sub: "google-sam",
  email: "sam@example.com",
  refreshToken: "refresh-token-1",
  scope: `openid email ${GMAIL_SCOPE}`,
  ...overrides,
});

/** A stand-in for Google. Every method is a mock, so tests can inspect calls or queue other answers. */
export function fakeOAuth() {
  return {
    authUrl: (state: string) => `https://accounts.google.test/auth?state=${state}`,
    exchangeCode: vi.fn<GoogleOAuth["exchangeCode"]>(async () => googleSignIn()),
    refreshAccessToken: vi.fn<GoogleOAuth["refreshAccessToken"]>(async () => "access-token"),
    revokeToken: vi.fn<GoogleOAuth["revokeToken"]>(async () => {}),
  } satisfies GoogleOAuth;
}

export type FakeOAuth = ReturnType<typeof fakeOAuth>;

/** What a test reads mail with. One classifier and triager stand in for every user's Groq key. */
export interface TestIngest extends Pick<AppOptions["ingest"], "connect" | "threshold" | "now"> {
  classifier?: Classifier;
  triager?: Triager;
}

export type TestAppOptions = Omit<Partial<AppOptions>, "ingest"> & {
  ingest?: TestIngest;
};

export function testApp(db: TestDb, oauth: GoogleOAuth, { ingest, ...overrides }: TestAppOptions = {}) {
  const {
    classifier = {
      classify: async () => Promise.reject(new Error("no classifier in this test")),
    },
    triager = {
      triage: async () => Promise.reject(new Error("no triage in this test")),
    },
    ...rest
  } = ingest ?? { connect: async () => null, threshold: 0.85 };
  return buildApp({
    db,
    oauth,
    sessionSecret: "s".repeat(40),
    tokenEncryptionKey: TOKEN_SECRET,
    publicUrl: "http://localhost:3000",
    webUrl: WEB_URL,
    ingest: { ...rest, models: () => ({ classifier, triager }) },
    verifyGroqKey: async () => "ok",
    ...overrides,
  });
}

/** Stores a Groq key for a user directly, as if they had saved it on the setup screen. */
export function giveGroqKey(db: TestDb, userId: string, key = "gsk_test_key") {
  return saveGroqKey(db, deriveKey(TOKEN_SECRET, "groq-key"), userId, key);
}

/** The session cookie from a response, in the form a browser would send back. */
export function cookieFrom(response: { cookies: { name: string; value: string }[] }): string {
  const cookie = response.cookies.find((c) => c.name === "joblert_session");
  return cookie ? `${cookie.name}=${encodeURIComponent(cookie.value)}` : "";
}

/** Starts a sign-in the way a browser would, returning the cookie and the state Google would echo back. */
export async function startSignIn(app: FastifyInstance) {
  const response = await app.inject({ method: "GET", url: "/auth/google" });
  const state = new URL(response.headers.location as string).searchParams.get("state")!;
  return { cookie: cookieFrom(response), state, response };
}

/** Runs the whole sign-in. Whatever `oauth.exchangeCode` answers next decides who is signed in. */
export async function completeSignIn(app: FastifyInstance) {
  const { cookie, state } = await startSignIn(app);
  const response = await app.inject({
    method: "GET",
    url: `/auth/google/callback?code=the-code&state=${state}`,
    headers: { cookie },
  });
  return { response, cookie: cookieFrom(response) };
}
