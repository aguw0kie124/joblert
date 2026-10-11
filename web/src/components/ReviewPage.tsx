import { STATUSES, STATUS_LABELS, type Status } from "@tracker/server/status";
import { useState } from "react";
import type { Candidate, ResolveAction, ReviewItem } from "../api.ts";
import { relativeTime } from "../format.ts";
import { useApplications, useResolveReview, useReview } from "../hooks.ts";
import { StatusPill } from "./ui.tsx";

/** Why an email is in the queue, in plain language. */
function reasonText(item: ReviewItem): { label: string; detail: string } {
  const { company, confidence } = item.email;
  switch (item.reason) {
    case "low_confidence":
      return {
        label: "Low confidence",
        detail:
          confidence === null
            ? "joblert wasn't sure enough about what this email means, so nothing was changed."
            : `joblert is only ${Math.round(confidence * 100)}% sure what this email means, so nothing was changed.`,
      };
    case "ambiguous_match":
      return {
        label: "Matches several applications",
        detail: "More than one application fits this email. Pick the one it belongs to.",
      };
    case "no_match":
      return {
        label: "No matching application",
        detail: company
          ? `Nothing you track matches ${company}.`
          : "The email doesn't name a company, so there was nothing to attach it to.",
      };
    case "status_conflict":
      return {
        label: "Conflicts with a final status",
        detail: "The application already has a final status, which is never changed automatically.",
      };
    case "unreadable":
      return {
        label: "Could not be read",
        detail: "joblert couldn't reliably tell what this email says, so it proposed nothing.",
      };
  }
}

function Item({ item, applications }: { item: ReviewItem; applications: Candidate[] }) {
  const resolve = useResolveReview();
  const [status, setStatus] = useState<Status | "">(item.proposedStatus ?? "");
  const [target, setTarget] = useState(item.candidates[0]?.id ?? "");
  // Creating needs a company; the form only opens when the email didn't give one.
  const [creating, setCreating] = useState(false);
  const [company, setCompany] = useState("");
  const [role, setRole] = useState(item.email.role ?? "");

  const reason = reasonText(item);
  const busy = resolve.isPending;
  const send = (action: ResolveAction) => resolve.mutate({ id: item.id, action });
  const create = () => {
    if (!status) return;
    if (item.email.company) send({ action: "create", status });
    else if (!creating) setCreating(true);
    else if (company.trim()) send({ action: "create", company: company.trim(), role: role.trim(), status });
  };

  return (
    <article className="review-item">
      <div>
        <div className="review-meta">
          <span>{item.email.sender}</span>
          <span aria-hidden="true">&middot;</span>
          <span>{relativeTime(item.email.receivedAt)}</span>
        </div>
        <h2>{item.email.subject}</h2>
      </div>
      <p className="review-reason">
        <strong>{reason.label}.</strong> {reason.detail}
      </p>

      <div className="review-rows">
        <div className="review-row">
          <label className="field-label" htmlFor={`status-${item.id}`}>
            Proposed status
          </label>
          <select
            id={`status-${item.id}`}
            className={`pill pill-${status || "none"}`}
            value={status}
            onChange={(e) => setStatus(e.target.value as Status | "")}
          >
            {!item.proposedStatus && <option value="">None, choose one</option>}
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>

        <div className="review-row">
          <span className="field-label">Candidates</span>
          {item.candidates.length > 0 ? (
            <div className="candidates">
              {item.candidates.map((c) => (
                <label key={c.id} className="candidate">
                  <input
                    type="radio"
                    name={`target-${item.id}`}
                    checked={target === c.id}
                    onChange={() => setTarget(c.id)}
                  />
                  <strong>{c.company}</strong>
                  <span className="muted">{c.role}</span>
                  <StatusPill status={c.status} />
                </label>
              ))}
            </div>
          ) : (
            <select
              className="input"
              aria-label="Application to attach this email to"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">{applications.length ? "None found. Choose an application…" : "None found"}</option>
              {applications.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.role ? `${a.company} · ${a.role}` : a.company}
                </option>
              ))}
            </select>
          )}
        </div>

        {creating && (
          <div className="review-row">
            <span className="field-label">New application</span>
            <div className="actions">
              <input
                className="input"
                aria-label="Company"
                placeholder="Company"
                value={company}
                maxLength={200}
                autoFocus
                onChange={(e) => setCompany(e.target.value)}
              />
              <input
                className="input"
                aria-label="Role"
                placeholder="Role"
                value={role}
                maxLength={200}
                onChange={(e) => setRole(e.target.value)}
              />
            </div>
          </div>
        )}
      </div>

      <div className="actions">
        <button
          type="button"
          className="btn btn-dark"
          disabled={busy || !status || !target}
          onClick={() => status && send({ action: "apply", applicationId: target, status })}
        >
          Apply to application
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || !status || (creating && !company.trim())}
          onClick={create}
        >
          {creating ? "Create" : "Create new"}
        </button>
        <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => send({ action: "ignore" })}>
          Ignore
        </button>
        {resolve.isError && (
          <span className="error" role="alert">
            That didn&rsquo;t go through. Try again.
          </span>
        )}
      </div>
    </article>
  );
}

export function ReviewPage() {
  const review = useReview();
  // Every application, for attaching an email that matched none.
  const all = useApplications();
  const items = review.data?.items ?? [];

  return (
    <div className="page review">
      <p className="review-intro">
        Emails joblert wasn&rsquo;t sure about. Nothing here has changed an application yet.
      </p>
      {items.map((item) => (
        <Item key={item.id} item={item} applications={all.data?.applications ?? []} />
      ))}
      {review.isError && <p className="table-note">The review queue could not be loaded. Try again in a moment.</p>}
      {review.data && items.length === 0 && (
        <div className="empty">
          <div>
            <h2>Nothing to review</h2>
            <p>Emails joblert is unsure about will show up here.</p>
          </div>
        </div>
      )}
    </div>
  );
}
