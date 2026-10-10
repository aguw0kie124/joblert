# joblert
Job app tracker for lazy ppl

## Tech stack

TypeScript, Node.js, Fastify, React, Postgres (Drizzle ORM), Gmail API, Groq.

## Setup

1. Install dependencies.
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` and fill it in. You need a Postgres URL, a Groq API key, and a Google OAuth client with the Gmail API enabled and the redirect URI `http://localhost:3000/auth/google/callback`.
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

Open `http://localhost:5173` and sign in with Google. Then sync:

```bash
npm run poll
```

The first sync reads the last 90 days. Later syncs read only new mail.

## How it works

1. **Fetch** new mail from Gmail.
2. **Filter** out anything that doesn't look job-related.
3. **Classify** each email with one Groq call: kind, company, role, confidence.
4. **Match** it to an existing application by thread, company and role.
5. **Apply** the result: create an application, update its status, or send it to the review queue if unsure.

Every change is logged with the email that caused it, so it can be undone.

## Tradeoffs

- **Gmail only.** Runs with the browser closed, but misses applications that send no confirmation email.
- **Review queue over guessing.** Uncertain emails are never applied automatically.
- **Polling.** Status can lag by a few minutes.
- **Free Groq tier.** No cost, but a large first sync can take several runs.
- **Email text goes to Groq.** Only job-looking emails are sent, and no bodies are stored.
