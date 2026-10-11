import { useState } from "react";
import { Link, Outlet, useLocation } from "react-router";
import type { Me } from "../api.ts";
import { relativeTime, shortDate } from "../format.ts";
import { useDeleteAccount, useRefreshAfterSync, useReview, useSignOut, useSync, useTick } from "../hooks.ts";
import { ChevronsIcon, InboxIcon, ListIcon, SyncIcon, WarningIcon } from "./ui.tsx";

function AccountMenu({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const signOut = useSignOut();
  const deleteAccount = useDeleteAccount();

  const confirmDelete = () => {
    const sure = window.confirm(
      "Delete your joblert account? Every application and its timeline is removed and Gmail access is revoked. This cannot be undone.",
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
  const onReview = useLocation().pathname.startsWith("/review");
  const syncing = me.gmailConnected && (me.syncing || sync.isPending);
  const openItems = review.data?.items.length ?? 0;

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Main">
        <div className="wordmark">joblert</div>
        <Link to="/" className={`nav-item${onReview ? "" : " active"}`} aria-current={onReview ? undefined : "page"}>
          <ListIcon />
          Applications
        </Link>
        <Link
          to="/review"
          className={`nav-item${onReview ? " active" : ""}`}
          aria-current={onReview ? "page" : undefined}
        >
          <InboxIcon />
          Review
          {openItems > 0 && <span className="nav-count">{openItems}</span>}
        </Link>
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
              <strong>Gmail is disconnected.</strong> joblert can&rsquo;t read new mail
              {me.lastSyncAt ? `, so statuses have not updated since ${shortDate(me.lastSyncAt)}.` : "."}
            </p>
            <a className="btn btn-dark" href="/auth/google">
              Reconnect Gmail
            </a>
          </div>
        )}
        <header className="topbar">
          <h1>{onReview ? "Review" : "Applications"}</h1>
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
