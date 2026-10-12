<a id="readme-top"></a>

<div align="center">
  <h1>Joblert</h1>
  <p>
    A job application tracker for people who don't want to maintain a spreadsheet.
    <br />
    Connect Gmail once. Joblert logs each application and updates its status.
    <br /><br />
    <a href="https://joblert.onrender.com">Live app</a>
    &middot;
    <a href="https://github.com/aguw0kie124/joblert/issues">Report a bug</a>
    &middot;
    <a href="https://github.com/aguw0kie124/joblert/issues">Request a feature</a>
  </p>
</div>

<details>
  <summary>Table of contents</summary>
  <ol>
    <li><a href="#about-the-project">About the project</a></li>
    <li><a href="#built-with">Built with</a></li>
    <li><a href="#getting-started">Getting started</a></li>
    <li><a href="#usage">Usage</a></li>
    <li><a href="#how-it-works">How it works</a></li>
  </ol>
</details>

## About the project

<!-- Add a dashboard screenshot here once available:
![Joblert dashboard](docs/screenshot.png) -->

Tracking applications by hand is a drag. Joblert reads your application emails in the background, creates an application when you apply, and moves it through **Applied, OA, Interview, Offer** or **Rejected** as replies arrive.

- **Automatic status.** New mail is picked up through Gmail push, with an hourly sweep as a backstop.
- **Read-only access.** It only asks for Gmail's read-only scope.
- **Review queue.** Anything uncertain is held for you instead of being applied.
- **Undo.** Every change is logged with the email that caused it.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Built with

- TypeScript, Node 24
- Fastify, Drizzle ORM, Postgres (Supabase), Zod
- React, Vite, TanStack Query
- Gmail API, Groq
- Vitest, PGlite
- Render

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Getting started

### Prerequisites

- Node 24 and npm
- A Postgres database
- A [Groq](https://console.groq.com) API key
- A Google Cloud OAuth client with the Gmail API enabled and the redirect URI `http://localhost:3000/auth/google/callback`

### Installation

1. Clone the repo and install dependencies.
   ```bash
   git clone https://github.com/aguw0kie124/joblert.git
   cd joblert
   npm install
   ```
2. Copy `.env.example` to `.env` and fill it in. The comments in that file explain each value.
3. Create the tables.
   ```bash
   npm run db:migrate
   ```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Usage

Start the API and the dashboard in two terminals:

```bash
npm run dev:server
```
```bash
npm run dev:web
```

Open `http://localhost:5173` and sign in with Google. A new inbox starts from now, so only mail that arrives after sign-in is tracked. Add older applications by hand.

Locally, syncs run on the hourly timer or the dashboard's sync button. Gmail push is optional: set `GMAIL_PUBSUB_TOPIC` and `PUBSUB_TOKEN` to turn it on (setup steps are in [server/API.md](server/API.md)).

Other commands:

```bash
npm test          # unit and API tests, no network or real database
npm run typecheck
npm run build
npm start         # production: applies migrations, then serves API and dashboard
```

The backend API routes are documented in [server/API.md](server/API.md).

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## How it works

One Fastify server handles everything: the REST API, the sync, and the built dashboard. There is no queue worker or cron job.

A sync starts in one of four ways:

- **Gmail push.** Gmail publishes inbox changes to a Google Pub/Sub topic, which posts to a webhook on the server. The notification carries no mail, only the address, so the server then fetches new mail itself. If a sync hits a rate limit, the webhook answers `503` and Pub/Sub redelivers.
- **Hourly timer** in the server process, which renews the Gmail watches and syncs every inbox in case a notification went missing.
- **Sign-in.**
- **The dashboard's sync button.**

Each sync then runs these steps:

1. **Fetch** new mail from Gmail.
2. **Filter** with rules, then ask Groq about the mail the rules can't settle. Job alerts and marketing are dropped and never stored.
3. **Classify** each email with one Groq call: kind, company, role, location, confidence and a quote from the email as evidence.
4. **Match** it to an application by thread, company, role and job id.
5. **Decide** in plain code: create an application, move its status forward, or send it to the review queue.

The model only reads emails and extracts facts, each checked against a strict schema. Matching and status changes are deterministic.

**Tradeoffs**

- Gmail only. Applications that send no confirmation email are missed.
- Email sender, subject and opening lines go to Groq for triage, and full text for classification. Dropped mail is not stored.
- Groq's free tier is tight, so a busy stretch may take a few syncs to catch up.

<p align="right">(<a href="#readme-top">back to top</a>)</p>
