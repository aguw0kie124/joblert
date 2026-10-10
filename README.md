# joblert
Job app tracker for lazy ppl

## Status

Working: Google sign-in, Gmail sync, classification, matching, status updates, review queue (in the database).
Not built yet: the dashboard, the API routes behind it, and deployment.

## Tech stack

| Part | Choice |
|---|---|
| Language | TypeScript, Node 24, npm workspaces |
| API | Fastify 5 |
| Web | React 19 + Vite |
| Database | Postgres, Drizzle ORM |
| Email | Gmail REST API, read-only scope |
| Classification | Groq (`openai/gpt-oss-120b`) with structured output, keyword rules as fallback |
| Validation | Zod |
| Tests | Vitest, PGlite (in-memory Postgres) |

## Setup

1. Install dependencies.
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` and fill it in:
   - `DATABASE_URL`: any Postgres (Supabase, Render, local)
   - `GROQ_API_KEY`: free key from Groq
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: an OAuth client from Google Cloud with the Gmail API enabled and the redirect URI `http://localhost:3000/auth/google/callback`
   - `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`: run `openssl rand -base64 32` once for each
3. Create the tables.
   ```bash
   npm run db:migrate
   ```

## Usage

Start the API and the web page in two terminals:

```bash
npm run dev:server
```
```bash
npm run dev:web
```

Open `http://localhost:5173`, sign in with Google, and leave the Gmail permission ticked. Then sync:

```bash
npm run poll
```

The first sync reads the last 90 days (`BACKFILL_DAYS`). Later syncs read only new mail. In production the same command runs on a cron every 15 minutes.

Other commands:

| Command | What it does |
|---|---|
| `npm test` | Run the test suite |
| `npm run typecheck` | Typecheck server and web |
| `npm run build` | Build both |
| `npm run eval:classifier -w server` | Score the classifier against the fixture emails |

## How it works

Each sync runs every new email through the same steps:

1. **Fetch.** Ask Gmail what arrived since the last sync, using a per-user history cursor.
2. **Prefilter.** Keep mail from known ATS domains, known companies, or with job keywords. Everything else is dropped and never stored.
3. **Parse.** Turn the message into plain text and strip quoted replies, signatures and footers.
4. **Classify.** One Groq call returns the kind, company, role, confidence, a supporting quote, a one-line summary and any deadline. The quote must appear in the email or the answer is rejected.
5. **Match.** Find the application it belongs to by Gmail thread, then by company and role.
6. **Apply.** A state machine decides what happens:
   - a confident confirmation with no match creates an application
   - a matching email moves the status forward, or is added to the timeline
   - anything uncertain goes to the review queue

Every change is written as an event with the email, confidence and quote that caused it, so it can be audited and undone.

## Tradeoffs

- **Gmail only, no browser extension.** Nothing to install and it runs with the browser closed, but applications with no confirmation email are missed until you add them by hand.
- **LLM for reading, code for deciding.** The model only extracts facts from one email. Matching and status changes are deterministic and tested, so a bad model answer can't silently rewrite the tracker.
- **Polling, not push.** Status can lag by up to 15 minutes. In exchange there is no webhook or Pub/Sub setup.
- **No email bodies stored.** Only sender, subject, date and extracted fields are kept. An email that has to be retried is fetched from Gmail again.
- **Free Groq tier.** No cost, but rate limits mean a large first sync can take several runs. Held emails are retried automatically.
