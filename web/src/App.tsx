import { useEffect, useState } from "react";
import { STATUSES, STATUS_LABELS } from "@tracker/server/status";

interface Me {
  email: string;
  gmailConnected: boolean;
  lastSyncAt: string | null;
}

type Session = { state: "loading" } | { state: "signed_out" } | { state: "signed_in"; me: Me } | { state: "down" };

const AUTH_ERRORS: Record<string, string> = {
  denied: "Sign-in was cancelled.",
  gmail_scope: "Gmail access is needed to track your applications. Sign in again and leave the Gmail box ticked.",
  failed: "Sign-in failed. Try again.",
};

// Placeholder page until the dashboard is built (step 5).
export function App() {
  const [session, setSession] = useState<Session>({ state: "loading" });
  const authError = new URLSearchParams(window.location.search).get("auth_error");

  const load = () =>
    fetch("/api/me")
      .then(async (res) => {
        if (res.ok) setSession({ state: "signed_in", me: await res.json() });
        else setSession({ state: res.status === 401 ? "signed_out" : "down" });
      })
      .catch(() => setSession({ state: "down" }));

  useEffect(() => {
    void load();
  }, []);

  const logout = () => fetch("/auth/logout", { method: "POST" }).then(load);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "4rem auto", padding: "0 1rem" }}>
      <h1>joblert</h1>
      {authError && <p role="alert">{AUTH_ERRORS[authError] ?? AUTH_ERRORS.failed}</p>}

      {session.state === "loading" && <p>Loading…</p>}
      {session.state === "down" && <p>The API is not reachable.</p>}
      {session.state === "signed_out" && <a href="/auth/google">Sign in with Google</a>}
      {session.state === "signed_in" && (
        <>
          <p>Signed in as {session.me.email}</p>
          {session.me.gmailConnected ? (
            <p>
              Gmail connected.{" "}
              {session.me.lastSyncAt
                ? `Last sync: ${new Date(session.me.lastSyncAt).toLocaleString()}`
                : "Not synced yet."}
            </p>
          ) : (
            <p>
              Gmail access has expired. <a href="/auth/google">Reconnect</a>
            </p>
          )}
          <button onClick={logout}>Sign out</button>
        </>
      )}

      <p>Statuses: {STATUSES.map((s) => STATUS_LABELS[s]).join(" → ")}</p>
    </main>
  );
}
