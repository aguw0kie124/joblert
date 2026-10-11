import { z } from "zod";
import type { GmailMessage } from "./parser.ts";

const BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";
const PAGE_SIZE = 500;
// Server errors and dropped connections.
const MAX_RETRIES = 5;
// Gmail's per-user quota refills every minute, so a rate limit is waited out rather than treated as a failure.
const RATE_LIMIT_WAITS_MS = [2000, 4000, 8000, 15_000, 30_000, 30_000, 30_000, 30_000, 60_000, 60_000];
// The gap between requests starts here, doubles whenever Gmail pushes back, and creeps down while it doesn't.
// The quota Gmail enforces varies by project and is not reported, so the client finds it by feel.
const START_INTERVAL_MS = 100;
const MIN_INTERVAL_MS = 50;
const MAX_INTERVAL_MS = 2000;
const SPEED_UP = 0.98;

/**
 * history_expired: the stored cursor is too old for Gmail to replay.
 * auth: the access token was rejected.
 * failed: anything else, after retries.
 */
export type GmailErrorCode = "history_expired" | "auth" | "failed";

export class GmailError extends Error {
  readonly code: GmailErrorCode;

  constructor(code: GmailErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GmailError";
    this.code = code;
  }
}

export interface GmailClient {
  /** The mailbox's current position; a cursor taken now covers everything that arrives afterwards. */
  getHistoryId(): Promise<string>;
  /** Ids of messages added after `historyId`, oldest first, and the cursor to store for next time. */
  listAddedSince(historyId: string): Promise<{ messageIds: string[]; historyId: string }>;
  /** The full message, or null if it no longer exists. */
  getMessage(id: string): Promise<GmailMessage | null>;
}

export interface GmailClientOptions {
  accessToken: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Space requests out and adapt to rate limits. On by default; tests turn it off. */
  pace?: boolean;
}

const profileSchema = z.object({ historyId: z.string() });

const historySchema = z.object({
  history: z
    .array(
      z.object({
        messagesAdded: z
          .array(z.object({ message: z.object({ id: z.string(), labelIds: z.array(z.string()).optional() }) }))
          .optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
  historyId: z.string(),
});

const messageSchema = z.looseObject({ id: z.string(), threadId: z.string() });

// Mail the user wrote, or that Gmail has already set aside.
const SKIPPED_LABELS = new Set(["SENT", "DRAFT", "CHAT", "SPAM", "TRASH"]);

const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

const errorSchema = z.object({ error: z.object({ errors: z.array(z.object({ reason: z.string() })).min(1) }) });

/** Google's machine-readable reason for an error response, or "" when there isn't one. */
async function errorReason(response: Response): Promise<string> {
  const parsed = errorSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.error.errors[0]!.reason : "";
}

export const hasSkippedLabel = (labelIds: readonly string[] | null | undefined) =>
  labelIds?.some((label) => SKIPPED_LABELS.has(label)) ?? false;

export function createGmailClient(options: GmailClientOptions): GmailClient {
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const pace = options.pace ?? true;
  let intervalMs = START_INTERVAL_MS;
  let nextSlot = 0;

  /** Spaces requests out: each caller takes the next free slot and waits for it. */
  async function throttle() {
    if (!pace) return;
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + intervalMs;
    if (slot > now) await sleep(slot - now);
  }

  /** Returns null on 404; callers decide what a missing resource means. */
  async function get(path: string, params: Record<string, string | undefined> = {}): Promise<unknown> {
    const url = new URL(`${BASE_URL}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    let failures = 0;
    let rateLimits = 0;
    for (;;) {
      await throttle();
      let response: Response;
      try {
        response = await fetchImpl(url, { headers: { Authorization: `Bearer ${options.accessToken}` } });
      } catch (error) {
        if (failures >= MAX_RETRIES) throw new GmailError("failed", "Gmail request failed", { cause: error });
        await sleep(1000 * 2 ** failures++);
        continue;
      }

      if (response.ok) {
        intervalMs = Math.max(MIN_INTERVAL_MS, intervalMs * SPEED_UP);
        return response.json();
      }
      if (response.status === 404) return null;
      if (response.status === 401) throw new GmailError("auth", "Gmail rejected the access token");

      // 403 covers both rate limits, which pass, and permission problems, which don't.
      const reason = await errorReason(response);
      const what = path.split("/")[1];

      if (response.status === 429 || (response.status === 403 && RATE_LIMIT_REASONS.has(reason))) {
        const wait = RATE_LIMIT_WAITS_MS[rateLimits++];
        if (wait === undefined) throw new GmailError("failed", `Gmail kept rate limiting ${what} requests`);
        intervalMs = Math.min(MAX_INTERVAL_MS, intervalMs * 2);
        await sleep(wait);
        continue;
      }

      if (response.status >= 500 && failures < MAX_RETRIES) {
        await sleep(1000 * 2 ** failures++);
        continue;
      }

      const detail =
        reason === "accessNotConfigured"
          ? ": the Gmail API is not enabled in the Google Cloud project"
          : reason && `: ${reason}`;
      const code = response.status === 403 ? "auth" : "failed";
      throw new GmailError(code, `Gmail returned HTTP ${response.status} for ${what}${detail}`);
    }
  }

  function parse<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new GmailError("failed", `Gmail's ${what} response was not understood`);
    return parsed.data;
  }

  return {
    async getHistoryId() {
      return parse(profileSchema, await get("/profile"), "profile").historyId;
    },

    async listAddedSince(historyId) {
      const ids = new Set<string>();
      let latest = historyId;
      let pageToken: string | undefined;
      do {
        const body = await get("/history", {
          startHistoryId: historyId,
          historyTypes: "messageAdded",
          maxResults: String(PAGE_SIZE),
          pageToken,
        });
        if (body === null) throw new GmailError("history_expired", "Gmail no longer has history for this cursor");

        const page = parse(historySchema, body, "history");
        for (const record of page.history ?? []) {
          for (const added of record.messagesAdded ?? []) {
            if (!hasSkippedLabel(added.message.labelIds)) ids.add(added.message.id);
          }
        }
        latest = page.historyId;
        pageToken = page.nextPageToken;
      } while (pageToken);
      return { messageIds: [...ids], historyId: latest };
    },

    async getMessage(id) {
      const body = await get(`/messages/${encodeURIComponent(id)}`, { format: "full" });
      if (body === null) return null;
      return parse(messageSchema, body, "message") as GmailMessage;
    },
  };
}
