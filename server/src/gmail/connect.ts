import { eq } from "drizzle-orm";
import { GoogleAuthError, type GoogleOAuth } from "../auth/google.ts";
import { decrypt } from "../auth/secrets.ts";
import type { Db } from "../db/client.ts";
import { oauthTokens } from "../db/schema.ts";
import { createGmailClient, type GmailClient } from "./client.ts";

export interface GmailConnectorOptions {
  db: Db;
  oauth: GoogleOAuth;
  tokenKey: Buffer;
  fetch?: typeof fetch;
}

/** Opens a user's inbox, or returns null when they have to sign in again. */
export type GmailConnector = (userId: string) => Promise<GmailClient | null>;

export function createGmailConnector({ db, oauth, tokenKey, fetch }: GmailConnectorOptions): GmailConnector {
  return async (userId) => {
    const [token] = await db.select().from(oauthTokens).where(eq(oauthTokens.userId, userId));
    if (!token) return null;

    try {
      const accessToken = await oauth.refreshAccessToken(decrypt(token.refreshTokenEncrypted, tokenKey));
      return createGmailClient({ accessToken, fetch });
    } catch (error) {
      // Access was revoked or expired. Dropping the dead token is what makes the app ask the user to reconnect.
      if (error instanceof GoogleAuthError && error.code === "invalid_grant") {
        await db.delete(oauthTokens).where(eq(oauthTokens.userId, userId));
        return null;
      }
      throw error;
    }
  };
}
