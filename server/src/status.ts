// Shared with the web app (imported as "@tracker/server/status"), so keep this file dependency-free.

export const STATUSES = ["applied", "oa", "interview", "offer", "rejected"] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<Status, string> = {
  applied: "Applied",
  oa: "OA",
  interview: "Interview",
  offer: "Offer",
  rejected: "Rejected",
};

// What an email was classified as. "other" covers job-related mail that carries no status.
export const EMAIL_KINDS = [...STATUSES, "other"] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

export const SOURCES = ["email", "manual"] as const;
export type Source = (typeof SOURCES)[number];

export const PROCESSED_STATES = ["pending", "processed", "ignored", "needs_review", "failed"] as const;
export type ProcessedState = (typeof PROCESSED_STATES)[number];

export const REVIEW_REASONS = ["low_confidence", "ambiguous_match", "no_match"] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

export const REVIEW_RESOLUTIONS = ["accepted", "reassigned", "ignored"] as const;
export type ReviewResolution = (typeof REVIEW_RESOLUTIONS)[number];
