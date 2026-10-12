import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { applications, emails, events, reviewItems, syncState } from "../db/schema.ts";
import { GmailError, hasSkippedLabel, type GmailClient } from "../gmail/client.ts";
import type { GmailConnector } from "../gmail/connect.ts";
import { filterEmail, isAtsDomain } from "../gmail/filters.ts";
import { parseMessage, type GmailMessage, type ParsedEmail } from "../gmail/parser.ts";
import type { ProcessedState, ReviewReason, Status } from "../status.ts";
import { ClassifierError, type Classification, type Classifier } from "./classify.ts";
import { domainLabel, emailDomain } from "./company.ts";
import { matchEmail, type MatchCandidate } from "./match.ts";
import { decideTransition } from "./stateMachine.ts";
import { SNIPPET_CHARS, type Triager } from "./triage.ts";

// How many messages to download at once. The Gmail client paces the requests themselves.
const FETCH_CONCURRENCY = 5;
// Messages filtered together, so the ones no rule settles share one triage request.
const WINDOW = 20;
const ID_QUERY_CHUNK = 500;

export interface PollStats {
  /** Messages downloaded from Gmail. */
  fetched: number;
  /** Of those, how many passed the filter and triage and were stored. */
  relevant: number;
  created: number;
  updated: number;
  recorded: number;
  review: number;
  ignored: number;
  /** Messages dropped by rule because nothing about them hinted at a job. Never sent to a model. */
  unrelated: number;
  /** Messages that could not be parsed. */
  failed: number;
}

export interface IngestDeps {
  db: Db;
  classifier: Classifier;
  /** Decides on mail the filter is unsure about. */
  triager: Triager;
  connect: GmailConnector;
  /** Classifications below this confidence go to the review queue. */
  threshold: number;
  log?: (message: string, data?: Record<string, unknown>) => void;
  now?: () => Date;
}

interface KnownApplication extends MatchCandidate {
  status: Status;
}

export type Outcome =
  | { type: "ignore" }
  | { type: "create"; company: string; role: string; status: Status }
  | { type: "change"; applicationId: string; from: Status; to: Status }
  | { type: "record"; applicationId: string }
  | { type: "review"; reason: ReviewReason; candidateIds: string[] };

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
      location: classification.location,
      jobId: classification.jobId,
      receivedAt: email.receivedAt,
      confirmation: kind === "applied",
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
  // Also covers a later-stage email for an application the tracker never saw: it is logged at the stage it reports.
  if (classification.company) {
    return { type: "create", company: classification.company, role: classification.role ?? "", status: kind };
  }
  // Nothing to attach to and no company to name a new application after.
  return { type: "review", reason: "no_match", candidateIds: [] };
}

const PROCESSED_STATE: Record<Outcome["type"], ProcessedState> = {
  ignore: "ignored",
  create: "processed",
  change: "processed",
  record: "processed",
  review: "needs_review",
};

const STAT: Record<Outcome["type"], keyof PollStats> = {
  ignore: "ignored",
  create: "created",
  change: "updated",
  record: "recorded",
  review: "review",
};

const emptyStats = (): PollStats => ({
  fetched: 0,
  relevant: 0,
  created: 0,
  updated: 0,
  recorded: 0,
  review: 0,
  ignored: 0,
  unrelated: 0,
  failed: 0,
});

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

class UserPoll {
  readonly stats = emptyStats();
  private known: KnownApplication[] = [];

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

    const { messageIds, cursor } = await this.listNewMessages();
    for (const window of chunks(await this.withoutStored(messageIds), WINDOW)) {
      const fetched = await this.fetch(window);
      const messages = fetched.filter((m): m is GmailMessage => m !== null && !hasSkippedLabel(m.labelIds));
      this.stats.fetched += messages.length;
      await this.processWindow(messages);
    }

    // Saved only once every message is stored. A run that stops earlier, on a rate limit or an outage,
    // throws before this, so the next run starts from the same place; what it already stored is skipped.
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

  private async fetch(messageIds: readonly string[]): Promise<(GmailMessage | null)[]> {
    const messages: (GmailMessage | null)[] = [];
    for (const batch of chunks(messageIds, FETCH_CONCURRENCY)) {
      messages.push(...(await Promise.all(batch.map((id) => this.gmail.getMessage(id)))));
    }
    return messages;
  }

  /** Distinct tracked company names, most recently applied to first. */
  private knownCompanies(): string[] {
    const newestFirst = [...this.known].sort((a, b) => b.appliedAt.getTime() - a.appliedAt.getTime());
    return [...new Set(newestFirst.map((a) => a.company))];
  }

  private async loadApplications(): Promise<KnownApplication[]> {
    const rows = await this.db
      .select({
        id: applications.id,
        company: applications.company,
        role: applications.role,
        location: applications.location,
        jobId: applications.jobId,
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

  /** Ids added since the last run, oldest first, and the cursor that will cover everything after them. */
  private async listNewMessages(): Promise<{ messageIds: string[]; cursor: string }> {
    const [state] = await this.db.select().from(syncState).where(eq(syncState.userId, this.userId));

    if (state?.historyId) {
      try {
        const { messageIds, historyId } = await this.gmail.listAddedSince(state.historyId);
        return { messageIds, cursor: historyId };
      } catch (error) {
        if (!(error instanceof GmailError && error.code === "history_expired")) throw error;
        // Happens after about a week without a sync. What arrived in between is not recovered.
        this.deps.log?.("Gmail history cursor expired; starting again from now", { userId: this.userId });
      }
    }

    // A newly connected inbox starts from now: nothing older is read.
    return { messageIds: [], cursor: await this.gmail.getHistoryId() };
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

  /** Filters a window of messages, asks the triage about the ones no rule settles, and ingests what is left. */
  private async processWindow(messages: readonly GmailMessage[]) {
    const candidates: ParsedEmail[] = [];
    const unsure: ParsedEmail[] = [];
    const trackedCompanies = this.knownCompanies();

    for (const message of messages) {
      let email: ParsedEmail;
      try {
        email = parseMessage(message);
      } catch (error) {
        this.deps.log?.("Skipped a message that could not be parsed", { userId: this.userId, messageId: message.id });
        this.stats.failed++;
        continue;
      }

      const filter = filterEmail({
        senderEmail: email.senderEmail,
        senderName: email.senderName,
        subject: email.subject,
        body: email.text,
        inKnownThread: this.known.some((a) => a.threadIds.includes(email.threadId)),
        trackedCompanies,
      });
      if (filter.verdict === "relevant") candidates.push(email);
      else if (filter.verdict === "unsure") unsure.push(email);
      else if (filter.reason === "no_signal") this.stats.unrelated++;
    }

    candidates.push(...(await this.triage(unsure)));
    // Oldest first, so a confirmation creates the application before its rejection arrives.
    candidates.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
    for (const email of candidates) await this.ingest(email);
  }

  /** The emails worth classifying among those the filter could not settle. The rest are never stored. */
  private async triage(unsure: readonly ParsedEmail[]): Promise<ParsedEmail[]> {
    if (unsure.length === 0) return [];
    try {
      const verdicts = await this.deps.triager.triage(
        unsure.map((email) => ({
          senderName: email.senderName,
          senderEmail: email.senderEmail,
          subject: email.subject,
          snippet: email.text.slice(0, SNIPPET_CHARS),
        })),
        this.knownCompanies(),
      );
      return unsure.filter((_, index) => verdicts[index] ?? true);
    } catch (error) {
      // An unusable answer must not lose mail: the classifier reads them all. Anything else ends the run.
      if (error instanceof ClassifierError && error.code === "invalid_output") return [...unsure];
      throw error;
    }
  }

  private async ingest(email: ParsedEmail) {
    const { classification, outcome } = await this.classify(email);
    // False when another run stored this message first.
    if (!(await this.store(email, classification, outcome))) return;

    this.stats.relevant++;
    this.stats[STAT[outcome.type]]++;
    if (outcome.type === "create" || outcome.type === "change" || outcome.type === "record") {
      this.known = await this.loadApplications();
    }
  }

  private async classify(email: ParsedEmail): Promise<{ classification: Classification | null; outcome: Outcome }> {
    try {
      const classification = await this.deps.classifier.classify(email, { knownCompanies: this.knownCompanies() });
      return { classification, outcome: decideOutcome(classification, email, this.known, this.deps.threshold) };
    } catch (error) {
      // A rate limit, an outage or a rejected key ends the run: the cursor stays put, so the next run retries.
      if (!(error instanceof ClassifierError) || error.code !== "invalid_output") throw error;
      // The model answered, twice, with something unusable: a person reads this one.
      return { classification: null, outcome: { type: "review", reason: "unreadable", candidateIds: [] } };
    }
  }

  /** Writes the email and everything it causes in one transaction. Returns false if the email was already stored. */
  private async store(email: ParsedEmail, classification: Classification | null, outcome: Outcome): Promise<boolean> {
    const userId = this.userId;

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(emails)
        .values({
          userId,
          gmailMessageId: email.gmailMessageId,
          threadId: email.threadId,
          sender: email.senderName ? `${email.senderName} <${email.senderEmail}>` : email.senderEmail,
          subject: email.subject,
          receivedAt: email.receivedAt,
          extracted: classification,
          processedState: PROCESSED_STATE[outcome.type],
        })
        .onConflictDoNothing()
        .returning({ id: emails.id });
      if (!row) return false;
      const emailId = row.id;

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

      switch (outcome.type) {
        case "create": {
          const domain = emailDomain(email.senderEmail);
          const [created] = await tx
            .insert(applications)
            .values({
              userId,
              company: outcome.company,
              role: outcome.role,
              location: classification!.location,
              jobId: classification!.jobId,
              ats: isAtsDomain(domain) ? domainLabel(domain) : null,
              appliedAt: email.receivedAt,
              status: outcome.status,
              statusUpdatedAt: email.receivedAt,
              source: "email",
            })
            .returning({ id: applications.id });
          applicationId = created!.id;
          await tx.insert(events).values(event(applicationId, null, outcome.status));
          break;
        }
        case "change":
          applicationId = outcome.applicationId;
          await tx
            .update(applications)
            .set({ status: outcome.to, statusUpdatedAt: email.receivedAt, updatedAt: this.now() })
            .where(and(eq(applications.id, applicationId), eq(applications.userId, userId)));
          await tx.insert(events).values(event(applicationId, outcome.from, outcome.to));
          break;
        case "record":
          applicationId = outcome.applicationId;
          await tx.insert(events).values(event(applicationId, null, null));
          break;
        case "review":
          await tx.insert(reviewItems).values({
            userId,
            emailId,
            reason: outcome.reason,
            candidateApplicationIds: outcome.candidateIds,
            proposedStatus: !classification || classification.kind === "other" ? null : classification.kind,
          });
          break;
      }

      if (applicationId) await tx.update(emails).set({ applicationId }).where(eq(emails.id, emailId));
      return true;
    });
  }
}

/** Syncs one inbox. Throws if Gmail, the model or the database fails; the cursor is left where it was. */
export function pollUser(deps: IngestDeps, userId: string, gmail: GmailClient): Promise<PollStats> {
  return new UserPoll(deps, userId, gmail).run();
}
