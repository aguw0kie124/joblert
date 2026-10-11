import { vi } from "vitest";
import { GmailError, type GmailClient } from "../../src/gmail/client.ts";
import type { GmailMessage } from "../../src/gmail/parser.ts";
import type { Classification, Classifier, ClassifyContext } from "../../src/pipeline/classify.ts";
import type { TriageItem, Triager } from "../../src/pipeline/triage.ts";
import type { EmailKind } from "../../src/status.ts";
import { gmailMessage, textPart } from "./gmail.ts";

/** An inbox held in memory. `history` is what the next sync is told is new; by default, every message. */
export class FakeGmail implements GmailClient {
  readonly messages = new Map<string, GmailMessage>();
  historyId = "100";
  history: string[] | "expired" | "all" = "all";
  failOn: string | null = null;
  /** Topics `watch` was called with, and how many times the watch was stopped. */
  watched: string[] = [];
  stops = 0;
  watchError: Error | null = null;

  add(...messages: GmailMessage[]) {
    for (const message of messages) this.messages.set(message.id, message);
    return this;
  }

  async getHistoryId() {
    return this.historyId;
  }

  async listAddedSince(_historyId: string) {
    if (this.history === "expired") throw new GmailError("history_expired", "expired");
    const oldestFirst = [...this.messages.values()]
      .sort((a, b) => Number(a.internalDate) - Number(b.internalDate))
      .map((message) => message.id);
    return { messageIds: this.history === "all" ? oldestFirst : this.history, historyId: this.historyId };
  }

  async watch(topic: string) {
    if (this.watchError) throw this.watchError;
    this.watched.push(topic);
  }

  async stopWatch() {
    this.stops++;
  }

  async getMessage(id: string) {
    if (this.failOn === id) throw new GmailError("failed", "Gmail returned HTTP 500 for messages");
    return this.messages.get(id) ?? null;
  }
}

export interface MailOptions {
  thread?: string;
  from?: string;
  labelIds?: string[];
}

/** A message from an ATS, so it passes the prefilter. The subject doubles as the classifier lookup key. */
export const mail = (id: string, subject: string, on: Date, options: MailOptions = {}) =>
  gmailMessage({
    id,
    threadId: options.thread ?? `thread-${id}`,
    labelIds: options.labelIds,
    from: options.from ?? "Recruiting <no-reply@greenhouse.io>",
    subject,
    internalDate: String(on.getTime()),
    body: textPart(`Body of: ${subject}`),
  });

export const result = (kind: EmailKind, overrides: Partial<Classification> = {}): Classification => ({
  jobRelated: true,
  kind,
  company: "Stripe",
  companyAsWritten: overrides.company === undefined ? "Stripe" : overrides.company,
  role: "Backend Engineer",
  confidence: 0.95,
  evidence: kind === "other" ? "" : "Body of",
  summary: `Summary for ${kind}`,
  deadline: null,
  interviewAt: null,
  ...overrides,
});

/** Answers by subject. An Error value is thrown instead of returned. */
export function fakeClassifier(answers: Record<string, Classification | Error>) {
  const classify = vi.fn(async (email: { subject: string }, _context?: ClassifyContext) => {
    const answer = answers[email.subject];
    if (!answer) throw new Error(`no classification set up for "${email.subject}"`);
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { classifier: { classify } as Classifier, classify, answers };
}

/** Calls mail job related when its subject is listed. An Error is thrown for every request instead. */
export function fakeTriager(jobSubjects: string[] | Error) {
  const triage = vi.fn(async (items: readonly TriageItem[], _knownCompanies?: readonly string[]) => {
    if (jobSubjects instanceof Error) throw jobSubjects;
    return items.map((item) => jobSubjects.includes(item.subject));
  });
  return { triager: { triage } as Triager, triage };
}
