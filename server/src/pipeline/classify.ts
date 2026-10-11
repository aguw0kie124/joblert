import { z } from "zod";
import { EMAIL_KINDS, type EmailKind } from "../status.ts";

/** What the classifier reads: the parser's output, minus Gmail ids. */
export interface ClassifierInput {
  senderName: string | null;
  senderEmail: string;
  subject: string;
  receivedAt: Date;
  text: string;
}

export interface Classification {
  jobRelated: boolean;
  kind: EmailKind;
  /** The employer. A tracked company's name when the classifier recognised it as the same organisation. */
  company: string | null;
  /** The employer as the email names it; differs from `company` only when that was resolved to a tracked one. */
  companyAsWritten: string | null;
  role: string | null;
  confidence: number;
  /** Verbatim quote from the email supporting `kind`; empty for "other". */
  evidence: string;
  summary: string;
  deadline: Date | null;
  interviewAt: Date | null;
  source: "llm" | "rules";
}

export interface ClassifyContext {
  /** Companies already in the tracker, so another name for one of them resolves to it instead of a duplicate. */
  knownCompanies?: readonly string[];
}

export interface Classifier {
  classify(email: ClassifierInput, context?: ClassifyContext): Promise<Classification>;
}

/**
 * invalid_output: the model answered but the answer can't be trusted; a different classifier may do better.
 * unavailable: rate limited or down; retry the email later.
 * auth: the API key was rejected; retrying won't help.
 */
export type ClassifierErrorCode = "invalid_output" | "unavailable" | "auth";

export class ClassifierError extends Error {
  readonly code: ClassifierErrorCode;

  constructor(code: ClassifierErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClassifierError";
    this.code = code;
  }
}

// Field names and descriptions are part of the prompt: this schema is sent to the model as JSON Schema.
export const rawClassificationSchema = z.object({
  job_related: z.boolean().describe("True only if the email is about a specific job application the recipient made."),
  kind: z.enum(EMAIL_KINDS),
  company: z.string().nullable().describe("The hiring company, not the ATS or assessment platform. Null if unknown."),
  role: z.string().nullable().describe("The job title as written in the email. Null if not stated."),
  confidence: z.number().min(0).max(1),
  evidence: z
    .string()
    .describe("A short phrase copied verbatim from the subject or body that supports `kind`. Empty if kind is other."),
  summary: z.string().describe("One sentence, under 30 words, saying what the email means for the applicant."),
  deadline: z
    .string()
    .nullable()
    .describe("ISO 8601 date or datetime by which the applicant must act. Null if none is stated."),
  interview_at: z.string().nullable().describe("ISO 8601 datetime of a confirmed interview. Null if none is set."),
});

/**
 * The schema for one request. With tracked companies it gains `known_company`, limited to exactly those names,
 * so the model can say "this is the same employer" but cannot invent one.
 */
export function classificationSchema(knownCompanies: readonly string[] = []) {
  if (knownCompanies.length === 0) return rawClassificationSchema;
  return rawClassificationSchema.extend({
    known_company: z
      .enum(knownCompanies as [string, ...string[]])
      .nullable()
      .describe(
        "The tracked company that is the same employer as `company` under another name. Null if none is, or if unsure.",
      ),
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_EVIDENCE_CHARS = 8;

function normalizeForQuote(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when `evidence` is a real quote from the email, ignoring case, whitespace, and wrapping punctuation. */
export function evidenceAppearsIn(evidence: string, email: ClassifierInput): boolean {
  const quote = normalizeForQuote(evidence).replace(/^[\s"'.…]+|[\s"'.…]+$/g, "");
  if (quote.length < MIN_EVIDENCE_CHARS) return false;
  return normalizeForQuote(`${email.subject}\n${email.text}`).includes(quote);
}

/** Drops dates that are unparseable or implausible relative to when the email arrived. */
function plausibleDate(value: string | null, receivedAt: Date): Date | null {
  if (!value) return null;
  const date = new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) return null;
  // A date-only deadline of "today" parses as midnight UTC, slightly before the email itself.
  if (time < receivedAt.getTime() - DAY_MS || time > receivedAt.getTime() + 365 * DAY_MS) return null;
  return date;
}

const blankToNull = (value: string | null) => value?.trim() || null;

/** Validates untrusted classifier output against the schema and the email it claims to describe. */
export function finalizeClassification(
  raw: unknown,
  email: ClassifierInput,
  source: Classification["source"],
  knownCompanies: readonly string[] = [],
): Classification {
  const parsed = classificationSchema(knownCompanies).safeParse(raw);
  if (!parsed.success) {
    throw new ClassifierError("invalid_output", `Output does not match the schema: ${z.prettifyError(parsed.error)}`);
  }
  const data = parsed.data;
  const kind = data.job_related ? data.kind : "other";

  if (kind !== "other" && !evidenceAppearsIn(data.evidence, email)) {
    throw new ClassifierError("invalid_output", `Evidence is not a quote from the email: ${JSON.stringify(data.evidence)}`);
  }

  const companyAsWritten = blankToNull(data.company);
  const knownCompany = data.job_related && "known_company" in data ? (data.known_company as string | null) : null;

  return {
    jobRelated: data.job_related,
    kind,
    company: knownCompany ?? companyAsWritten,
    companyAsWritten,
    role: blankToNull(data.role),
    confidence: data.confidence,
    evidence: kind === "other" ? "" : data.evidence.trim(),
    summary: data.summary.trim(),
    deadline: plausibleDate(data.deadline, email.receivedAt),
    interviewAt: plausibleDate(data.interview_at, email.receivedAt),
    source,
  };
}

/** Uses `fallback` when `primary` answers with something unusable. Outages and auth errors still propagate. */
export function withFallback(primary: Classifier, fallback: Classifier): Classifier {
  return {
    async classify(email, context) {
      try {
        return await primary.classify(email, context);
      } catch (error) {
        if (error instanceof ClassifierError && error.code === "invalid_output") {
          return fallback.classify(email, context);
        }
        throw error;
      }
    },
  };
}
