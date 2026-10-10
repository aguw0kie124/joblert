import { expect, test } from "vitest";
import { loadConfig, publicUrl, requireConfig } from "../src/config.ts";

const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };

test("blank values count as unset and defaults apply", () => {
  const config = loadConfig({ ...base, GROQ_API_KEY: "", PORT: "" });
  expect(config.GROQ_API_KEY).toBeUndefined();
  expect(config).toMatchObject({ PORT: 3000, AUTO_APPLY_CONFIDENCE: 0.85, BACKFILL_DAYS: 90 });
});

test("requireConfig names every missing variable at once", () => {
  const config = loadConfig({ ...base, SESSION_SECRET: "x" });
  expect(() => requireConfig(config, ["SESSION_SECRET", "GOOGLE_CLIENT_ID", "TOKEN_ENCRYPTION_KEY"])).toThrow(
    "GOOGLE_CLIENT_ID, TOKEN_ENCRYPTION_KEY",
  );
  expect(requireConfig(config, ["SESSION_SECRET"]).SESSION_SECRET).toBe("x");
});

test("the public URL defaults to localhost on the configured port", () => {
  expect(publicUrl(loadConfig({ ...base, PORT: "4000" }))).toBe("http://localhost:4000");
  expect(publicUrl(loadConfig({ ...base, PUBLIC_URL: "https://joblert.example.com/" }))).toBe(
    "https://joblert.example.com",
  );
});
