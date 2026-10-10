import { finalizeClassification, type Classifier, type ClassifierInput } from "./classify.ts";
import type { Status } from "../status.ts";

// Kept below the auto-apply threshold so everything the rules decide goes to the review queue.
export const RULES_CONFIDENCE = 0.6;

// Checked in order: a rejection often mentions interviews, and an OA invite often thanks you for applying.
const RULES: [kind: Status, patterns: RegExp[]][] = [
  [
    "rejected",
    [
      /\bnot (be )?(moving|proceeding|going) forward\b/i,
      /\b(move|moving|proceed|proceeding) forward with (other|another)\b/i,
      /\b(pursue|pursuing|selected|chosen) (other|another) (candidates?|applicants?)\b/i,
      /\bdecided not to (proceed|move forward|continue)\b/i,
      /\b(regret to inform|not been selected|were not selected|unable to offer you)\b/i,
      /\bposition has (been|now been) filled\b/i,
      /\bunfortunately\b[^.]{0,120}\b(application|position|role|candidacy|time)\b/i,
    ],
  ],
  ["offer", [/\bpleased to (offer|extend)\b/i, /\boffer of employment\b/i, /\b(your|the) offer letter\b/i]],
  [
    "oa",
    [
      /\b(hackerrank|codesignal|codility|coderpad|testgorilla|pymetrics)\b/i,
      /\b(online|coding|technical|skills) (assessment|challenge|test)\b/i,
      /\btake[- ]home (assignment|project|challenge|exercise)\b/i,
      /\bcomplete (the|an|a|our|your) [^.]{0,30}(assessment|challenge|exercise)\b/i,
    ],
  ],
  [
    "interview",
    [
      /\b(schedule|book|set up) [^.]{0,40}(interview|call|phone screen|conversation)\b/i,
      /\binvite you to [^.]{0,30}interview\b/i,
      /\binterview (invitation|confirmation|availability)\b/i,
      /\byour availability\b/i,
      /\bphone screen\b/i,
    ],
  ],
  [
    "applied",
    [
      /\b(thanks|thank you) for (applying|your application|your interest in)\b/i,
      /\b(we(['’]ve| have)? )?received your application\b/i,
      /\bapplication (has been |was )?(received|submitted)\b/i,
      /\bsuccessfully (applied|submitted)\b/i,
    ],
  ],
];

const COMPANY_FROM_SUBJECT = /\b(?:applying to|application to|application (?:at|with)|interest in)\s+([A-Z][\w&.'-]*(?: [A-Z][\w&.'-]*){0,3})/;
const GENERIC_SENDER_WORDS = /\b(recruiting|recruitment|careers?|talent( acquisition)?|hiring|team|jobs|hr|no-?reply|notifications?)\b/gi;

function guessCompany(email: ClassifierInput): string | null {
  const fromSubject = email.subject.match(COMPANY_FROM_SUBJECT)?.[1];
  if (fromSubject) return fromSubject.replace(/[.!]+$/, "");
  const fromSender = email.senderName?.replace(GENERIC_SENDER_WORDS, "").replace(/\s+/g, " ").trim();
  return fromSender || null;
}

/** Keyword classifier used when the model is unusable. No network, never throws on ordinary input. */
export function createRulesClassifier(): Classifier {
  return {
    async classify(email) {
      const haystack = `${email.subject}\n${email.text}`;
      for (const [kind, patterns] of RULES) {
        for (const pattern of patterns) {
          const match = haystack.match(pattern);
          if (!match) continue;
          return finalizeClassification(
            {
              job_related: true,
              kind,
              company: guessCompany(email),
              role: null,
              confidence: RULES_CONFIDENCE,
              evidence: match[0],
              summary: email.subject,
              deadline: null,
              interview_at: null,
            },
            email,
            "rules",
          );
        }
      }
      return finalizeClassification(
        {
          job_related: false,
          kind: "other",
          company: null,
          role: null,
          confidence: RULES_CONFIDENCE,
          evidence: "",
          summary: email.subject,
          deadline: null,
          interview_at: null,
        },
        email,
        "rules",
      );
    },
  };
}
