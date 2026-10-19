# Household Health (v0)

A local web app for recording and asking about a household's health information in plain language.
Parents type what happened ("temp 101.2 at 2am, started amoxicillin 250 mg twice a day"); the app turns it
into a card to save with one tap. Questions ("what is he taking right now?") are answered from the recorded data,
with the records used listed under each answer.

## Run it

Requires Node 22+ and Docker.

The database listens on `127.0.0.1:5433` to avoid conflicting with an existing PostgreSQL
installation on port 5432. Both database URLs in `.env` must use that address.
If your Docker installation uses standalone Compose, use `docker-compose` in place of `docker compose`.

```bash
cp .env.example .env          # add OPENAI_API_KEY; optionally Langfuse keys
docker compose up -d          # Postgres 17 + pgvector
npm install
npm run db:migrate            # schema, row-level security, audit triggers, sets the hh_app password
npm run dev                   # http://127.0.0.1:8080
```

On a fresh database, choose **Sign in with Google**, then enter a household name.
Then choose **Add member** to enter each person's name and optional profile details (date of birth,
preferred name, sex, blood type, and eye color). Owners and editors can add members; viewers cannot.
Member additions are recorded in Activity automatically. No seed script is required.

Choose **Records** to edit or delete a member's profile, allergies, medications, measurements,
and appointments at any time, including older and inactive records. Owners and editors can make
changes; viewers can read. Deleting removes a record from the active views and preserves its audit
history. Undo has no time limit; if a record has since been edited, use Records to change its current
version instead of undoing an older entry.

Existing households keep their members and health records. Run `npm run db:migrate` to apply the
onboarding migration, sign in with the matching Google account, and use **Add member** for more profiles.

Tests: `npm test` (needs the migrated database).
Check the audit chain any time: `npm run audit:verify`.

## How it fits together

| Layer | Where | Notes |
| --- | --- | --- |
| HTTP API | `src/routes/api.ts`, `src/routes/onboarding.ts` | Fastify. `/households`, `/members`, `/chat`, `/entries/:id/confirm\|discard\|undo`, `/members/:id/snapshot`, `/audit` |
| Conversation graph | `src/agent/graph.ts` | LangGraph: understand → propose an entry, or answer with tools |
| Message understanding | `src/agent/schemas.ts` | One structured-output call classifies and extracts every fact |
| Read tools | `src/agent/tools.ts` | Five fixed tools; household and member come from the session, never the model |
| Validation | `src/domain/entries.ts`, `src/domain/vitals.ts` | Units, LOINC codes, plausibility, dates; assumptions shown, ambiguities asked |
| Model choice | `src/agent/llm.ts` | `ChatOpenAI` today; swap provider here only |
| Data | `db/migrations/0001_init.sql` | Source of truth for tables, RLS, triggers, grants. `src/db/schema.ts` mirrors it for Drizzle |
| Front end | `web/index.html` | Single page: conversation, confirm cards, snapshot, activity log |

### Tenancy
Every row has `household_id`. The app connects as `hh_app`, which cannot bypass row-level security, and sets
`app.household_id`, `app.user_id` and `app.role` per transaction (`withTenant` in `src/db/client.ts`).
A query that forgets a filter returns nothing; viewers cannot write.

### Audit
- **Data changes** (create, update, soft delete) are written by database triggers with before/after values,
  so nothing can change without a record.
- **Reads, AI questions and the entry lifecycle** (drafted, saved, discarded, undone) are written by the app,
  including which record IDs each AI answer used.
- `audit_log` is append-only (no UPDATE/DELETE grant, plus a trigger) and hash-chained per household.
- Each audit row carries the request ID, which also appears in the Langfuse trace metadata.

### Observability
Langfuse via OpenTelemetry: every graph node, LLM call and tool call is a span. Set
`LANGFUSE_REDACT_CONTENT=true` to export structure, timings and token counts without health text.
Self-host Langfuse if prompts with real data will be traced.

## Before real use
- **Sign-in:** Google OpenID Connect with authorization code + PKCE, state/nonce validation, signed ID-token checks, and database-backed HttpOnly session cookies. Development email headers are ignored in Google mode.
- **OpenAI:** review your API data-retention settings before sending real data.
- **Prompts:** tuned without live model access; expect to adjust `understandPrompt` and `ANSWER_PROMPT`.
- **pgvector:** stores 1536-dimensional embeddings of reviewed lab results, with exact cosine search scoped to the selected household member.

## Lab reports

Select a member and open **Reports → Add report**. Upload a PDF, PNG, JPEG or WebP up to 10 MB, or paste text up to 100,000 characters. Files and pasted text go to the configured OpenAI model for extraction. Originals, extracted drafts and reviewed results are stored in PostgreSQL. Check the patient name, dates, all values, units, printed ranges and flags against **Download original**, then choose **Save and make searchable**. Drafts remain available for later review and are excluded from chat search.

Ask questions in chat, for example “What was my latest LDL?” or “How has my cholesterol changed?” Lab answers include clickable source reports. Latest-report questions fetch all reviewed tests from the latest saved report directly, without guessed date windows or chunk limits. Semantic search returns ranked excerpts; the separate history tool fetches complete reviewed results from up to 20 reports and signals truncation. Report dates must use years between 1900 and 2100. This is a record lookup, not a diagnosis or treatment recommendation. Overall health report generation is deferred.

Reports can be edited or deleted at any time. Edits atomically replace their embeddings; deleted reports disappear from search and downloads, while activity history is retained. Failed embedding calls leave the previous version or draft intact so you can retry. Conflicting saves require reopening the current version. Viewers can read and download, while owners and editors can upload and change reports.

Run `npm run db:migrate` to apply `0004_lab_reports.sql`. `OPENAI_LAB_MODEL` defaults to `OPENAI_MODEL`; `OPENAI_EMBEDDING_MODEL` defaults to `text-embedding-3-small`. Embeddings must support 1536 dimensions. After changing the embedding model, reopen and save existing reports to rebuild their index; search excludes embeddings produced by a different model.

## Surgery, discharge, recommendations and other reports

Use **Reports → Add report** for surgery/operative reports, discharge summaries, recommendations, or miscellaneous health documents. The app detects the category, or you can choose it explicitly. The same PDF/image/pasted-text inputs are supported. Review the title, date, facility/author, patient and narrative sections, then save to index the reviewed content. Any laboratory tests printed in the document remain available as test rows.

Original documents and transcripts stay in PostgreSQL. Narrative sections are indexed in overlapping chunks, and saved edits atomically rebuild the index. Chat can search all report categories or fetch full documents, including the latest document in a specific category. Try “What follow-up did the discharge report recommend?” or “What procedure is documented in my latest surgery report?” Answers cite the source and treat recommendations as dated statements from the document, not new clinical advice or proof of current medications.

Migration `0005_miscellaneous_reports.sql` adds categories and narrative sections without changing existing lab report IDs, source files, or indexes. The original `/labs` API remains compatible; `/reports` provides the general report endpoints. Reports remain editable and deletable at any time.

Migration `0006_rename_report_tables.sql` renames the storage tables to `reports` and `report_chunks`. Existing originals, reviewed content, embeddings, IDs and tenant policies are preserved. New activity events use `reports`; historical events retain their original entity name to preserve the audit hash chain.

Each member has separate chats, including messages, follow-up history, draft input and retry context. Switching members restores their conversation. Replies that arrive after switching stay with the member who sent the prompt. A message explicitly about another member asks you to switch to that member’s chat before accessing or changing their records.

Chat turns are automatically stored in PostgreSQL using `chat_sessions` (migration `0007_chat_sessions.sql`). Choose an earlier conversation from **Saved chats** to reopen it and continue with its context, or choose **New chat** to start a separate conversation. Sessions are scoped to the signed-in user and household member. Draft input stays local to the open page. Previously unsaved chats from before this feature cannot be recovered; new completed turns survive refreshes and server restarts.

When saving an appointment, the confirmation card offers a calendar invite. Opt in to choose a reminder (one day, one hour, or 15 minutes before) and calendar duration (30–120 minutes; default one hour). With Gmail connected, owners/editors can email it to selected household accounts; anyone with household access can download the `.ics` file. Accept/import the event into your calendar and enable its notifications to receive reminders. Later changes are not synchronized; update the calendar event if you edit, cancel, or delete the appointment.

On sign-in, a dismissible notice highlights scheduled appointments across the household within the next seven days, including each member’s name. Cancelled, completed and deleted appointments are excluded. The notice also opens the calendar invitation options. Calendar exports follow the [iCalendar format](https://www.rfc-editor.org/rfc/rfc5545).

## Google sign-in setup

1. In [Google Auth Platform](https://console.cloud.google.com/auth/clients), configure the consent/branding screen and create an OAuth client of type **Web application**. Request only basic sign-in scopes (`openid email profile`). If the consent screen is in Testing, add the household’s Google accounts as test users.
2. Register this exact authorized redirect URI for local development: `http://127.0.0.1:8080/api/auth/google/callback`. For a hosted deployment use `https://YOUR_HOST/api/auth/google/callback`.
3. Set these server-only entries in your ignored `.env` file (do not commit credentials):

```dotenv
AUTH_MODE=google
APP_ORIGIN=http://127.0.0.1:8080
GOOGLE_CLIENT_ID=your-web-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

4. Run `npm run db:migrate`, restart `npm run dev`, and open the configured `APP_ORIGIN`. The Google button stays disabled until both credentials are configured; the app never falls back to trusting email headers. Details: [Google’s OpenID Connect setup](https://developers.google.com/identity/openid-connect/openid-connect).

Existing users keep their IDs, household memberships, role and saved chat history. First sign-in automatically links an unlinked existing account only when Google is authoritative for that verified email (Gmail or its verified Workspace domain). Existing third-party email accounts need an administrator to explicitly link the correct Google `sub`; a Google-verified third-party email alone is insufficient to claim existing health records. Once linked, the stable Google subject identifies the account. New Google users create their own household after signing in; the browser cannot choose another user’s email or role.

Login transactions expire after 10 minutes and are single use. Sessions expire after seven days, survive server restarts, and are revoked on sign-out. Only hashed session tokens are stored in the database. State-changing requests require the session’s CSRF token and reject mismatching Origin headers. OAuth callback query strings, cookies and CSRF headers are excluded from request logs. Hosted deployments must use HTTPS; the session cookie becomes Secure automatically.

`AUTH_MODE=dev` remains an explicit localhost-only test/development bypass and is rejected when `NODE_ENV=production`. `npm test` explicitly selects dev mode for fixtures and separately exercises Google-mode authentication with a test provider. Actual Google sign-in requires your own OAuth credentials; test-provider success is not a real Google login.

## Neon Postgres

This app uses a persistent Fastify server, `pg` TCP connections, and Drizzle. Neon's
[driver guide](https://neon.com/docs/connect/choose-connection) recommends keeping this
driver for Render, Docker, and other persistent Node servers. `neon.ts` declares
Postgres only; the app retains its Google login and existing report storage/search.
Neon hosts the database; deploy the web server separately.

```sh
npm i -g neon@latest
neon login
neon init -y --org-id org-broad-art-59610525 --project-id muddy-wildflower-41045772 --branch production --services postgres
neon config plan
neon deploy
npm run db:setup-neon
npm run db:migrate
npm run build
npm start
```

`neon deploy` pulls pooled `DATABASE_URL` and direct `DATABASE_URL_UNPOOLED` into
`.env` when it exists, otherwise `.env.local`. Both files are ignored by Git.
`db:setup-neon` creates `hh_app` using SQL (without Neon's elevated role), generates
a random password, and writes `APP_DATABASE_URL`, `DATABASE_ADMIN_URL`, and
`APP_DB_PASSWORD` to that file without printing secrets. It refuses to rotate an
existing role without its saved app credentials. Subsequent runs reuse that password.

Runtime requests use pooled `APP_DATABASE_URL` as `hh_app`, preserving household RLS.
The owner URL Neon manages is never used for application traffic. Migrations use the
direct `DATABASE_URL_UNPOOLED`; `DATABASE_ADMIN_URL` remains the local alternative.
Neon connections enforce `sslmode=verify-full`. Startup rejects an owner-role Neon
connection or app/managed URLs targeting different branches. After switching Neon
branches, use a separate env file and configure `hh_app` for that branch.

Local database connection settings before the initial setup are saved in the ignored
`.env.before-neon` backup. Existing local health records are not copied to Neon.

For a web host, run `npm ci` with development dependencies available, followed by
`npm run build`; start with `npm start`. Set `HOST=0.0.0.0`, `NODE_ENV=production`,
`AUTH_MODE=google`, `APP_ORIGIN=https://YOUR_HOST`, the **restricted** `APP_DATABASE_URL`,
Google OAuth credentials, and your OpenAI key in the host's secret environment settings.
Do not give the running web host migration/owner credentials. Register the hosted
Google callback URL described above. `/health` returns 200 only when the app can query
Postgres, and 503 when it cannot; it exposes no records or credentials.

### Test Neon without writing fixtures to production

Use a disposable branch with a separate ignored env file. Load the env file directly
into Node; `node --run` does not forward other Node options such as `--env-file` to
the child script. The database test bootstrap refuses to run on the production Neon
branch or with mismatched app/admin endpoints, before opening any database connection.

```sh
neon branches create --name hh-neon-verification-YYYYMMDD --parent production --no-secrets
neon env pull --branch hh-neon-verification-YYYYMMDD --file .env.neon-test --services postgres
node --env-file=.env.neon-test --import tsx scripts/setup-neon.ts .env.neon-test
node --env-file=.env.neon-test --import tsx scripts/migrate.ts
node --env-file=.env.neon-test --import tsx --import ./test/setup-auth.ts --test test/*.test.ts
```

For a real HTTP smoke test, start the built app against the same disposable branch:

```sh
PORT=8081 HOST=127.0.0.1 AUTH_MODE=google node --env-file=.env.neon-test dist/src/server.js
# In another terminal:
node --env-file=.env.neon-test --import tsx scripts/neon-smoke.ts
```

The smoke script requires a `hh-neon-verification-*` branch. It checks verified TLS,
restricted permissions, static assets, DB health, and a synthetic persisted session
through household creation, member creation/update/read, and logout. The regular
suite also tests report binary storage, vector search, tenant isolation, and calendar
downloads with synthetic AI responses. These checks do not prove a real Google login
or an OpenAI response. Delete the disposable branch after verification.

## Household invitations and Gmail

The owner opens **Household access** to connect Gmail, invite a Google account as
**View only** or **Can add and edit records**, resend/revoke pending invitations,
change non-owner roles, or remove login access. Health profiles and login accounts
are separate: adding someone as a member does not give them access to the app.
An accepted invitation shares the whole household, not only one member's profile.

Invite links expire after seven days and require the invited email's Google login
and explicit acceptance. Links are single use; resending invalidates the old link.
Only a SHA-256 token hash is stored. The token travels in the URL fragment (not the
server URL or request logs) and is kept in session storage only until acceptance or
dismissal. Invite acceptance never overwrites an existing role or changes ownership.
Users who belong to multiple households can switch between them in the header.
Removal takes effect on their next request; existing records and audit history remain.

Email uses the [Gmail HTTPS API](https://developers.google.com/workspace/gmail/api/guides/sending),
not SMTP. Render's free service blocks standard SMTP ports. Gmail sending is an
additional owner consent flow; ordinary Google sign-in keeps its basic identity scopes.
The sender must connect the same Google account they use as the household owner.

### Configure Gmail once

1. Enable the **Gmail API** in the Google Cloud project containing the existing Web
   OAuth client. In Google Auth Platform's Data Access settings, add
   `https://www.googleapis.com/auth/gmail.send` (send only, no inbox access).
2. Add these authorized redirect URIs to that Web client, preserving the existing
   sign-in callback URIs:
   - `https://household-health.onrender.com/api/email/gmail/callback`
   - `http://127.0.0.1:8080/api/email/gmail/callback` for local use.
3. Run `npm run email:setup-key` to add a random 32-byte base64
   `MAIL_ENCRYPTION_KEY` to the ignored env file. Privately copy that same value
   into Render's secret environment settings. Keep it stable and backed up: it
   encrypts stored Gmail refresh tokens with AES-256-GCM, bound to the household ID.
4. Apply migration `0009_household_invitations_and_email.sql` with
   `npm run db:migrate`, build/deploy, sign in as the owner, then open
   **Household access → Connect Gmail** and approve sending permission yourself.
   The owner can disconnect the stored mailbox from the same screen.

Only a verified Gmail sender address is exposed through the UI. Refresh tokens are
encrypted at rest and never returned in an API response or logged. Session-bound
state, nonce, PKCE, expiration, and single use protect the Gmail connection callback.
Keep `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `MAIL_ENCRYPTION_KEY` server-only.

When Google's OAuth consent screen is in **Testing**, add the sender and family
accounts as test users. Gmail refresh tokens in this mode expire after seven days,
requiring **Reconnect Gmail**. For ongoing use, review Google's publishing and
verification requirements for the sensitive send scope:
[Google refresh-token rules](https://developers.google.com/identity/protocols/oauth2#expiration)
and [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).

### Appointment emails

After saving an appointment, or from **Records** / **Coming up**, choose
**Calendar invite**. Select the household accounts to receive it, the reminder,
and duration, then click **Email invitation**. Owners/editors can send; viewers
can download the `.ics` file. No recipient is selected automatically. Emails include
the member name, appointment time, provider and location, not clinical reasons,
outcomes, or report contents. Each recipient gets a separate MIME message with an
RFC 5545 calendar attachment using `METHOD:REQUEST`, organizer, attendee and alarm.
Recipients accept/import it in their own calendar; automatic later synchronization
and cancellation emails are not implemented.

Sending is explicit, limited to 50 messages per household per hour, and tracked as
`sending`, `sent`, `failed`, or `unknown`. Reusing the same operation ID does not
send another email. Gmail acceptance is not proof of inbox delivery. An ambiguous
network failure is not retried automatically: check Gmail Sent before sending again.
No background process or scheduled reminder email is required for calendar alarms.

The invitation test suite uses synthetic accounts and simulated Gmail responses;
it does not send actual mail or prove a live Google consent flow. Run it only on a
disposable branch, with the same test-bootstrap guards described above.
