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

On a fresh database, choose **Create a household**, enter your email, your name, and a household name.
Then choose **Add member** to enter each person's name and optional profile details (date of birth,
preferred name, sex, blood type, and eye color). Owners and editors can add members; viewers cannot.
Member additions are recorded in Activity automatically. No seed script is required.

Existing households keep their members and health records. Run `npm run db:migrate` to apply the
onboarding migration, sign in with your existing email, and use **Add member** for more profiles.

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
- **Sign-in:** `AUTH_MODE=dev` trusts an email header and only listens on 127.0.0.1. Replace
  `src/lib/auth.ts` with a real identity provider; everything else depends only on `request.tenant`.
- **OpenAI:** review your API data-retention settings before sending real data.
- **Prompts:** tuned without live model access; expect to adjust `understandPrompt` and `ANSWER_PROMPT`.
- **pgvector:** installed but unused until documents arrive.
