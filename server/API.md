# API

JSON over HTTP, on `http://localhost:3000` in development.

Sign in at `/auth/google`; the session cookie it sets is required on every `/api` route except `/api/health`. Everything is scoped to the signed-in user: another user's ids return `404`.

Errors are `{ "error": "<code>" }`: `400` `invalid_request`, `401` `not_signed_in`, `404` `not_found`, `409` a state conflict, `500` `internal_error`. Request bodies reject unknown fields.

Statuses: `applied`, `oa`, `interview`, `offer`, `rejected`.

## Auth and account

| Route | Description |
|---|---|
| `GET /api/health` | `{ ok, db }`. No session needed |
| `GET /auth/google` | Redirects to Google sign-in |
| `GET /auth/google/callback` | Google's return URL. Redirects to the web app, with `?auth_error=denied\|gmail_scope\|failed` on failure |
| `POST /auth/logout` | Ends the session. `204` |
| `GET /api/me` | `{ id, email, gmailConnected, lastSyncAt }` |
| `DELETE /api/me` | Deletes the account and all its data, and revokes Google access. `204` |
| `POST /api/sync` | Starts a sync in the background. `202`. `409` `sync_in_progress` or `gmail_disconnected` |

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

Reasons: `low_confidence`, `ambiguous_match`, `no_match`, `status_conflict`.
Errors: `400` `status_required` or `company_required`, `404` `application_not_found`, `409` `already_resolved`.

## Undo

| Route | Description |
|---|---|
| `POST /api/events/:id/revert` | Restores the status the event replaced. Returns `{ applicationId, status }`. Only the newest change on an application can be undone. `409` `already_reverted`, `not_a_status_change`, `nothing_to_restore` or `not_latest_change` |
