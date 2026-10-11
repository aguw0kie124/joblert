import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { applications, emails, events, oauthTokens, reviewItems, syncState, users } from "../db/schema.ts";
import { GmailError, hasSkippedLabel, type GmailClient } from "../gmail/client.ts";
import type { GmailConnector } from "../gmail/connect.ts";
import { filterEmail, isAtsDomain } from "../gmail/filters.ts";
import { parseMessage, type GmailMessage, type ParsedEmail } from "../gmail/parser.ts";
import type { ProcessedState, ReviewReason, Status } from "../status.ts";
import { ClassifierError, type Classification, type Classifier } from "./classify.ts";
import { domainLabel, emailDomain } from "./company.ts";
import { matchEmail, type MatchCandidate } from "./match.ts";
import { decideTransition } from "./stateMachine.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
// How many messages to download at once. The Gmail client paces the requests themselves.
const FETCH_CONCURRENCY = 5;
const ID_QUERY_CHUNK = 500;

export interface PollStats {
  /** Messages downloaded from Gmail. */
  fetched: number;
  /** Of those, how many passed the prefilter and were stored. */
  relevant: number;
  created: number;
  updated: number;
  recorded: number;
  review: number;
  ignored: number;
  /** Stored for a later run because the classifier was unavailable. */
  deferred: number;
  failed: number;
}

export type PollResult =
  | { userId: string; status: "ok"; stats: PollStats }
  /** Google no longer accepts the stored token; the user has to sign in again. */
  | { userId: string; status: "disconnected" }
  | { userId: string; status: "failed"; error: string };

export interface IngestDeps {
  db: Db;
  classifier: Classifier;
  connect: GmailConnector;
  /** Classifications below this confidence go to the review queue. */
  threshold: number;
  backfillDays: number;
  log?: (message: string, data?: Record<string, unknown>) => void;
  now?: () => Date;
}

interface KnownApplication extends MatchCandidate {
  status: Status;
}

export type Outcome =
  | { type: "ignore" }
  | { type: "create"; company: string; role: string }
  | { type: "change"; applicationId: string; from: Status; to: Status }
  | { type: "record"; applicationId: string }
  | { type: "review"; reason: ReviewReason; candidateIds: string[] };

type Disposition = Outcome | { type: "defer" } | { type: "fail" };

/** What one classified email does to the tracker. Pure: the caller supplies the user's applications. */
export function decideOutcome(
  classification: Classification,
  email: Pick<ParsedEmail, "threadId" | "senderEmail" | "receivedAt">,
  known: readonly KnownApplication[],
  threshold: number,
): Outcome {
  if (!classification.jobRelated) return { type: "ignore" };

  const { kind, confidence } = classification;
  const match = matchEmail(
    {
      threadId: email.threadId,
      senderEmail: email.senderEmail,
      company: classification.company,
      role: classification.role,
      receivedAt: email.receivedAt,
    },
    known,
  );

  // Mail that reports no stage is only worth keeping when it clearly belongs to an application.
  if (kind === "other") {
    return match.type === "match" ? { type: "record", applicationId: match.applicationId } : { type: "ignore" };
  }

  if (match.type === "ambiguous") {
    return { type: "review", reason: "ambiguous_match", candidateIds: match.candidates.map((c) => c.applicationId) };
  }

  if (match.type === "match") {
    const application = known.find((a) => a.id === match.applicationId)!;
    const transition = decideTransition({ current: application.status, kind, confidence, threshold });
    switch (transition.action) {
      case "change":
        return { type: "change", applicationId: application.id, from: application.status, to: transition.to };
      case "record":
        return { type: "record", applicationId: application.id };
      case "review":
        return { type: "review", reason: transition.reason, candidateIds: [application.id] };
    }
  }

  if (confidence < threshold) return { type: "review", reason: "low_confidence", candidateIds: [] };
  if (kind === "applied" && classification.company) {
    return { type: "create", company: classification.company, role: classification.role ?? "" };
  }
  // A later-stage email for an application the tracker never saw, or a confirmation that names no company.
  return { type: "review", reason: "no_match", candidateIds: [] };
}

const PROCESSED_STATE: Record<Disposition["type"], ProcessedState> = {
  ignore: "ignored",
  create: "processed",
  change: "processed",
  record: "processed",
  review: "needs_review",
  defer: "pending",
  fail: "failed",
};

const STAT: Record<Disposition["type"], keyof PollStats> = {
  ignore: "ignored",
  create: "created",
  change: "updated",
  record: "recorded",
  review: "review",
  defer: "deferred",
  fail: "failed",
};

const emptyStats = (): PollStats => ({
  fetched: 0,
  relevant: 0,
  created: 0,
  updated: 0,
  recorded: 0,
  review: 0,
  ignored: 0,
  deferred: 0,
  failed: 0,
});

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const messageTime = (message: GmailMessage) => Number(message.internalDate) || 0;

// Sent mail and chats are also dropped by label after fetching; excluding them here just saves requests.
const searchSince = (since: Date) => `after:${Math.floor(since.getTime() / 1000)} -in:sent -in:chats -in:drafts`;

class UserPoll {
  readonly stats = emptyStats();
  private known: KnownApplication[] = [];
  // Set on the first rate limit or outage, so the rest of the run stops calling the classifier.
  private classifierDown = false;

  constructor(
    private readonly deps: IngestDeps,
    private readonly userId: string,
    private readonly gmail: GmailClient,
  ) {}

  private get db() {
    return this.deps.db;
  }

  async run(): Promise<PollStats> {
    this.known = await this.loadApplications();
    await this.retryDeferred();

    const { messageIds, cursor } = await this.listNewMessages();
    for (const batch of chunks(await this.withoutStored(messageIds), FETCH_CONCURRENCY)) {
      const fetched = await Promise.all(batch.map((id) => this.gmail.getMessage(id)));
      const messages = fetched.filter((m): m is GmailMessage => m !== null && !hasSkippedLabel(m.labelIds));
      this.stats.fetched += messages.length;

      // Oldest first, so a confirmation creates the application before its rejection arrives.
      messages.sort((a, b) => messageTime(a) - messageTime(b));
      for (const message of messages) await this.ingest(message);
    }

    // Saved only once every message is stored; a run that dies earlier starts from the same place.
    const lastRunAt = this.now();
    await this.db
      .insert(syncState)
      .values({ userId: this.userId, historyId: cursor, lastRunAt })
      .onConflictDoUpdate({ target: syncState.userId, set: { historyId: cursor, lastRunAt } });

    return this.stats;
  }

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async loadApplications(): Promise<KnownApplication[]> {
    const rows = await this.db
      .select({
        id: applications.id,
        company: applications.company,
        role: applications.role,
        appliedAt: applications.appliedAt,
        status: applications.status,
      })
      .from(applications)
      .where(eq(applications.userId, this.userId));

    const linked = await this.db
      .selectDistinct({ applicationId: emails.applicationId, threadId: emails.threadId })
      .from(emails)
      .where(and(eq(emails.userId, this.userId), isNotNull(emails.applicationId)));

    const threads = new Map<string, string[]>();
    for (const { applicationId, threadId } of linked) {
      threads.set(applicationId!, [...(threads.get(applicationId!) ?? []), threadId]);
    }
    return rows.map((row) => ({ ...row, threadIds: threads.get(row.id) ?? [] }));
  }

  /** Ids to look at this run, oldest first, and the cursor that will cover everything after them. */
  private async listNewMessages(): Promise<{ messageIds: string[]; cursor: string }> {
    const [state] = await this.db.select().from(syncState).where(eq(syncState.userId, this.userId));
    let since = new Date(this.now().getTime() - this.deps.backfillDays * DAY_MS);

    if (state?.historyId) {
      try {
        const { messageIds, historyId } = await this.gmail.listAddedSince(state.historyId);
        return { messageIds, cursor: historyId };
      } catch (error) {
        if (!(error instanceof GmailError && error.code === "history_expired")) throw error;
        this.deps.log?.("Gmail history cursor expired; searching by date instead", { userId: this.userId });
        // Overlap by a day; messages already stored are skipped anyway.
        if (state.lastRunAt) since = new Date(Math.max(since.getTime(), state.lastRunAt.getTime() - DAY_MS));
      }
    }

    // Read the cursor before searching, so mail that arrives during the search is picked up next run.
    const cursor = await this.gmail.getHistoryId();
    const newestFirst = await this.gmail.listMessageIds(searchSince(since));
    return { messageIds: newestFirst.reverse(), cursor };
  }

  private async withoutStored(messageIds: readonly string[]): Promise<string[]> {
    const stored = new Set<string>();
    for (const batch of chunks(messageIds, ID_QUERY_CHUNK)) {
      const rows = await this.db
        .select({ gmailMessageId: emails.gmailMessageId })
        .from(emails)
        .where(and(eq(emails.userId, this.userId), inArray(emails.gmailMessageId, batch)));
      for (const row of rows) stored.add(row.gmailMessageId);
    }
    return messageIds.filter((id) => !stored.has(id));
  }

  /** Emails a previous run could not classify. Bodies are never stored, so each is fetched again. */
  private async retryDeferred() {
    const deferred = await this.db
      .select({ id: emails.id, gmailMessageId: emails.gmailMessageId })
      .from(emails)
      .where(and(eq(emails.userId, this.userId), eq(emails.processedState, "pending")))
      .orderBy(asc(emails.receivedAt));

    for (const row of deferred) {
      if (this.classifierDown) return;
      const message = await this.gmail.getMessage(row.gmailMessageId);
      if (message) {
        await this.ingest(message, row.id);
      } else {
        await this.db.update(emails).set({ processedState: "ignored" }).where(eq(emails.id, row.id));
        this.stats.ignored++;
      }
    }
  }

  /** `storedEmailId` is set when retrying an email that already has a row. */
  private async ingest(message: GmailMessage, storedEmailId?: string) {
    let email: ParsedEmail;
    try {
      email = parseMessage(message);
    } catch (error) {
      this.deps.log?.("Skipped a message that could not be parsed", { userId: this.userId, messageId: message.id });
      this.stats.failed++;
      if (storedEmailId) {
        await this.db.update(emails).set({ processedState: "failed" }).where(eq(emails.id, storedEmailId));
      }
      return;
    }

    if (!storedEmailId) {
      const filter = filterEmail({
        senderEmail: email.senderEmail,
        senderName: email.senderName ?? undefined,
        subject: email.subject,
        body: email.text,
        inKnownThread: this.known.some((a) => a.threadIds.includes(email.threadId)),
        knownCompanies: this.known.map((a) => a.company),
      });
      if (!filter.relevant) return;
    }

    const { classification, disposition } = await this.classify(email);
    // Nothing to write when a retried email still can't be classified.
    const stored =
      storedEmailId && disposition.type === "defer"
        ? true
        : await this.store(email, classification, disposition, storedEmailId);
    // False when another run stored this message first.
    if (!stored) return;

    if (!storedEmailId) this.stats.relevant++;
    this.stats[STAT[disposition.type]]++;
    if (disposition.type === "create" || disposition.type === "change" || disposition.type === "record") {
      this.known = await this.loadApplications();
    }
  }

  private async classify(
    email: ParsedEmail,
  ): Promise<{ classification: Classification | null; disposition: Disposition }> {
    if (this.classifierDown) return { classification: null, disposition: { type: "defer" } };
    try {
      const classification = await this.deps.classifier.classify(email);
      return {
        classification,
        disposition: decideOutcome(classification, email, this.known, this.deps.threshold),
      };
    } catch (error) {
      // A rejected API key fails every email for every user, so it stops the whole poll.
      if (!(error instanceof ClassifierError) || error.code === "auth") throw error;
      if (error.code === "unavailable") {
        this.classifierDown = true;
        this.deps.log?.("Classifier unavailable; deferring the rest of this run", { userId: this.userId });
        return { classification: null, disposition: { type: "defer" } };
      }
      return { classification: null, disposition: { type: "fail" } };
    }
  }

  /** Writes the email and everything it causes in one transaction. Returns false if the email was already stored. */
  private async store(
    email: ParsedEmail,
    classification: Classification | null,
    disposition: Disposition,
    storedEmailId?: string,
  ): Promise<boolean> {
    const userId = this.userId;

    return this.db.transaction(async (tx) => {
      let emailId = storedEmailId;
      if (!emailId) {
        const [row] = await tx
          .insert(emails)
          .values({
            userId,
            gmailMessageId: email.gmailMessageId,
            threadId: email.threadId,
            sender: email.senderName ? `${email.senderName} <${email.senderEmail}>` : email.senderEmail,
            subject: email.subject,
            receivedAt: email.receivedAt,
          })
          .onConflictDoNothing()
          .returning({ id: emails.id });
        if (!row) return false;
        emailId = row.id;
      }

      let applicationId: string | null = null;
      const event = (toApplication: string, fromStatus: Status | null, toStatus: Status | null) => ({
        userId,
        applicationId: toApplication,
        kind: classification!.kind,
        source: "email" as const,
        fromStatus,
        toStatus,
        emailId,
        confidence: classification!.confidence,
        evidenceQuote: classification!.evidence || null,
        summary: classification!.summary,
        deadline: classification!.deadline,
        interviewAt: classification!.interviewAt,
        occurredAt: email.receivedAt,
      });

      switch (disposition.type) {
        case "create": {
          const domain = emailDomain(email.senderEmail);
          const [created] = await tx
            .insert(applications)
            .values({
              userId,
              company: disposition.company,
              role: disposition.role,
              ats: isAtsDomain(domain) ? domainLabel(domain) : null,
              appliedAt: email.receivedAt,
              status: "applied",
              statusUpdatedAt: email.receivedAt,
              source: "email",
            })
            .returning({ id: applications.id });
          applicationId = created!.id;
          await tx.insert(events).values(event(applicationId, null, "applied"));
          break;
        }
        case "change":
          applicationId = disposition.applicationId;
          await tx
            .update(applications)
            .set({ status: disposition.to, statusUpdatedAt: email.receivedAt, updatedAt: this.now() })
            .where(and(eq(applications.id, applicationId), eq(applications.userId, userId)));
          await tx.insert(events).values(event(applicationId, disposition.from, disposition.to));
          break;
        case "record":
          applicationId = disposition.applicationId;
          await tx.insert(events).values(event(applicationId, null, null));
          break;
        case "review":
          await tx.insert(reviewItems).values({
            userId,
            emailId,
            reason: disposition.reason,
            candidateApplicationIds: disposition.candidateIds,
            proposedStatus: classification!.kind === "other" ? null : classification!.kind,
          });
          break;
      }

      await tx
        .update(emails)
        .set({ processedState: PROCESSED_STATE[disposition.type], applicationId, extracted: classification })
        .where(eq(emails.id, emailId));
      return true;
    });
  }
}

/** Syncs one inbox. Throws if Gmail or the database fails; the cursor is left where it was. */
export function pollUser(deps: IngestDeps, userId: string, gmail: GmailClient): Promise<PollStats> {
  return new UserPoll(deps, userId, gmail).run();
}

/** Syncs every connected inbox. One user's failure does not stop the others. */
export async function runPoll(deps: IngestDeps): Promise<PollResult[]> {
  const connected = await deps.db
    .select({ id: users.id })
    .from(users)
    .innerJoin(oauthTokens, eq(oauthTokens.userId, users.id));

  const results: PollResult[] = [];
  for (const { id: userId } of connected) {
    try {
      const gmail = await deps.connect(userId);
      if (!gmail) {
        deps.log?.("Gmail access was revoked or has expired", { userId });
        results.push({ userId, status: "disconnected" });
        continue;
      }
      results.push({ userId, status: "ok", stats: await pollUser(deps, userId, gmail) });
    } catch (error) {
      if (error instanceof ClassifierError && error.code === "auth") throw error;
      const message = error instanceof Error ? error.message : String(error);
      deps.log?.("Poll failed", { userId, error: message });
      results.push({ userId, status: "failed", error: message });
    }
  }
  return results;
}
