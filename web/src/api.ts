import type { EmailKind, ReviewReason, ReviewResolution, Source, Status } from "@tracker/server/status";

// Shapes of the JSON the server returns (see server/API.md). Dates arrive as ISO strings.

export interface Me {
  id: string;
  email: string;
  gmailConnected: boolean;
  lastSyncAt: string | null;
  syncing: boolean;
}

export interface Application {
  id: string;
  company: string;
  role: string;
  jobUrl: string | null;
  location: string | null;
  appliedAt: string;
  status: Status;
  statusUpdatedAt: string;
  notes: string | null;
  source: Source;
}

export interface TimelineEvent {
  id: string;
  kind: EmailKind;
  source: Source;
  fromStatus: Status | null;
  toStatus: Status | null;
  evidenceQuote: string | null;
  summary: string | null;
  occurredAt: string;
  revertedAt: string | null;
  email: { subject: string | null; sender: string | null } | null;
}

export interface Candidate {
  id: string;
  company: string;
  role: string;
  status: Status;
}

export interface ReviewItem {
  id: string;
  reason: ReviewReason;
  proposedStatus: Status | null;
  email: {
    subject: string;
    sender: string;
    receivedAt: string;
    company: string | null;
    role: string | null;
    confidence: number | null;
  };
  candidates: Candidate[];
}

/** The fields a person can set on an application. */
export interface ApplicationInput {
  company: string;
  role: string;
  jobUrl: string | null;
  location: string | null;
  notes: string | null;
  appliedAt: string;
  status: Status;
}

export type ResolveAction =
  | { action: "apply"; applicationId: string; status?: Status }
  | { action: "create"; company?: string; role?: string; status?: Status }
  | { action: "ignore" };

/** A response the server answered with an error status; `code` is its `error` field. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? "internal_error");
  return data as T;
}

export const api = {
  me: () => request<Me>("GET", "/api/me"),
  logout: () => request<void>("POST", "/auth/logout"),
  deleteAccount: () => request<void>("DELETE", "/api/me"),
  sync: () => request<{ started: boolean }>("POST", "/api/sync"),

  applications: (filter: { status?: Status; q?: string }) => {
    const params = new URLSearchParams();
    if (filter.status) params.set("status", filter.status);
    if (filter.q) params.set("q", filter.q);
    const query = params.size ? `?${params}` : "";
    return request<{ applications: Application[]; counts: Record<Status, number> }>("GET", `/api/applications${query}`);
  },
  application: (id: string) =>
    request<{ application: Application; events: TimelineEvent[] }>("GET", `/api/applications/${id}`),
  createApplication: (input: Partial<ApplicationInput> & { company: string }) =>
    request<{ application: Application }>("POST", "/api/applications", input),
  updateApplication: (id: string, patch: Partial<ApplicationInput>) =>
    request<{ application: Application }>("PATCH", `/api/applications/${id}`, patch),
  deleteApplication: (id: string) => request<void>("DELETE", `/api/applications/${id}`),
  revertEvent: (id: string) => request<{ applicationId: string; status: Status }>("POST", `/api/events/${id}/revert`),

  review: () => request<{ items: ReviewItem[] }>("GET", "/api/review"),
  resolveReview: (id: string, action: ResolveAction) =>
    request<{ resolution: ReviewResolution; applicationId: string | null }>("POST", `/api/review/${id}/resolve`, action),
};
