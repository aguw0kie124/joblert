import { expect, test, vi } from "vitest";
import { verifyGroqKey } from "../src/pipeline/groqClient.ts";

const answering = (status: number) => vi.fn<typeof fetch>(async () => new Response("{}", { status }));

test.each([
  [200, "ok"],
  [401, "invalid"],
  [403, "invalid"],
  [429, "unavailable"],
  [500, "unavailable"],
] as const)("a key check answered with HTTP %i is %s", async (status, check) => {
  expect(await verifyGroqKey("gsk_x", answering(status))).toBe(check);
});

test("a key check that can't reach Groq is unavailable, and sends the key as a bearer token", async () => {
  const offline = vi.fn<typeof fetch>(async () => {
    throw new Error("offline");
  });
  expect(await verifyGroqKey("gsk_x", offline)).toBe("unavailable");
  expect(offline.mock.calls[0]![1]).toMatchObject({
    headers: { Authorization: "Bearer gsk_x" },
  });
});
