import { useState } from "react";
import { Link, Outlet, useLocation } from "react-router";
import type { Me } from "../api.ts";
import { relativeTime, shortDate } from "../format.ts";
import { useDeleteAccount, useRefreshAfterSync, useReview, useSignOut, useSync, useTick } from "../hooks.ts";
import { ChartIcon, ChevronsIcon, InboxIcon, ListIcon, Logo, SyncIcon, WarningIcon } from "./ui.tsx";

function AccountMenu({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const signOut = useSignOut();
  const deleteAccount = useDeleteAccount();

  const confirmDelete = () => {
    const sure = window.confirm(
      "Delete your Joblert account? Every application and its timeline is removed and Gmail access is revoked. This cannot be undone.",
    );
    if (sure) deleteAccount.mutate();
  };

  return (
    <div
      className="account"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      {open && (
        <div className="menu">
          <button type="button" onClick={() => signOut.mutate()}>
            Sign out
          </button>
          <button type="button" onClick={confirmDelete}>
            Delete account
          </button>
        </div>
      )}
      <button
        type="button"
        className="account-btn"
        aria-label="Account menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="avatar" aria-hidden="true">
          {me.email.charAt(0)}
        </span>
        <span className="account-email">{me.email}</span>
        <ChevronsIcon className="chevrons" />
      </button>
    </div>
  );
}

const SECTIONS = [
  { path: "/", label: "Applications", icon: ListIcon },
  { path: "/review", label: "Review", icon: InboxIcon },
  { path: "/insights", label: "Insights", icon: ChartIcon },
];

function syncStatus(me: Me, syncing: boolean): string {
  if (syncing) return "Checking Gmail for new mail…";
  if (!me.lastSyncAt) return me.gmailConnected ? "Not synced yet" : "Never synced";
  return `${me.gmailConnected ? "Synced" : "Last synced"} ${relativeTime(me.lastSyncAt)}`;
}

/** Sidebar, sync header and the Reconnect banner around every signed-in page. */
export function Shell({ me }: { me: Me }) {
  useRefreshAfterSync(me);
  useTick();
  const review = useReview();
  const sync = useSync();
  const { pathname } = useLocation();
  // Applications owns every path the other sections don't, including an application's own page.
  const current = SECTIONS.find((s) => s.path !== "/" && pathname.startsWith(s.path)) ?? SECTIONS[0]!;
  const syncing = me.gmailConnected && (me.syncing || sync.isPending);
  const openItems = review.data?.items.length ?? 0;

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Main">
        <div className="wordmark">
          <Logo size={22} />
          Joblert
        </div>
        {SECTIONS.map((section) => (
          <Link
            key={section.path}
            to={section.path}
            className={`nav-item${section === current ? " active" : ""}`}
            aria-current={section === current ? "page" : undefined}
          >
            <section.icon />
            {section.label}
            {section.path === "/review" && openItems > 0 && <span className="nav-count">{openItems}</span>}
          </Link>
        ))}
        <AccountMenu me={me} />
      </nav>

      <main className="main">
        {syncing && (
          <div className="progress" aria-hidden="true">
            <div />
          </div>
        )}
        {!me.gmailConnected && (
          <div className="banner" role="alert">
            <WarningIcon />
            <p>
              <strong>Gmail is disconnected.</strong> Joblert can&rsquo;t read new mail
              {me.lastSyncAt ? `, so statuses have not updated since ${shortDate(me.lastSyncAt)}.` : "."}
            </p>
            <a className="btn btn-dark" href="/auth/google">
              Reconnect Gmail
            </a>
          </div>
        )}
        <header className="topbar">
          <h1>{current.label}</h1>
          <div className="topbar-sync">
            <span role="status">{syncStatus(me, syncing)}</span>
            <button
              type="button"
              className="btn"
              disabled={syncing || !me.gmailConnected}
              onClick={() => sync.mutate()}
            >
              <SyncIcon size={14} className={syncing ? "spin" : undefined} />
              {syncing ? "Syncing" : "Sync"}
            </button>
          </div>
        </header>
        <Outlet />
      </main>
    </div>
  );
}
