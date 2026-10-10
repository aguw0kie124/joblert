import type { EmailKind, ReviewReason, Status } from "../status.ts";

export type Transition =
  | { action: "change"; to: Status }
  // Keep the email on the timeline without touching the status.
  | { action: "record" }
  | { action: "review"; reason: Extract<ReviewReason, "low_confidence" | "status_conflict"> };

export interface TransitionInput {
  current: Status;
  kind: EmailKind;
  confidence: number;
  threshold: number;
}

// Rejected sits outside this order: it can follow any non-final status.
const STAGE_RANK: Record<Exclude<Status, "rejected">, number> = {
  applied: 0,
  oa: 1,
  interview: 2,
  offer: 3,
};

const isFinal = (status: Status) => status === "offer" || status === "rejected";

export function decideTransition({ current, kind, confidence, threshold }: TransitionInput): Transition {
  if (kind === "other") return { action: "record" };
  if (confidence < threshold) return { action: "review", reason: "low_confidence" };

  // A late or repeated message about the stage we're already at (or past) never regresses.
  if (kind === current || kind === "applied") return { action: "record" };

  // Anything new after an offer or rejection contradicts a final state, so a person decides.
  if (isFinal(current)) return { action: "review", reason: "status_conflict" };

  if (kind === "rejected") return { action: "change", to: "rejected" };

  return STAGE_RANK[kind] > STAGE_RANK[current as keyof typeof STAGE_RANK]
    ? { action: "change", to: kind }
    : { action: "record" };
}
