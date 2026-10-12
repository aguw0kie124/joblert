import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { ApiError } from "./api.ts";
import { AddPanel, DetailPanel } from "./components/ApplicationPanel.tsx";
import { ApplicationsPage } from "./components/ApplicationsPage.tsx";
import { Landing } from "./components/Landing.tsx";
import { ReviewPage } from "./components/ReviewPage.tsx";
import { Shell } from "./components/Shell.tsx";
import { useMe } from "./hooks.ts";

function Unreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="fullpage">
      <p>Joblert can&rsquo;t reach its server right now.</p>
      <button type="button" className="btn" onClick={onRetry}>
        Try again
      </button>
    </main>
  );
}

export function App() {
  const me = useMe();

  if (me.error instanceof ApiError && me.error.status === 401) return <Landing />;
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
