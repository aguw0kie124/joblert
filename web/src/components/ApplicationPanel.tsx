import { STATUSES, STATUS_LABELS, type Status } from "@tracker/server/status";
import { useEffect, useState, type FocusEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ApiError, type Application, type ApplicationInput, type TimelineEvent } from "../api.ts";
import { eventTime, fromDateInput, normalizeUrl, toDateInput } from "../format.ts";
import {
  useApplication,
  useCreateApplication,
  useDeleteApplication,
  useRevertEvent,
  useUpdateApplication,
} from "../hooks.ts";
import { ArrowIcon, CloseIcon, ExternalIcon, StatusPill, TrashIcon, UndoIcon } from "./ui.tsx";

/** What the form shows: every field as the string its input holds. */
interface FieldValues {
  company: string;
  role: string;
  status: Status;
  location: string;
  jobUrl: string;
  appliedAt: string;
  notes: string;
}

const blank = (): FieldValues => ({
  company: "",
  role: "",
  status: "applied",
  location: "",
  jobUrl: "",
  appliedAt: toDateInput(new Date().toISOString()),
  notes: "",
});

const fromApplication = (a: Application): FieldValues => ({
  company: a.company,
  role: a.role,
  status: a.status,
  location: a.location ?? "",
  jobUrl: a.jobUrl ?? "",
  appliedAt: toDateInput(a.appliedAt),
  notes: a.notes ?? "",
});

type TextField = Exclude<keyof FieldValues, "status">;

/** One text field's value as the API wants it, or undefined when it can't be saved (a required field left empty). */
function toPatch(field: TextField, raw: string): Partial<ApplicationInput> | undefined {
  const value = raw.trim();
  switch (field) {
    case "company":
      return value ? { company: value } : undefined;
    case "role":
      return { role: value };
    case "location":
      return { location: value || null };
    case "jobUrl":
      return { jobUrl: normalizeUrl(value) };
    case "appliedAt":
      return value ? { appliedAt: fromDateInput(value) } : undefined;
    case "notes":
      return { notes: value || null };
  }
}

const blurOnEnter = (e: KeyboardEvent<HTMLInputElement>) => {
  if (e.key === "Enter") e.currentTarget.blur();
};

/**
 * The editable fields, shared by the detail panel and the add form. With `onCommit` each field saves
 * when it loses focus; without it the inputs are plain form fields for the surrounding <form> to read.
 */
function Fields({ initial, onCommit }: { initial: FieldValues; onCommit?: (patch: Partial<ApplicationInput>) => void }) {
  const [status, setStatus] = useState(initial.status);
  useEffect(() => setStatus(initial.status), [initial.status]);

  const commit = (field: TextField) => (e: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (!onCommit || e.target.value.trim() === initial[field]) return;
    const patch = toPatch(field, e.target.value);
    if (patch) onCommit(patch);
    else e.target.value = initial[field];
  };
  const text = (field: TextField) => ({
    name: field,
    defaultValue: initial[field],
    onBlur: commit(field),
  });
  const line = onCommit ? { onKeyDown: blurOnEnter } : {};
  // Inputs are keyed by the saved value, so each shows what the server stored once a save lands.

  return (
    <div className="fields">
      <input
        key={initial.company}
        {...text("company")}
        {...line}
        className="field-title"
        aria-label="Company"
        placeholder="Company"
        required
        maxLength={200}
        autoFocus={!onCommit}
      />
      <div className="field">
        <label htmlFor="f-role">Role</label>
        <input key={initial.role} {...text("role")} {...line} id="f-role" placeholder="Empty" maxLength={200} />
      </div>
      <div className="field">
        <label htmlFor="f-status">Status</label>
        <div className="field-status">
          <select
            id="f-status"
            name="status"
            className={`pill pill-${status}`}
            value={status}
            onChange={(e) => {
              const next = e.target.value as Status;
              setStatus(next);
              onCommit?.({ status: next });
            }}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="f-location">Location</label>
        <input key={initial.location} {...text("location")} {...line} id="f-location" placeholder="Empty" maxLength={200} />
      </div>
      <div className="field">
        <label htmlFor="f-url">Job URL</label>
        <input key={initial.jobUrl} {...text("jobUrl")} {...line} id="f-url" inputMode="url" placeholder="Paste a link" maxLength={2000} />
        {onCommit && initial.jobUrl && (
          <a className="icon-btn" href={initial.jobUrl} target="_blank" rel="noreferrer" aria-label="Open job posting">
            <ExternalIcon size={14} />
          </a>
        )}
      </div>
      <div className="field">
        <label htmlFor="f-applied">Applied</label>
        <input key={initial.appliedAt} {...text("appliedAt")} id="f-applied" type="date" />
      </div>
      <div className="field field-top">
        <label htmlFor="f-notes">Notes</label>
        <textarea key={initial.notes} {...text("notes")} id="f-notes" rows={3} placeholder="Empty" maxLength={5000} />
      </div>
    </div>
  );
}

/** The panel that slides over the table. Escape or the close button returns to the table. */
function Panel({ label, head, children }: { label: string; head: ReactNode; children: ReactNode }) {
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") navigate("/");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  return (
    <aside className="panel" aria-label={label}>
      <div className="panel-head">
        <span role="status">{head}</span>
        <Link to="/" className="icon-btn" aria-label="Close panel">
          <CloseIcon />
        </Link>
      </div>
      {children}
    </aside>
  );
}

function Event({ event, onUndo }: { event: TimelineEvent; onUndo?: () => void }) {
  const subject = event.email?.subject ?? (event.source === "manual" ? "Changed by hand" : null);
  return (
    <div className={`event${event.revertedAt ? " reverted" : ""}`}>
      <div className="event-head">
        {event.toStatus && event.fromStatus && (
          <>
            <StatusPill status={event.fromStatus} />
            <ArrowIcon size={14} />
            <StatusPill status={event.toStatus} />
          </>
        )}
        {event.toStatus && !event.fromStatus && (
          <>
            <span className="event-label">Created as</span>
            <StatusPill status={event.toStatus} />
          </>
        )}
        {!event.toStatus && <span className="event-label">Email added, no status change</span>}
        <span>{eventTime(event.occurredAt)}</span>
        {event.revertedAt && <span className="event-label">Undone</span>}
        {onUndo && (
          <button type="button" className="btn btn-small" onClick={onUndo}>
            <UndoIcon size={13} />
            Undo
          </button>
        )}
      </div>
      {subject && <div className="event-subject">{subject}</div>}
      {event.evidenceQuote && <blockquote className="event-quote">&ldquo;{event.evidenceQuote}&rdquo;</blockquote>}
    </div>
  );
}

export function DetailPanel() {
  const id = useParams().id!;
  const navigate = useNavigate();
  const detail = useApplication(id);
  const update = useUpdateApplication(id);
  const remove = useDeleteApplication();
  const revert = useRevertEvent();

  if (!detail.data) {
    return (
      <Panel label="Application detail" head="">
        <p className="panel-note">{detail.isError ? "This application could not be found." : "Loading…"}</p>
      </Panel>
    );
  }

  const { application, events } = detail.data;
  // Only the newest status change can be undone, and not the one that created the application.
  const latest = events.find((e) => e.toStatus && !e.revertedAt);
  const undoable = latest?.fromStatus ? latest.id : null;

  const saveState = update.isPending
    ? "Saving…"
    : update.isError
      ? update.error instanceof ApiError && update.error.code === "invalid_request"
        ? "Not saved. Check the job URL."
        : "Not saved. Try again."
      : "Saved";

  const confirmDelete = () => {
    if (!window.confirm(`Delete ${application.company}? Its timeline is deleted with it.`)) return;
    remove.mutate(id, { onSuccess: () => navigate("/") });
  };

  return (
    <Panel label="Application detail" head={saveState}>
      <div className="panel-body">
        <Fields key={id} initial={fromApplication(application)} onCommit={(patch) => update.mutate(patch)} />
      </div>

      <section className="timeline" aria-label="Timeline">
        <h2>Timeline</h2>
        {events.map((event) => (
          <Event
            key={event.id}
            event={event}
            {...(event.id === undoable && !revert.isPending ? { onUndo: () => revert.mutate(event.id) } : {})}
          />
        ))}
      </section>

      <div className="panel-foot">
        <button type="button" className="btn btn-quiet" disabled={remove.isPending} onClick={confirmDelete}>
          <TrashIcon size={14} />
          Delete application
        </button>
      </div>
    </Panel>
  );
}

export function AddPanel() {
  const navigate = useNavigate();
  const create = useCreateApplication();

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const read = (field: TextField) => toPatch(field, String(form.get(field) ?? ""));
    const company = read("company")?.company;
    if (!company) return;
    create.mutate(
      {
        ...read("role"),
        ...read("location"),
        ...read("jobUrl"),
        ...read("appliedAt"),
        ...read("notes"),
        company,
        status: form.get("status") as Status,
      },
      { onSuccess: () => navigate("/") },
    );
  };

  return (
    <Panel label="Add application" head="New application">
      <form className="panel-body" onSubmit={submit}>
        <Fields initial={blank()} />
        <div className="panel-form-foot">
          <p>Emails that arrive later for this company and role attach to it and update its status.</p>
          <div className="actions">
            <button type="submit" className="btn btn-dark" disabled={create.isPending}>
              Add application
            </button>
            <Link to="/" className="btn btn-quiet">
              Cancel
            </Link>
            {create.isError && (
              <span className="error" role="alert">
                {create.error instanceof ApiError && create.error.code === "invalid_request"
                  ? "Not added. Check the job URL."
                  : "Not added. Try again."}
              </span>
            )}
          </div>
        </div>
      </form>
    </Panel>
  );
}
