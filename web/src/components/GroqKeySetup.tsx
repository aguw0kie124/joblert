import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { ApiError, type Me } from "../api.ts";
import { useSaveGroqKey, useSignOut } from "../hooks.ts";
import { Logo } from "./ui.tsx";

const ERRORS: Record<string, string> = {
  invalid_groq_key: "Groq rejected that key. Check you copied all of it.",
  groq_unavailable: "Groq can’t be reached right now. Try again in a minute.",
};

/**
 * Asks for the user's own Groq API key. Shown full-page until one is saved (and again if Groq stops accepting it),
 * and inside the dashboard from the account menu to replace it.
 */
export function GroqKeySetup({ me }: { me: Me }) {
  const [key, setKey] = useState("");
  const save = useSaveGroqKey();
  const signOut = useSignOut();
  // Inside the dashboard the key already works; this is a change, not the setup step.
  const changing = me.groqKey === "ok";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (key.trim()) save.mutate(key.trim(), { onSuccess: () => setKey("") });
  };

  const error = save.error instanceof ApiError ? (ERRORS[save.error.code] ?? "Saving failed. Try again.") : null;

  return (
    <main className={changing ? "groq-setup groq-setup-inline" : "groq-setup"}>
      {!changing && (
        <div className="groq-setup-brand">
          <Logo size={28} />
          Joblert
        </div>
      )}
      <h1>{changing ? "Change your Groq key" : "One more step: your Groq key"}</h1>
      <p className="muted">
        Joblert reads your job emails with Groq&rsquo;s free API. Each account uses its own key, so your emails use your
        own free quota. It is stored encrypted and only used to read your mail.
      </p>

      {me.groqKey === "invalid" && (
        <p className="notice" role="alert">
          Groq stopped accepting your saved key, so Joblert has paused reading your mail. Paste a new one to carry on.
        </p>
      )}
      {changing && save.isSuccess && (
        <p className="notice" role="status">
          New key saved.
        </p>
      )}

      <ol className="groq-setup-steps">
        <li>
          Open{" "}
          <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer">
            console.groq.com/keys
          </a>{" "}
          and sign in (free, no card needed).
        </li>
        <li>
          Choose <strong>Create API Key</strong>, give it any name, and copy it.
        </li>
        <li>Paste it below.</li>
      </ol>

      <form className="groq-setup-form" onSubmit={submit}>
        <label htmlFor="groq-key">Groq API key</label>
        <div className="groq-setup-row">
          <input
            id="groq-key"
            className="input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="gsk_…"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <button type="submit" className="btn btn-dark" disabled={!key.trim() || save.isPending}>
            {save.isPending ? "Checking…" : "Save key"}
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>

      <p className="small muted">
        {changing ? (
          <Link to="/">Back to applications</Link>
        ) : (
          <>
            Signed in as {me.email}.{" "}
            <button type="button" className="link-btn" onClick={() => signOut.mutate()}>
              Sign out
            </button>
          </>
        )}
      </p>
    </main>
  );
}
