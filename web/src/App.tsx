import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { ApiError } from "./api.ts";
import { AddPanel, DetailPanel } from "./components/ApplicationPanel.tsx";
import { ApplicationsPage } from "./components/ApplicationsPage.tsx";
import { ReviewPage } from "./components/ReviewPage.tsx";
import { Shell } from "./components/Shell.tsx";
import { GoogleIcon } from "./components/ui.tsx";
import { useMe } from "./hooks.ts";

const AUTH_ERRORS: Record<string, string> = {
  denied: "Sign-in was cancelled.",
  gmail_scope: "Gmail access is needed to track your applications. Sign in again and leave the Gmail box ticked.",
  failed: "Sign-in failed. Try again.",
};

function SignedOut() {
  const authError = new URLSearchParams(window.location.search).get("auth_error");
  return (
    <div className="landing">
      <div className="wordmark">joblert</div>
      <main>
        <div>
          <h1>Your job applications, tracked from your inbox</h1>
          <p className="lede">
            Connect Gmail once. joblert logs each application and keeps its status current as replies arrive.
          </p>
        </div>
        {authError && (
          <p className="notice" role="alert">
            {AUTH_ERRORS[authError] ?? AUTH_ERRORS.failed}
          </p>
        )}
        <a className="btn btn-large" href="/auth/google">
          <GoogleIcon />
          Sign in with Google
        </a>
        <p className="fine">
          Read-only access. joblert never sends, deletes or changes your mail. Email text is sent to a language model
          to work out each status.
        </p>
      </main>
    </div>
  );
}

function Unreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="landing">
      <div className="wordmark">joblert</div>
      <main>
        <p className="lede">joblert can&rsquo;t reach its server right now.</p>
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      </main>
    </div>
  );
}

export function App() {
  const me = useMe();

  if (me.error instanceof ApiError && me.error.status === 401) return <SignedOut />;
  if (!me.data) return me.isError ? <Unreachable onRetry={() => void me.refetch()} /> : null;

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Shell me={me.data} />}>
          <Route path="/" element={<ApplicationsPage />}>
            <Route path="applications/new" element={<AddPanel />} />
            <Route path="applications/:id" element={<DetailPanel />} />
          </Route>
          <Route path="review" element={<ReviewPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
