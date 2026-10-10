import { companySimilarity, domainMatchesCompany, emailDomain } from "../pipeline/company.ts";

export interface FilterInput {
  senderEmail: string;
  senderName?: string;
  subject: string;
  body?: string;
  /** The message belongs to a Gmail thread already linked to an application. */
  inKnownThread?: boolean;
  /** Companies already in the tracker. */
  knownCompanies?: readonly string[];
}

export type FilterResult =
  | { relevant: true; reason: "known_thread" | "ats_domain" | "known_company" | "keyword" }
  | { relevant: false; reason: "excluded" | "no_signal" };

// Applicant tracking systems and assessment platforms. Matched as a domain suffix.
const ATS_DOMAINS = [
  "greenhouse.io",
  "greenhouse-mail.io",
  "lever.co",
  "myworkday.com",
  "myworkdayjobs.com",
  "ashbyhq.com",
  "icims.com",
  "smartrecruiters.com",
  "jobvite.com",
  "workable.com",
  "workablemail.com",
  "bamboohr.com",
  "taleo.net",
  "successfactors.com",
  "breezy.hr",
  "recruitee.com",
  "teamtailor.com",
  "rippling.com",
  "hackerrank.com",
  "hackerrankforwork.com",
  "codility.com",
  "codesignal.com",
  "hirevue.com",
  "karat.com",
];

// Job-board alerts and marketing that would otherwise match the keywords below.
const EXCLUDED_SENDERS = [
  /^jobalerts-noreply@linkedin\.com$/,
  /^jobs-listings@linkedin\.com$/,
  /^(alert|jobalert)@indeed\.com$/,
  /^noreply@glassdoor\.com$/,
  /^.*@(mail\.)?ziprecruiter\.com$/,
];

const EXCLUDED_SUBJECTS = [
  /\bjob alerts?\b/i,
  /\bjobs? (you may|for you|matching|recommended|near you)\b/i,
  /\b(new|recommended|similar|top|more) jobs?\b/i,
  /\b(is|are|now) hiring\b/i,
  /\bapply now\b/i,
  /\bnewsletter\b/i,
  /\b(weekly|daily) digest\b/i,
  /\bwebinar\b/i,
];

const SUBJECT_KEYWORDS = [
  /\byour application\b/i,
  /\bapplication (received|submitted|update|status|confirmation)\b/i,
  /\b(thanks|thank you) for (applying|your (application|interest))\b/i,
  /\binterview\b/i,
  /\bphone screen\b/i,
  /\bassessment\b/i,
  /\bcoding challenge\b/i,
  /\b(hackerrank|codesignal|codility)\b/i,
  /\bnext steps?\b/i,
  /\bcandida(te|cy)\b/i,
  /\boffer letter\b/i,
  /\b(job|employment) offer\b/i,
];

// Bodies are noisier than subjects, so only unambiguous phrases count.
const BODY_KEYWORDS = [
  /\b(thanks|thank you) for (applying|your application|your interest in)\b/i,
  /\bwe(['’]ve| have) received your application\b/i,
  /\b(move|moving) forward with (other|your)\b/i,
  /\bnot (be )?moving forward\b/i,
  /\bunfortunately\b[^.]{0,120}\b(application|position|role|candidacy)\b/i,
  /\bschedule (an?|your) (interview|call|phone screen)\b/i,
  /\b(complete|take) (the|an|our|your) (online |coding |technical )?(assessment|challenge)\b/i,
  /\bpleased to offer\b/i,
];

export function isAtsDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return ATS_DOMAINS.some((ats) => d === ats || d.endsWith(`.${ats}`));
}

const matchesAny = (patterns: RegExp[], text: string) => patterns.some((p) => p.test(text));

/** Cheap check for whether an email is worth sending to the classifier. */
export function filterEmail(input: FilterInput): FilterResult {
  if (input.inKnownThread) return { relevant: true, reason: "known_thread" };

  const sender = input.senderEmail.toLowerCase();
  if (matchesAny(EXCLUDED_SENDERS, sender) || matchesAny(EXCLUDED_SUBJECTS, input.subject)) {
    return { relevant: false, reason: "excluded" };
  }

  const domain = emailDomain(sender);
  if (isAtsDomain(domain)) return { relevant: true, reason: "ats_domain" };

  const fromKnownCompany = input.knownCompanies?.some(
    (company) =>
      domainMatchesCompany(domain, company) ||
      (input.senderName !== undefined && companySimilarity(input.senderName, company) > 0),
  );
  if (fromKnownCompany) return { relevant: true, reason: "known_company" };

  if (matchesAny(SUBJECT_KEYWORDS, input.subject) || (input.body && matchesAny(BODY_KEYWORDS, input.body))) {
    return { relevant: true, reason: "keyword" };
  }

  return { relevant: false, reason: "no_signal" };
}
