import { z } from "zod";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const SCOPES = ["openid", "email", GMAIL_SCOPE];

/**
 * invalid_grant: the code or refresh token is no longer valid (revoked, expired, or already used).
 * failed: anything else; the request may succeed if retried.
 */
export type GoogleAuthErrorCode = "invalid_grant" | "failed";

export class GoogleAuthError extends Error {
  readonly code: GoogleAuthErrorCode;

  constructor(code: GoogleAuthErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GoogleAuthError";
    this.code = code;
  }
}

export interface GoogleSignIn {
  /** Google's stable account id. */
  sub: string;
  email: string;
  /** Null when Google did not issue one; it only does so when consent is granted. */
  refreshToken: string | null;
  /** Space-separated scopes the user actually granted, which can be fewer than requested. */
  scope: string;
}

export interface GoogleOAuth {
  authUrl(state: string): string;
  exchangeCode(code: string): Promise<GoogleSignIn>;
  refreshAccessToken(refreshToken: string): Promise<string>;
  /** Withdraws the app's access to the account. Revoking an already-dead token is not an error. */
  revokeToken(refreshToken: string): Promise<void>;
}

export interface GoogleOAuthOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: typeof fetch;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().default(""),
  id_token: z.string().optional(),
});

const idTokenSchema = z.object({
  aud: z.string(),
  sub: z.string().min(1),
  email: z.email(),
  email_verified: z.boolean(),
});

// The ID token arrives straight from Google's token endpoint over TLS, so its signature is not re-checked.
function readIdToken(idToken: string, clientId: string) {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch (error) {
    throw new GoogleAuthError("failed", "Google returned an unreadable ID token", { cause: error });
  }
  const claims = idTokenSchema.safeParse(payload);
  if (!claims.success) throw new GoogleAuthError("failed", "Google's ID token is missing account details");
  if (claims.data.aud !== clientId) throw new GoogleAuthError("failed", "ID token was issued for a different app");
  if (!claims.data.email_verified) throw new GoogleAuthError("failed", "Google account email is not verified");
  return claims.data;
}

export const hasGmailScope = (scope: string) => scope.split(" ").includes(GMAIL_SCOPE);

export function createGoogleOAuth(options: GoogleOAuthOptions): GoogleOAuth {
  const fetchImpl = options.fetch ?? fetch;

  async function requestToken(params: Record<string, string>) {
    let response: Response;
    try {
      response = await fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          ...params,
        }),
      });
    } catch (error) {
      throw new GoogleAuthError("failed", "Could not reach Google's token endpoint", { cause: error });
    }

    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = z.object({ error: z.string() }).safeParse(body);
      const code = error.success && error.data.error === "invalid_grant" ? "invalid_grant" : "failed";
      throw new GoogleAuthError(code, `Google token request failed (HTTP ${response.status})`);
    }
    const parsed = tokenResponseSchema.safeParse(body);
    if (!parsed.success) throw new GoogleAuthError("failed", "Google's token response was not understood");
    return parsed.data;
  }

  return {
    authUrl(state) {
      const params = new URLSearchParams({
        client_id: options.clientId,
        redirect_uri: options.redirectUri,
        response_type: "code",
        scope: SCOPES.join(" "),
        state,
        // Offline access plus a forced consent screen is what makes Google issue a refresh token every time.
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
      });
      return `${AUTH_URL}?${params}`;
    },

    async exchangeCode(code) {
      const tokens = await requestToken({
        code,
        grant_type: "authorization_code",
        redirect_uri: options.redirectUri,
      });
      if (!tokens.id_token) throw new GoogleAuthError("failed", "Google did not return an ID token");
      const claims = readIdToken(tokens.id_token, options.clientId);
      return {
        sub: claims.sub,
        email: claims.email.toLowerCase(),
        refreshToken: tokens.refresh_token ?? null,
        scope: tokens.scope,
      };
    },

    async refreshAccessToken(refreshToken) {
      const tokens = await requestToken({ refresh_token: refreshToken, grant_type: "refresh_token" });
      return tokens.access_token;
    },

    async revokeToken(refreshToken) {
      let response: Response;
      try {
        response = await fetchImpl(REVOKE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: refreshToken }),
        });
      } catch (error) {
        throw new GoogleAuthError("failed", "Could not reach Google's revoke endpoint", { cause: error });
      }
      // 400 is Google's answer for a token that is already invalid, which is the state we wanted.
      if (!response.ok && response.status !== 400) {
        throw new GoogleAuthError("failed", `Google revoke request failed (HTTP ${response.status})`);
      }
    },
  };
}
