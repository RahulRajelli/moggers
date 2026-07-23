# Next: scheduled saved-search watcher (Agents SDK)

Handoff for a fresh session. Everything below is decided, not open.

## Where things stand

moggers.in is live and complete as a product:

- **ATS X-Ray** — client-side PDF forensics, ported from `D:\Job Tracker\jobtracker\pdfcheck.py`
- **Live Roles** — ~2,140 postings from 19 public ATS boards, FTS5 keyword + Vectorize semantic search
- **Accounts** — GitHub/Google OAuth, saved roles
- **Matcher** — RAG (Vectorize → D1 → llama-4-scout), BYOK Gemini fallback
- **Ingest** — GitHub Actions, all boards every 6h

Read `README.md` before touching anything: it documents the platform limits that
broke earlier designs, and each one is a trap that will be re-hit otherwise.

## What to build

**A per-user watcher that re-runs a saved search against new postings and
surfaces what is new.** Not the tool-calling loop — see "explicitly not" below.

Why this and not something flashier: ingest already refreshes all 19 boards
every 6 hours and *nobody is watching that stream on a user's behalf*. A job
seeker does not want to come back and search; they want to be told when the
right role appears. It is the first genuine reason to return to the site, and it
reuses infrastructure that already exists.

## The constraint that changes everything

**Durable Objects get 30 seconds of CPU per request — not the 10 ms that Workers
get on the free plan.** Each incoming request resets the budget. Verified
2026-07-23 against the DO limits docs.

That 10 ms ceiling is what broke the original all-boards sync sweep (silent
`1102` in production, fine in local dev) and forced board-slicing plus
off-platform seeding. **It does not apply inside a Durable Object.** Anything
CPU-bound that had to be sliced or exiled to CI could move into a DO.

## Shape

- `MoggerAgent extends Agent<Env, State>`, one instance per user
  (`getAgentByName`).
- `this.state` holds the saved search: query text or resume excerpt, filters,
  and the ids already shown — the last of these is what makes "new since you
  looked" possible at all.
- `scheduleEvery()` re-runs the query, diffs against seen ids, stores the
  delta.
- Surface the delta in the UI first. **Do not send email in v1** — moggers.in MX
  points at GoDaddy with `-all` SPF, so sending from the domain means editing the
  record Rahul's working email depends on. Deferred deliberately.

### Config

```jsonc
"durable_objects": { "bindings": [{ "name": "MoggerAgent", "class_name": "MoggerAgent" }] },
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["MoggerAgent"] }]
```

SQLite-backed classes are mandatory — only those are available on the free plan.
Do **not** enable `experimentalDecorators` in tsconfig; it breaks `@callable`.

## Watch for

- **Bundle size.** 3 MB compressed is the free-plan cap. Currently ~15 KB
  gzipped, so there is room, but the SDK plus dependencies is the likeliest
  thing to threaten it. Check `wrangler deploy --dry-run` early, not at the end.
- **Neuron budget.** 8,000/day, ~89 per matcher call. A watcher that re-runs an
  LLM pass per user per day does not scale on the free tier — do the diff with
  **Vectorize + D1 only**, and reserve generation for when the user opens the
  result.
- **Verify in production, not local dev.** Every platform limit in this project
  was invisible locally: `wrangler dev --local` does not enforce CPU limits, the
  rate limiter is a no-op there, and Workers AI/Vectorize have no local
  emulation (`remote = true` is already set on those bindings for this reason).

## Explicitly not doing

- **The tool-calling loop.** Impressive, smaller payoff. Retrieval is already
  good; a loop mostly spends neurons re-deriving what one good query returns.
  Revisit after the watcher earns its keep.
- **Email notifications.** See the SPF note above.
- **The Gemini OAuth quota route.** 1,000 req/day is reachable via
  `cloudcode-pa.googleapis.com/v1internal:generateContent`, but that is the Code
  Assist quota through an internal endpoint meant for Google's own tooling — it
  puts the *user's* account at risk. BYOK with a key they created is the
  supported path and is already built.

## Loose ends unrelated to this work

- Rotate the GitHub and Google OAuth client secrets if they were only re-entered
  rather than regenerated — both were pasted into a chat transcript.
- Change detection for ingest: a full sweep writes 20,819 rows and the free D1
  cap is 100,000/day, so 4 runs/day is ~83%. **Adding boards will exceed it.**
  Hash each JD and skip unchanged rows before adding any.
