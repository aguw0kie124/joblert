import { expect, test } from "vitest";
import { sslOptions } from "../src/db/client.ts";

test.each(["localhost", "127.0.0.1", "[::1]"])("no TLS for a local database on %s", (host) => {
  expect(sslOptions(`postgresql://u:p@${host}:5432/db`)).toBe(false);
});

test("hosted databases are encrypted, unverified unless a CA is given", () => {
  expect(sslOptions("postgresql://u:p@db.example.com:5432/db")).toEqual({ rejectUnauthorized: false });
});

test("a CA certificate turns on verification", () => {
  const ca = new URL("./fixtures/test-ca.pem", import.meta.url).pathname;
  expect(sslOptions("postgresql://u:p@db.example.com:5432/db", ca)).toEqual({ ca: "-----TEST CA-----\n" });
});
