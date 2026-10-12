import { expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";

test("stray whitespace around a pasted value is ignored, and blank values count as unset", () => {
  const config = loadConfig({
    DATABASE_URL: " postgresql://u:p@localhost:5432/db\n",
    GOOGLE_CLIENT_SECRET: "secret-value \n",
    GROQ_API_KEY: "   ",
  });
  expect(config.DATABASE_URL).toBe("postgresql://u:p@localhost:5432/db");
  expect(config.GOOGLE_CLIENT_SECRET).toBe("secret-value");
  expect(config.GROQ_API_KEY).toBeUndefined();
});
