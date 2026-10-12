import { ArrowIcon, GoogleIcon, Logo } from "./ui.tsx";

const AUTH_ERRORS: Record<string, string> = {
  denied: "Sign-in was cancelled.",
  gmail_scope: "Gmail access is needed to track your applications. Sign in again and leave the Gmail box ticked.",
  failed: "Sign-in failed. Try again.",
};

const STEPS = [
  {
    title: "Connect Gmail once",
    text: "Sign in with Google and allow read-only access. There is nothing else to set up.",
  },
  {
    title: "Joblert reads the replies",
    text: "Confirmations, assessments, interview invitations, offers and rejections are picked out as they arrive.",
  },
  {
    title: "Your tracker updates itself",
    text: "Each application is logged and moved to its new status, with the email that caused the change beside it.",
  },
];

const FACTS = [
  { term: "Read-only", text: "Joblert never sends, deletes or changes your mail" },
  { term: "5 stages", text: "Applied, OA, Interview, Offer, Rejected" },
  { term: "Review queue", text: "an email Joblert is unsure about waits for you instead of changing anything" },
  { term: "Undo", text: "the latest status change can be reversed" },
];

/** An illustration of the product, one email arriving and the status it changes. */
function Preview() {
  return (
    <div
      className="lp-preview"
      role="img"
      aria-label="Example: an interview invitation arrives and the application moves from OA to Interview"
    >
      <div className="lp-window" aria-hidden="true">
        <div className="lp-window-bar">
          <span />
          <span />
          <span />
        </div>
        <div className="lp-card">
          <div className="lp-card-title">Reading your inbox</div>
          <div className="lp-mail">
            <span className="lp-mail-logo">M</span>
            <div>
              <div className="muted small">MaroonLife &middot; 2 mins ago</div>
              <div className="lp-mail-subject">Interview: next steps</div>
            </div>
          </div>
          <p className="lp-mail-body">
            Thanks for completing the assessment.{" "}
            <mark>We&rsquo;d like to invite you to a 45-minute technical interview</mark> with a member of our team.
          </p>
          <div className="lp-rows">
            <div className="lp-row">
              <strong>MaroonLife</strong>
              <span className="muted">Software Engineer</span>
              <span className="lp-change">
                <span className="pill pill-oa lp-was">OA</span>
                <ArrowIcon size={13} />
                <span className="pill pill-interview">Interview</span>
              </span>
            </div>
            <div className="lp-row">
              <strong>Nuj</strong>
              <span className="muted">Product Engineer</span>
              <span className="pill pill-offer">Offer</span>
            </div>
            <div className="lp-row">
              <strong>Amazon</strong>
              <span className="muted">SDE Intern</span>
              <span className="pill pill-applied">Applied</span>
            </div>
            <div className="lp-row">
              <strong>Mortenson</strong>
              <span className="muted">Industrial Engineer</span>
              <span className="pill pill-rejected">Rejected</span>
            </div>
          </div>
        </div>
        <div className="lp-chip">Status updated from this email</div>
      </div>
    </div>
  );
}

/** The signed-out page: what Joblert does, and the way in. */
export function Landing() {
  const authError = new URLSearchParams(window.location.search).get("auth_error");

  return (
    <div className="lp">
      <header className="lp-nav">
        <div className="lp-wordmark">
          <Logo size={34} />
          Joblert
        </div>
        <nav aria-label="Site">
          <a href="#how">How it works</a>
          <a href="#trust">What it touches</a>
          <a href="/privacy.html">Privacy</a>
        </nav>
        <div className="lp-nav-actions">
          <a href="/auth/google">Log in</a>
          <a className="lp-btn" href="/auth/google">
            Get started
          </a>
        </div>
      </header>

      <main>
        <section className="lp-hero">
          <div className="lp-hero-text">
            <h1>
              <span>No more spreadsheets.</span>
              Your inbox keeps track.
            </h1>
            <p className="lp-lede">
              Joblert reads the application emails in your Gmail, logs each job, and moves it from Applied to Offer as
              the replies arrive.
            </p>
            {authError && (
              <p className="notice" role="alert">
                {AUTH_ERRORS[authError] ?? AUTH_ERRORS.failed}
              </p>
            )}
            <a className="lp-btn lp-btn-large" href="/auth/google">
              <GoogleIcon />
              Sign in with Google
            </a>
            <p className="lp-fine">Read-only Gmail access. Only mail that arrives after you sign in is read.</p>
          </div>
          <Preview />
        </section>

        <section id="how" className="lp-section">
          <h2>
            <span>No forms, no columns to fill in.</span> Three steps, and the last two aren&rsquo;t yours.
          </h2>
          <ol className="lp-steps">
            {STEPS.map((step, i) => (
              <li key={step.title}>
                <span className="lp-step-number">{i + 1}</span>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id="trust" className="lp-section lp-trust">
          <h2>Automatic, but never a guess.</h2>
          <dl className="lp-facts">
            {FACTS.map((fact) => (
              <div key={fact.term}>
                <dt>{fact.term}</dt>
                <dd>{fact.text}</dd>
              </div>
            ))}
          </dl>
        </section>
      </main>

      <footer className="lp-footer">
        <span className="lp-wordmark lp-wordmark-small">
          <Logo size={24} />
          Joblert
        </span>
        <p>Email text is sent to a language model to work out each status. Full message bodies are never stored.</p>
        <a href="/privacy.html">Privacy policy</a>
      </footer>
    </div>
  );
}
