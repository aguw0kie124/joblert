import { z } from "zod";
import type { GmailMessage } from "./parser.ts";

const BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";
const PAGE_SIZE = 500;
const MAX_RETRIES = 3;

/**
 * history_expired: the stored cursor is too old for Gmail to replay; fall back to a dated search.
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
  /** Ids matching a Gmail search query, newest first. */
  listMessageIds(query: string): Promise<string[]>;
  /** The full message, or null if it no longer exists. */
  getMessage(id: string): Promise<GmailMessage | null>;
}

export interface GmailClientOptions {
  accessToken: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
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

const listSchema = z.object({
  messages: z.array(z.object({ id: z.string() })).optional(),
  nextPageToken: z.string().optional(),
});

const messageSchema = z.looseObject({ id: z.string(), threadId: z.string() });

// Mail the user wrote, or that Gmail has already set aside.
const SKIPPED_LABELS = new Set(["SENT", "DRAFT", "CHAT", "SPAM", "TRASH"]);

export const hasSkippedLabel = (labelIds: readonly string[] | null | undefined) =>
  labelIds?.some((label) => SKIPPED_LABELS.has(label)) ?? false;

export function createGmailClient(options: GmailClientOptions): GmailClient {
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  /** Returns null on 404; callers decide what a missing resource means. */
  async function get(path: string, params: Record<string, string | undefined> = {}): Promise<unknown> {
    const url = new URL(`${BASE_URL}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetchImpl(url, { headers: { Authorization: `Bearer ${options.accessToken}` } });
      } catch (error) {
        if (attempt >= MAX_RETRIES) throw new GmailError("failed", "Gmail request failed", { cause: error });
        await sleep(1000 * 2 ** attempt);
        continue;
      }

      if (response.ok) return response.json();
      if (response.status === 404) return null;
      if (response.status === 401) throw new GmailError("auth", "Gmail rejected the access token");

      // 403 is how Gmail reports per-user rate limits as well as real permission errors.
      const retryable = response.status === 429 || response.status === 403 || response.status >= 500;
      if (!retryable || attempt >= MAX_RETRIES) {
        const code = response.status === 403 ? "auth" : "failed";
        throw new GmailError(code, `Gmail returned HTTP ${response.status} for ${path.split("/")[1]}`);
      }
      await sleep(1000 * 2 ** attempt);
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

    async listMessageIds(query) {
      const ids: string[] = [];
      let pageToken: string | undefined;
      do {
        const body = await get("/messages", { q: query, maxResults: String(PAGE_SIZE), pageToken });
        const page = parse(listSchema, body, "message list");
        for (const message of page.messages ?? []) ids.push(message.id);
        pageToken = page.nextPageToken;
      } while (pageToken);
      return ids;
    },

    async getMessage(id) {
      const body = await get(`/messages/${encodeURIComponent(id)}`, { format: "full" });
      if (body === null) return null;
      return parse(messageSchema, body, "message") as GmailMessage;
    },
  };
}
