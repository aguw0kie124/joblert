# API

JSON over HTTP, on `http://localhost:3000` in development.

Sign in at `/auth/google`; the session cookie it sets is required on every `/api` route except `/api/health`. `/webhooks/gmail` is called by Google, not the browser, and takes a token instead. Everything is scoped to the signed-in user: another user's ids return `404`.

Errors are `{ "error": "<code>" }`: `400` `invalid_request`, `401` `not_signed_in`, `404` `not_found`, `409` a state conflict, `500` `internal_error`. Request bodies reject unknown fields.

Statuses: `applied`, `oa`, `interview`, `offer`, `rejected`.

## Auth and account

| Route | Description |
|---|---|
| `GET /api/health` | `{ ok, db }`. No session needed |
| `GET /auth/google` | Redirects to Google sign-in |
| `GET /auth/google/callback` | Google's return URL. Redirects to the web app, with `?auth_error=denied\|gmail_scope\|failed` on failure |
| `POST /auth/logout` | Ends the session. `204` |
| `GET /api/me` | `{ id, email, gmailConnected, lastSyncAt, syncing }`. `syncing` is true while a sync of this inbox is running |
| `DELETE /api/me` | Deletes the account and all its data, and revokes Google access. `204` |
| `POST /api/sync` | Starts a sync in the background: reads mail that arrived since the last one. `202`. `409` `sync_in_progress` or `gmail_disconnected`. Rarely needed: mail is synced as it arrives |

## Sync

An inbox is synced when Gmail reports a change, once an hour as a safety net, on sign-in, and on `POST /api/sync`. Signing in starts Gmail's notifications and marks where the first sync begins; mail already in the inbox is not read.

| Route | Description |
|---|---|
| `POST /webhooks/gmail?token=<PUBSUB_TOKEN>` | Where the Pub/Sub push subscription delivers Gmail's notifications. Only exists when `GMAIL_PUBSUB_TOPIC` and `PUBSUB_TOKEN` are set. Syncs the inbox the notification names. `204` when done, already running, or not actionable (unknown address, unreadable body, disconnected inbox). `503` when the sync hit a rate limit or outage, so Pub/Sub delivers it again. `403` on a wrong token |

Google Cloud setup, in the project that holds the OAuth client:

1. Enable the Pub/Sub API and create a topic. Its full name (`projects/<project>/topics/<topic>`) is `GMAIL_PUBSUB_TOPIC`.
2. Grant `gmail-api-push@system.gserviceaccount.com` the Pub/Sub Publisher role on the topic.
3. Create a push subscription to `<PUBLIC_URL>/webhooks/gmail?token=<PUBSUB_TOKEN>`, with an acknowledgement deadline of 120 seconds and exponential backoff retry (10 seconds to 10 minutes). The URL must be public HTTPS.

Without those two settings the app still works: inboxes are synced hourly and from the dashboard.

## Applications

| Route | Description |
|---|---|
| `GET /api/applications` | Optional `status` and `q` (company or role). Returns `{ applications, counts }`, where `counts` is per status across all applications |
| `GET /api/applications/:id` | `{ application, events }`, events newest first, each with its source email |
| `POST /api/applications` | Add by hand. Body: `company` (required), `role`, `jobUrl`, `location`, `notes`, `appliedAt`, `status`. `201` |
| `PATCH /api/applications/:id` | Same fields, all optional. A manual status change can go to any status |
| `DELETE /api/applications/:id` | Deletes it and its timeline. `204` |

## Review queue

| Route | Description |
|---|---|
| `GET /api/review` | `{ items }`: open items, each with the email, its `reason`, `proposedStatus`, and candidate applications |
| `POST /api/review/:id/resolve` | Body is one of the three actions below. Returns `{ resolution, applicationId }` |

Resolve actions:

- `{ "action": "apply", "applicationId": "…", "status": "…" }`: attach the email to an application. `status` defaults to the proposed one.
- `{ "action": "create", "company": "…", "role": "…", "status": "…" }`: log a new application. All fields default to what was read from the email.
- `{ "action": "ignore" }`: dismiss it.

Reasons: `low_confidence`, `ambiguous_match`, `no_match`, `status_conflict`, `unreadable` (the classifier gave no usable answer, so nothing was read from the email and there is no proposed status).
Errors: `400` `status_required` or `company_required`, `404` `application_not_found`, `409` `already_resolved`.

## Undo

| Route | Description |
|---|---|
| `POST /api/events/:id/revert` | Restores the status the event replaced. Returns `{ applicationId, status }`. Only the newest change on an application can be undone. `409` `already_reverted`, `not_a_status_change`, `nothing_to_restore` or `not_latest_change` |

## Deploy

One Render web service (`render.yaml`) on the free plan, with the database on Supabase.

- Build: `npm ci --include=dev && npm run build`. Start: `npm start`, which applies migrations and then runs the server.
- In production Fastify also serves the built dashboard from `web/dist`; any page address that is not under `/api`, `/auth`, `/webhooks` or `/assets` gets `index.html`.
- Set `PUBLIC_URL` to the service's URL and leave `WEB_URL` unset. `DATABASE_URL` must be Supabase's session pooler string (Render has no IPv6).
- The free service sleeps after 15 minutes without traffic. A Gmail notification wakes it, and `.github/workflows/keepalive.yml` calls `/api/health` every 6 hours (repo variable `PUBLIC_URL`). Each wake restarts the server, which renews every Gmail watch and syncs every inbox.
- Requests are logged by path only, because the webhook URL carries its token in the query string.
