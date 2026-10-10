import { companySimilarity, domainMatchesCompany, emailDomain } from "./company.ts";

export interface MatchEmail {
  threadId: string;
  senderEmail: string;
  /** Company and role as extracted by the classifier; null when the email doesn't name them. */
  company: string | null;
  role: string | null;
  receivedAt: Date;
}

export interface MatchCandidate {
  id: string;
  company: string;
  role: string;
  appliedAt: Date;
  /** Gmail threads already linked to this application. */
  threadIds: readonly string[];
}

export interface ScoredCandidate {
  applicationId: string;
  score: number;
}

export type MatchResult =
  | { type: "match"; applicationId: string; score: number; via: "thread" | "score" }
  | { type: "ambiguous"; candidates: ScoredCandidate[] }
  | { type: "none" };

// A sender domain is weaker evidence than a named company: recruiters also write on behalf of clients.
const DOMAIN_EVIDENCE = 0.7;
// Below this share of the shorter title's words, two role titles are different jobs.
const ROLE_CONTRADICTION = 0.5;
// How far ahead the best candidate must be to win outright.
const WIN_MARGIN = 0.15;
// Confirmation emails can be timestamped slightly before the logged application time.
const EARLY_TOLERANCE_MS = 24 * 60 * 60 * 1000;
const MAX_AMBIGUOUS = 5;

const ROLE_ABBREVIATIONS: Record<string, string[]> = {
  sr: ["senior"],
  jr: ["junior"],
  swe: ["software", "engineer"],
  sde: ["software", "engineer"],
  eng: ["engineer"],
  dev: ["developer"],
  mgr: ["manager"],
  pm: ["product", "manager"],
};
const ROLE_STOPWORDS = new Set(["a", "an", "the", "of", "and", "for", "in", "at"]);

export function roleTokens(role: string): Set<string> {
  const tokens = role
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((t) => t && !ROLE_STOPWORDS.has(t))
    .flatMap((t) => ROLE_ABBREVIATIONS[t] ?? [t]);
  return new Set(tokens);
}

/** Jaccard ranks candidates; overlap (share of the shorter title) detects a different job. */
export function roleSimilarity(a: string, b: string): { jaccard: number; overlap: number } {
  const ta = roleTokens(a);
  const tb = roleTokens(b);
  if (ta.size === 0 || tb.size === 0) return { jaccard: 0, overlap: 0 };
  const shared = [...ta].filter((t) => tb.has(t)).length;
  return { jaccard: shared / (ta.size + tb.size - shared), overlap: shared / Math.min(ta.size, tb.size) };
}

function companyEvidence(email: MatchEmail, candidate: MatchCandidate): number {
  const named = email.company ? companySimilarity(email.company, candidate.company) : 0;
  const domain = domainMatchesCompany(emailDomain(email.senderEmail), candidate.company) ? DOMAIN_EVIDENCE : 0;
  return Math.max(named, domain);
}

/** Finds which application an email belongs to. Pure: the caller supplies the candidate applications. */
export function matchEmail(email: MatchEmail, candidates: readonly MatchCandidate[]): MatchResult {
  const inThread = candidates.filter((c) => c.threadIds.includes(email.threadId));
  if (inThread.length === 1) {
    return { type: "match", applicationId: inThread[0]!.id, score: 1, via: "thread" };
  }
  if (inThread.length > 1) {
    return { type: "ambiguous", candidates: inThread.map((c) => ({ applicationId: c.id, score: 1 })) };
  }

  const scored: ScoredCandidate[] = [];
  for (const candidate of candidates) {
    // An email can't be about an application that didn't exist yet.
    if (email.receivedAt.getTime() < candidate.appliedAt.getTime() - EARLY_TOLERANCE_MS) continue;

    const company = companyEvidence(email, candidate);
    if (company === 0) continue;

    let role = 0.5; // neutral when the email names no role
    if (email.role) {
      const similarity = roleSimilarity(email.role, candidate.role);
      if (similarity.overlap < ROLE_CONTRADICTION) continue;
      role = similarity.jaccard;
    }

    scored.push({ applicationId: candidate.id, score: company * 0.6 + role * 0.4 });
  }

  scored.sort((a, b) => b.score - a.score);
  const [best, runnerUp] = scored;
  if (!best) return { type: "none" };
  if (!runnerUp || best.score - runnerUp.score >= WIN_MARGIN) {
    return { type: "match", applicationId: best.applicationId, score: best.score, via: "score" };
  }
  return { type: "ambiguous", candidates: scored.slice(0, MAX_AMBIGUOUS) };
}
