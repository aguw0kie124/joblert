import { useEffect, useState } from "react";
import { STATUSES, STATUS_LABELS } from "@tracker/server/status";

type Health = "checking" | "up" | "down";

// Placeholder page until the dashboard is built (step 5).
export function App() {
  const [health, setHealth] = useState<Health>("checking");

  useEffect(() => {
    fetch("/api/health")
      .then((res) => setHealth(res.ok ? "up" : "down"))
      .catch(() => setHealth("down"));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "4rem auto", padding: "0 1rem" }}>
      <h1>Job Tracker</h1>
      <p>API: {health}</p>
      <p>Statuses: {STATUSES.map((s) => STATUS_LABELS[s]).join(" → ")}</p>
    </main>
  );
}
