import { eq } from "drizzle-orm";
import { oauthTokens, users } from "../db/schema.ts";
import { GmailError, type GmailClient } from "../gmail/client.ts";
import { ClassifierError } from "./classify.ts";
import { pollUser, type IngestDeps } from "./ingest.ts";

/**
 * ok: the inbox is up to date.
 * running: a sync was already under way; it will run once more to pick up whatever prompted this one.
 * retry: stopped on something temporary (a rate limit, an outage); the same sync will work later.
 * disconnected: Google no longer accepts the stored token; the user has to sign in again.
 * failed: stopped on something a retry won't fix.
 */
export type SyncOutcome = "ok" | "running" | "retry" | "disconnected" | "failed";

export type SyncStart =
  | { status: "running" | "disconnected" }
  | { status: "started"; done: Promise<Exclude<SyncOutcome, "running" | "disconnected">> };

export interface SyncRunnerOptions extends IngestDeps {
  /** Pub/Sub topic Gmail publishes inbox changes to. Without one there are no push notifications. */
  topic?: string;
  /** How often every connected inbox is refreshed. */
  intervalMs?: number;
}

/** The one place a sync starts, so an inbox is never synced twice at once in this process. */
export interface SyncRunner {
  isRunning(userId: string): boolean;
  /** Starts a sync and returns as soon as it is under way; `done` settles when it ends and never rejects. */
  begin(userId: string, options?: { watch?: boolean }): Promise<SyncStart>;
  /** Syncs one inbox and reports how it went. Never rejects. */
  sync(userId: string): Promise<SyncOutcome>;
  /** Renews the Gmail watch, then syncs. Never rejects. */
  refresh(userId: string): Promise<SyncOutcome>;
  /** Refreshes every connected inbox, one after another. */
  refreshAll(): Promise<void>;
  /** Stops Gmail's notifications for an inbox, if push is in use. Never rejects. */
  unwatch(userId: string): Promise<void>;
  /** Refreshes every inbox now and then on a timer: a watch lasts a week, and a notification can go missing. */
  startTimer(): void;
  stopTimer(): void;
}

const HOUR_MS = 60 * 60 * 1000;

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createSyncRunner(options: SyncRunnerOptions): SyncRunner {
  const { topic, intervalMs = HOUR_MS, ...deps } = options;
  const running = new Set<string>();
  // Users whose inbox changed while their sync was running.
  const again = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let refreshing = false;

  async function once(userId: string, gmail: GmailClient) {
    try {
      const stats = await pollUser(deps, userId, gmail);
      deps.log?.("Sync finished", { userId, ...stats });
      return "ok" as const;
    } catch (error) {
      deps.log?.("Sync failed", { userId, error: describe(error) });
      if (error instanceof ClassifierError) return error.code === "unavailable" ? ("retry" as const) : ("failed" as const);
      if (error instanceof GmailError) return error.code === "failed" ? ("retry" as const) : ("failed" as const);
      return "failed" as const;
    }
  }

  async function begin(userId: string, { watch = false } = {}): Promise<SyncStart> {
    if (running.has(userId)) {
      again.add(userId);
      return { status: "running" };
    }
    running.add(userId);
    const release = () => {
      running.delete(userId);
      again.delete(userId);
    };

    let gmail: GmailClient | null;
    try {
      gmail = await deps.connect(userId);
    } catch (error) {
      release();
      throw error;
    }
    if (!gmail) {
      release();
      deps.log?.("Gmail access was revoked or has expired", { userId });
      return { status: "disconnected" };
    }

    const inbox = gmail;
    const run = async () => {
      if (watch && topic) {
        // A sync still works without the watch; the timer tries again.
        await inbox.watch(topic).catch((error) => deps.log?.("Could not watch the inbox", { userId, error: describe(error) }));
      }
      let outcome = await once(userId, inbox);
      // However many notifications arrived meanwhile, one more pass reads everything they announced.
      while (outcome === "ok" && again.delete(userId)) outcome = await once(userId, inbox);
      return outcome;
    };
    return { status: "started", done: run().finally(release) };
  }

  async function sync(userId: string, watch = false): Promise<SyncOutcome> {
    try {
      const start = await begin(userId, { watch });
      return start.status === "started" ? await start.done : start.status;
    } catch (error) {
      // Google could not be reached to open the inbox.
      deps.log?.("Sync could not start", { userId, error: describe(error) });
      return "retry";
    }
  }

  async function refreshAll() {
    // A slow pass must not pile up behind the next tick.
    if (refreshing) return;
    refreshing = true;
    try {
      const connected = await deps.db
        .select({ id: users.id })
        .from(users)
        .innerJoin(oauthTokens, eq(oauthTokens.userId, users.id));
      for (const { id } of connected) await sync(id, true);
    } catch (error) {
      deps.log?.("Could not refresh inboxes", { error: describe(error) });
    } finally {
      refreshing = false;
    }
  }

  return {
    isRunning: (userId) => running.has(userId),
    begin,
    sync: (userId) => sync(userId),
    refresh: (userId) => sync(userId, true),
    refreshAll,

    async unwatch(userId) {
      if (!topic) return;
      try {
        await (await deps.connect(userId))?.stopWatch();
      } catch (error) {
        deps.log?.("Could not stop watching the inbox", { userId, error: describe(error) });
      }
    },

    startTimer() {
      if (timer) return;
      void refreshAll();
      timer = setInterval(() => void refreshAll(), intervalMs);
      timer.unref();
    },

    stopTimer() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}
