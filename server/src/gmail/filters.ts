import { domainMatchesCompany, emailDomain, normalizeCompany } from "../pipeline/company.ts";

export interface FilterInput {
  senderEmail: string;
  senderName?: string | null;
  subject: string;
  body?: string;
  /** The message belongs to a Gmail thread already linked to an application. */
  inKnownThread?: boolean;
  /** Companies the user has an application with. Mail from one of them is worth a look by the triage. */
  trackedCompanies?: readonly string[];
}

/**
 * relevant: goes straight to the classifier. excluded: dropped, either as an alert or marketing (`alert`)
 * or because nothing about it hints at a job (`no_signal`).
 * unsure: it hints at a job but no rule settles it, so the triage decides.
 */
export type FilterResult =
  | { verdict: "relevant"; reason: "known_thread" | "ats_domain" | "keyword" }
  | { verdict: "excluded"; reason: "alert" | "no_signal" }
  | { verdict: "unsure" };

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
  // "You shared some Google Account data with …", sent on every sign-in with Google.
  /^noreply-accounts@google\.com$/,
  // Workday's one-time passcodes.
  /@otp\.workday\.com$/,
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
  // Account housekeeping that comes with an application but says nothing about its status.
  /\bone[- ]time (password|passcode)\b/i,
  /\b(verification|security) code\b/i,
  /\b(verify|confirm) your (identity|email( address)?|candidate account)\b/i,
  /\bidentity verification\b/i,
  /\buser account with\b/i,
  /\bcreate (an|your) (account|candidate home)\b/i,
  /\bguest account information\b/i,
  /\byour .{0,40}\bcareers account\b/i,
  /\bkeep track of your application\b/i,
  /\bsurvey\b/i,
  // LinkedIn's social nudges: "View Sam's post and your next steps".
  /^(view|follow) .+ and (view )?your next steps$/i,
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

// Weak signals: any one sends mail to the triage instead of dropping it. They may be loose, since the triage
// and the classifier still have to agree; mail matching none of them is never sent to a model.
const WEAK_SENDER = [/recruit|talent|career|hiring|human.?resources|staffing|\bjobs?\b|\bhr\b/i];
// "WellsFargoHR": case matters here, or every "...hr" word would match.
const WEAK_SENDER_NAME = [/HR\b/];

const WEAK_SUBJECT = [
  /\b(apply|applied|applying|applications?|applicants?)\b/i,
  /\b(positions?|roles?|openings?|opportunit(y|ies)|requisition)\b/i,
  /\b(candida(te|tes|cy)|resume|recruit\w*|hiring|talent|new grad)\b/i,
  /\b(interview\w*|offer|on-?site|assessments?)\b/i,
  /\b(intern|interns|internships?|jobs?|careers?)\b/i,
  /\bthank you for your (time|interest)\b/i,
];

const WEAK_BODY = [
  /\b(your|job) application\b/i,
  /\b(applied|applying) (for|to)\b/i,
  /\b(recruiter|recruiting|recruitment|talent acquisition)\b/i,
  /\binterview\w*\b/i,
  /\bhiring (manager|team|process)\b/i,
  /\b(candida(te|tes|cy)|your resume|requisition|online assessment)\b/i,
  /\b(the|this|our|for) [^.\n]{0,60}\b(position|role)\b/i,
];

export function isAtsDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return ATS_DOMAINS.some((ats) => d === ats || d.endsWith(`.${ats}`));
}

const matchesAny = (patterns: RegExp[], text: string) => patterns.some((p) => p.test(text));

/** Settles the clear cases without a model: mail that is certainly worth classifying, and mail that certainly isn't. */
export function filterEmail(input: FilterInput): FilterResult {
  if (input.inKnownThread) return { verdict: "relevant", reason: "known_thread" };

  const sender = input.senderEmail.toLowerCase();
  if (matchesAny(EXCLUDED_SENDERS, sender) || matchesAny(EXCLUDED_SUBJECTS, input.subject)) {
    return { verdict: "excluded", reason: "alert" };
  }

  if (isAtsDomain(emailDomain(sender))) return { verdict: "relevant", reason: "ats_domain" };

  if (matchesAny(SUBJECT_KEYWORDS, input.subject) || (input.body && matchesAny(BODY_KEYWORDS, input.body))) {
    return { verdict: "relevant", reason: "keyword" };
  }

  return hasWeakSignal(input, sender) ? { verdict: "unsure" } : { verdict: "excluded", reason: "no_signal" };
}

function hasWeakSignal(input: FilterInput, sender: string): boolean {
  const name = input.senderName ?? "";
  if (matchesAny(WEAK_SENDER, `${name} ${sender}`) || matchesAny(WEAK_SENDER_NAME, name)) return true;
  if (matchesAny(WEAK_SUBJECT, input.subject)) return true;
  if (input.body && matchesAny(WEAK_BODY, input.body)) return true;
  return fromTrackedCompany(input.trackedCompanies ?? [], name, emailDomain(sender));
}

function fromTrackedCompany(companies: readonly string[], senderName: string, domain: string): boolean {
  const name = ` ${normalizeCompany(senderName)} `;
  return companies.some((company) => {
    const normalized = normalizeCompany(company);
    return normalized !== "" && (domainMatchesCompany(domain, company) || name.includes(` ${normalized} `));
  });
}
