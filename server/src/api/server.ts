import { createGoogleOAuth } from "../auth/google.ts";
import { loadConfig, publicUrl, requireConfig } from "../config.ts";
import { createDb } from "../db/client.ts";
import { buildApp } from "./app.ts";

const config = requireConfig(loadConfig(), [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "SESSION_SECRET",
  "TOKEN_ENCRYPTION_KEY",
]);
const { db, pool } = createDb(config);
const baseUrl = publicUrl(config);

const app = await buildApp({
  db,
  oauth: createGoogleOAuth({
    clientId: config.GOOGLE_CLIENT_ID,
    clientSecret: config.GOOGLE_CLIENT_SECRET,
    redirectUri: `${baseUrl}/auth/google/callback`,
  }),
  sessionSecret: config.SESSION_SECRET,
  tokenEncryptionKey: config.TOKEN_ENCRYPTION_KEY,
  publicUrl: baseUrl,
  webUrl: config.WEB_URL ?? baseUrl,
  logger: true,
});

app.addHook("onClose", async () => {
  await pool.end();
});

await app.listen({ port: config.PORT, host: "0.0.0.0" });
