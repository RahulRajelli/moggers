# Next

Handoff for a fresh session. The watcher described in the previous NEXT.md is
**built** — see the "The watcher" section of `README.md` for how it works and
which decisions in it are load-bearing.

## Where things stand

moggers.in is live and complete as a product:

- **ATS X-Ray** — client-side PDF forensics, ported from `D:\Job Tracker\jobtracker\pdfcheck.py`
- **Live Roles** — ~2,140 postings from 19 public ATS boards, FTS5 keyword + Vectorize semantic search
- **Accounts** — GitHub/Google OAuth, saved roles
- **Matcher** — RAG (Vectorize → D1 → llama-4-scout), BYOK Gemini fallback
- **Watcher** — a saved search per user in a Durable Object, re-run on a
  schedule, diffed against what they have already been shown *(built, not yet
  deployed)*
- **Ingest** — GitHub Actions, all boards every 6h

Read `README.md` before touching anything: it documents the platform limits that
broke earlier designs, and each one is a trap that will be re-hit otherwise.

## Deploy the watcher first

It is built and verified locally but **has never run in production**, and this
project's entire history is limits that were invisible until then.

```
npm test                      # 48 tests
npx wrangler deploy --dry-run # expect ~334 KB gzip, cap is 3 MB
npm run deploy
```

The deploy provisions a new Durable Object namespace from the `v1` migration in
`wrangler.toml`. Then, against production:

1. Sign in, set a watch, confirm the response has `"armed": 1` and
   `"fresh": []` — a non-empty `fresh` on creation means the baseline seeding
   broke and every user's first view will be a wall of false "new" roles.
2. `POST /api/sync` a board slice to pull in genuinely new postings, then press
   *check now* and confirm only the new ones appear.
3. `npx wrangler tail` across at least one scheduled fire (set the interval to
   `6h`). **This is the step that cannot be faked locally** — verify the alarm
   fires at all, and that a run finishes without a `1102`. A DO gets 30 s of
   CPU, so it should not, but that assumption is exactly what deserves the
   check.
4. Confirm `armed` stays 1 after the fire. `scheduleEvery()` re-arms itself;
   if it does not, the watch silently becomes a one-shot.

## Then: change detection for ingest — this is now the blocker

A full sweep writes 20,819 rows and the free D1 cap is 100,000/day, so 4
runs/day is ~83%. **Adding boards will exceed it**, which means this gates every
"more roles" idea including the India expansion.

Hash each JD (`title|url|location_raw|jd`), store it on `jobs`, and skip the
UPSERT for unchanged rows — the win is mostly the avoided FTS trigger churn, so
measure writes in the CF dashboard before and after a full cron day rather than
assuming.

## Then: more India roles

India roles today come only from the 19 global boards' India offices. Add
India-based robotics/EV/AI companies **that publish a Greenhouse/Lever/Ashby
board** — verify by fetching the feed first, because many Indian firms use
Naukri or Darwinbox, which have no public feed and are off-limits anyway.

Candidates to check: Ather Energy, Ola Electric / Krutrim, ideaForge, Sarvam AI.
Process: verify the feed responds → add to `BOARDS` in `worker/sources.js` →
seed off-platform with `tools/seed.mjs` → backfill embeddings in slices.

## Explicitly not doing

- **The tool-calling loop.** Impressive, smaller payoff. Retrieval is already
  good; a loop mostly spends neurons re-deriving what one good query returns.
  Revisit if the watcher earns its keep and the neuron budget allows.
- **Email notifications.** moggers.in MX points at GoDaddy with `-all` SPF, so
  sending from the domain means editing the record Rahul's working email
  depends on. Deferred, not forgotten.
- **LinkedIn / Indeed / Naukri *listings*.** Republishing scraped postings makes
  us the publisher. (Sign-in *with* LinkedIn is a different thing and is fine —
  see the revamp plan.)
- **Gig-work listings.** Same reason: no public feed exists, so every route to
  them is scraping.
- **The Gemini OAuth quota route.** 1,000 req/day is reachable via
  `cloudcode-pa.googleapis.com/v1internal:generateContent`, but that is the Code
  Assist quota through an internal endpoint meant for Google's own tooling — it
  puts the *user's* account at risk. BYOK with a key they created is the
  supported path and is already built.

## Loose ends unrelated to this work

- Rotate the GitHub and Google OAuth client secrets if they were only re-entered
  rather than regenerated — both were pasted into a chat transcript.
- The revamp plan (mascot, meme copy, shareable verdict card, vocational
  content, LinkedIn sign-in, further AI features) is agreed and sequenced after
  the two items above.
