import { describe, expect, test } from "vitest";
import { loadConfig, publicUrl, pubsubConfig, requireConfig } from "../src/config.ts";

const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };

test("blank values count as unset and defaults apply", () => {
  const config = loadConfig({ ...base, GROQ_API_KEY: "", PORT: "" });
  expect(config.GROQ_API_KEY).toBeUndefined();
  expect(config).toMatchObject({ PORT: 3000, AUTO_APPLY_CONFIDENCE: 0.85 });
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
describe("pubsubConfig", () => {
  const topic = "projects/joblert/topics/gmail";
  const token = "p".repeat(40);
  const config = (env: Record<string, string>) => loadConfig({ ...base, ...env });

  test("is off when neither setting is present", () => {
    expect(pubsubConfig(config({}))).toBeUndefined();
  });

  test("returns the topic and token when both are set", () => {
    expect(pubsubConfig(config({ GMAIL_PUBSUB_TOPIC: topic, PUBSUB_TOKEN: token }))).toEqual({ topic, token });
  });

  test("refuses half a configuration", () => {
    expect(() => pubsubConfig(config({ GMAIL_PUBSUB_TOPIC: topic }))).toThrow(/both/);
    expect(() => pubsubConfig(config({ PUBSUB_TOKEN: token }))).toThrow(/both/);
  });

  test("refuses a topic that is not a full Pub/Sub name, and a short token", () => {
    expect(() => config({ GMAIL_PUBSUB_TOPIC: "gmail" })).toThrow();
    expect(() => config({ PUBSUB_TOKEN: "short" })).toThrow();
  });
});


describe("pubsubConfig", () => {
  const topic = "projects/joblert/topics/gmail";
  const token = "p".repeat(40);
  const config = (env: Record<string, string>) => loadConfig({ ...base, ...env });

  test("is off when neither setting is present", () => {
    expect(pubsubConfig(config({}))).toBeUndefined();
  });

  test("returns the topic and token when both are set", () => {
    expect(pubsubConfig(config({ GMAIL_PUBSUB_TOPIC: topic, PUBSUB_TOKEN: token }))).toEqual({ topic, token });
  });

  test("refuses half a configuration", () => {
    expect(() => pubsubConfig(config({ GMAIL_PUBSUB_TOPIC: topic }))).toThrow(/both/);
    expect(() => pubsubConfig(config({ PUBSUB_TOKEN: token }))).toThrow(/both/);
  });

  test("refuses a topic that is not a full Pub/Sub name, and a short token", () => {
    expect(() => config({ GMAIL_PUBSUB_TOPIC: "gmail" })).toThrow();
    expect(() => config({ PUBSUB_TOKEN: "short" })).toThrow();
  });
});
