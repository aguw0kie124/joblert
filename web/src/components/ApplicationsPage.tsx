import { STATUSES, STATUS_LABELS, type Status } from "@tracker/server/status";
import { useState } from "react";
import { Link, Outlet, useMatch } from "react-router";
import { relativeTime, shortDate } from "../format.ts";
import { useApplications, useDebounced } from "../hooks.ts";
import { PlusIcon, SearchIcon, StatusPill } from "./ui.tsx";

export function ApplicationsPage() {
  const [tab, setTab] = useState<Status | "all">("all");
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const list = useApplications({ ...(tab === "all" ? {} : { status: tab }), ...(q ? { q } : {}) });
  const openId = useMatch("/applications/:id")?.params.id;

  const counts = list.data?.counts;
  const total = counts ? STATUSES.reduce((sum, s) => sum + counts[s], 0) : 0;
  const rows = list.data?.applications ?? [];
  const tabs = [
    { key: "all" as const, label: "All", count: total },
    ...STATUSES.map((s) => ({ key: s, label: STATUS_LABELS[s], count: counts?.[s] ?? 0 })),
  ];

  return (
    <div className="page">
      <div className="toolbar">
        <div className="tabs">
          {tabs.map((t) => (
            <button key={t.key} type="button" className="tab" aria-pressed={t.key === tab} onClick={() => setTab(t.key)}>
              {t.label}
              <span className="tab-count">{t.count}</span>
            </button>
          ))}
        </div>
        <div className="toolbar-actions">
          <div className="search">
            <SearchIcon size={14} />
            <input
              type="search"
              aria-label="Search company or role"
              placeholder="Search company or role"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Link to="/applications/new" className="btn btn-dark">
            <PlusIcon size={14} />
            Add
          </Link>
        </div>
      </div>

      <div className="table-scroll">
        <div className="table">
          <div className="table-head">
            <span>Company</span>
            <span>Role</span>
            <span>Location</span>
            <span>Status</span>
            <span>Last update</span>
            <span>Applied</span>
          </div>
          {rows.map((a) => (
            <Link key={a.id} to={`/applications/${a.id}`} className={`table-row${a.id === openId ? " selected" : ""}`}>
              <span className="cell-company">{a.company}</span>
              <span>{a.role}</span>
              <span className="cell-muted">{a.location}</span>
              <span>
                <StatusPill status={a.status} />
              </span>
              <span className="cell-time">{relativeTime(a.statusUpdatedAt)}</span>
              <span className="cell-time">{shortDate(a.appliedAt)}</span>
            </Link>
          ))}
        </div>
      </div>

      {list.isError && <p className="table-note">Applications could not be loaded. Try again in a moment.</p>}
      {list.data && total > 0 && rows.length === 0 && (
        <p className="table-note">No applications match this filter.</p>
      )}
      {list.data && total === 0 && (
        <div className="empty">
          <div>
            <h2>No applications yet</h2>
            <p>
              New application emails will appear here on their own. Joblert only reads mail that arrives from now on,
              so add anything you applied to earlier by hand.
            </p>
          </div>
          <Link to="/applications/new" className="btn">
            <PlusIcon size={14} />
            Add an application
          </Link>
        </div>
      )}

      <Outlet />
    </div>
  );
}
