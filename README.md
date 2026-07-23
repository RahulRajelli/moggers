# MOGGERS — ATS X-Ray

`moggers.in` — see a resume the way an ATS parser sees it. The checker runs
entirely in the browser: no upload, no account, no storage. Signing in is
optional and buys only saved roles.

```
npm install
npm run dev      # http://localhost:4340  (vite only — no Worker, so no API)
npm test         # vitest — security boundary + normalisers
npm run build    # static output in dist/
npm run deploy   # build + `wrangler deploy`  — a WORKER, not Pages
```

`wrangler pages deploy` is wrong for this project and would deploy nothing
useful: Pages Functions cannot carry the cron trigger the ATS sweep needs.
Prerequisites (DNS, OAuth apps, secrets) are in **[DEPLOY.md](DEPLOY.md)**.

## Why it exists

Every competing tool scores a resume. None check whether the parser can read the
words at all. A match score computed on text an ATS cannot extract is a number
about nothing.

## The checks

Ported from `D:\Job Tracker\jobtracker\pdfcheck.py` — same thresholds, same
verdicts, so the browser agrees with the Python engine on the same file.

| # | Check | Source constant |
|---|-------|-----------------|
| 1 | Text layer present | — |
| 2 | **No ligatures** | `LIGATURES` (U+FB00–FB06) |
| 3 | Page count ≤ 2 | `MAX_RESUME_PAGES` |
| 4 | Text density | `MIN_CHARS_PER_PAGE = 900` |
| 5 | Contact details parseable | `CONTACT_RX` |

Optional: paste a JD to check its keywords against the **raw** text layer.
JDs under `MIN_JD_CHARS = 1500` are flagged as fragments — they inflate every
keyword score, including competitors'.

## The one thing not to break

`extractPdf()` calls `getTextContent({ disableNormalization: true })`.

Left on (the pdf.js default), normalization silently rewrites `U+FB01` to `fi`,
which **hides the exact defect this tool exists to find** and disagrees with
pypdf, pdftotext, and any real ATS. pdf.js also emits a ligature as its own text
item, so items are concatenated with **no separator** — joining on `" "` would
fabricate `veri ﬁ cation`.

Verified against the Python engine on `public/sample/broken-resume.pdf`:
both report 30 ligature glyphs and the same affected words
(`veriﬁcation`, `qualiﬁcation`, `ﬁxed-wing`, `Eﬃcient`, `ﬂight-test`, `workﬂows`).

## Accounts (`worker/auth.js`, `src/auth.js`)

**OAuth only — GitHub and Google. There is no password column and none should
ever be added.** Not storing credentials is the entire point: no hashing, no
reset flow, no credential-stuffing defence to own.

What is gated, and why it matters: **ATS X-Ray never asks who you are.** It is
client-side, costs nothing to serve, and is the top of the funnel — gating it
would trade the only real distribution advantage for nothing. Browsing roles is
open too. An account buys exactly one thing today (saved roles) and later the
matcher. *If a feature does not need identity, it must not sit behind sign-in.*

Design points that are load-bearing:

- **This does not break the CSP.** The provider round trip is a top-level
  *navigation*, not a `fetch`, and the token exchange happens server-side in the
  Worker. `connect-src 'self'` holds; the page still contacts one origin.
- **Sessions are stored hashed.** `sessions.id` is the SHA-256 of the token; the
  cookie carries the secret. A dump of the table is not a set of usable logins.
- **`state` is the security-critical parameter**, validated and single-use
  (deleted whether or not it matched). These are confidential clients — the
  secret never leaves the Worker — so PKCE adds little, and GitHub's support for
  it is inconsistent. Deliberately omitted.
- **The callback reports only `failed`.** Distinguishing a CSRF rejection from a
  misconfigured provider would tell an attacker which one they hit.
- **Cookie:** `HttpOnly; Secure; SameSite=Lax`, 30 days. Lax rather than Strict
  so returning from the provider redirect carries it.
- **Mutations check `Origin`** on top of SameSite, and `job_id` is validated
  against the `jobs` table rather than trusted from the client.
- **Deletion is real.** `DELETE /api/account` removes the user row; `sessions`
  and `saved_jobs` cascade. Nothing is soft-deleted — that is what the privacy
  page promises and what the DPDP Act expects.
- `purgeExpired()` runs on the cron; `sessions` and `oauth_state` grow unbounded
  without it.

Secrets required: `GITHUB_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET`. Callback
URL is `<origin>/auth/callback/<provider>`.

### Testing a session locally

You cannot complete a real OAuth round trip against `wrangler dev`. Forge one:
insert a `users` row plus a `sessions` row whose `id` is the SHA-256 of a token
you choose, then send `Cookie: mog_session=<token>`.

**Use `HttpClient` with `UseCookies = $false`, not `Invoke-WebRequest`** —
PowerShell 5.1 silently drops a `Cookie` header supplied via `-Headers` because
it manages cookies through a `CookieContainer`. That failure looks exactly like a
broken session and cost a debugging round.

## Security posture

**CSP is the enforcement of the privacy claim, not decoration.** `public/_headers`
sets `connect-src 'self'`, so the browser itself refuses any connection to a
third-party origin. The page cannot exfiltrate a resume even if a future
dependency tried to. Verified: a full session contacts exactly one origin.

Two scope rules that are easy to get wrong:

- `_headers` applies to **static assets only**. Cloudflare does not apply it to
  responses generated by Worker code, so every `/api/*` response sets its own
  headers via `withSecurity()` in `worker/security.js`. **Change one, change the
  other.**
- **No inline scripts, ever.** `index.html` carries one external `<script>`, so
  the CSP needs no hashes and no build step — unlike robosimtools, which hashes
  Astro's inline blocks. Adding an inline `<script>` or a `style=""` attribute
  will be blocked. Fix the markup, don't loosen the policy.

`build.assetsInlineLimit: 0` in `vite.config.js` is load-bearing. Vite's default
inlines sub-4 kB assets as `data:` URIs, which turned Fontsource subsets into
`url(data:font/woff2;...)` that `font-src 'self'` then refused — silently
falling back to system fonts. Emitting real files was the right fix; adding
`data:` to `font-src` would have weakened the policy for a minor perf win.

### API hardening (`worker/security.js`)

| Control | Behaviour |
|---|---|
| Rate limit | `[[ratelimits]]` binding, 60 req/60s per `CF-Connecting-IP` |
| Fail mode | **Open** for read endpoints (a missing binding must not 503 the site). Anything with real per-call cost must pass `failClosed: true` |
| Methods | Read endpoints GET-only; `/api/sync` POST-only |
| Sync auth | `x-sync-token` **header**, not a query param — a token in a URL leaks into history, proxy logs and `Referer`. Compared with `safeEqual()` |
| Errors | Never returned to the client; D1 messages can echo SQL and column names |
| Caching | One `READ_CACHE` constant for all read endpoints. They previously drifted and `/api/facets` served a stale total against a fresh `/api/jobs` |

**The rate limiter cannot be verified locally** — Cloudflare's binding is a no-op
in `wrangler dev` and only enforces at the edge. 80 rapid local requests all
return 200. Decision logic is unit-tested with a stub; real enforcement is a
post-deploy check.

### XSS boundary

Job titles, companies and URLs come from third-party ATS feeds and are
interpolated into `innerHTML`. `escapeHtml()` escapes all five of `& < > " '`.

`safeUrl()` exists because escaping is **not sufficient for an href**:
`javascript:alert(1)` contains nothing `escapeHtml` touches. Only `http`/`https`
survive; anything else renders as a non-clickable `.job--nolink` card.
Covered by `tests/security.test.js`.

## The 10 ms CPU ceiling — read before touching sync

**On the Workers Free plan, Cron Triggers get the same 10 ms CPU limit as HTTP
requests.** This is not obvious and it is not documented anywhere prominent. The
original design swept all 19 boards in one invocation. It worked perfectly in
`wrangler dev --local` (which does not enforce limits) and failed in production
with a bare `1102 / Worker exceeded resource limits` — no stack, no clue. Live
Roles would have stayed empty forever with nothing reporting a fault.

Three consequences, all load-bearing:

1. **`/api/sync` requires `?boards=<token>[,<token>]`** and refuses a full sweep
   with a 400 that says why. A slice fits; nineteen boards do not.
2. **Cron sweeps ONE board per run**, rotating on a slot derived from the clock
   (so a missed run doesn't desync). At 4 runs/day the set refreshes about every
   5 days.
3. **Initial fill runs off-platform** — `tools/seed.mjs` executes the same
   fetchers and normaliser in Node, where no CPU limit applies, and emits SQL:
   ```
   node tools/seed.mjs > seed.sql
   npx wrangler d1 execute moggers --remote --file=seed.sql -y
   ```

**Workers Paid ($5/mo) raises cron CPU to 30 s**, at which point items 1 and 2
can revert to a full sweep. Until then this is the shape.

### The title filter (`isRelevantTitle` in `worker/sources.js`)

Does two jobs, and the second is why it is not optional.

**Product:** this is a robotics / physical-AI board. Unfiltered, Anduril's 2,147
roles bury the ~200 an engineer wants under recruiters, counsel and facilities
staff.

**CPU:** the expensive step is `toText()` running six regex passes per JD.
Titles are cheap to test, so filtering on title **before** parsing means the
costly work only runs on survivors. **Order matters — test title, then parse.**
Raw JDs are also clipped to 6 kB (`MAX_RAW_JD`) before parsing, since `toText()`
cost scales with length.

Measured on the real corpus: **5,618 seen → 2,244 kept**, 60% dropped.

`sync()` returns `seen`, `fetched` and `skipped_by_title` so the filter's effect
is visible. A filter that quietly drops most of a corpus is indistinguishable
from a broken fetcher unless you can see both numbers.

**Regex gotcha, already hit once:** stems match as prefixes (`recruit\w*`), not
whole words. `\brecruit\b` looks correct and silently fails on "Recruiter" —
a trailing `\b` cannot sit between two word characters. "Technical Recruiter,
Hardware" then matched the include list on "hardware" and survived. Covered by
`tests/security.test.js`.

## Search and facets (`migrations/0002-fts-facets.sql`)

**The binding constraint is not storage — it is the 5M row reads/day quota.**
5 GB holds roughly 730k jobs, but a full table scan of 50k rows would exhaust
the read quota in ~100 requests. Indexed lookups touch tens of rows. That is
what makes growing the corpus possible at all, and why this is not an
optimisation.

Three scans were removed from the read path:

| Was | Now |
|---|---|
| `jd LIKE '%q%'` — a leading wildcard cannot use an index, so every query scanned every row's 6 kB blob | **FTS5** external-content index (`content='jobs'`, so text is not stored twice) with BM25 relevance |
| `GROUP BY company, title, location` on every request | **stored `dedup_key`**, indexed, written at upsert |
| `COUNT(DISTINCT …)` over the whole table per `/api/facets` call | **precomputed** `facet_counts` / `facet_meta`, rebuilt by `refreshFacets()` after each sync |

Measured in production: search **114–135 ms**, facets **118 ms**.

### FTS gotchas, both hit during implementation

**`ftsQuery()` must return `""`, never `null`, for unusable input.** FTS5 query
syntax is a real grammar — `"`, `*`, `NEAR`, unbalanced parens all raise
SQLITE_ERROR — so every token is quoted as a literal. But the first version
dropped 1-char tokens, which reduced `c++` to an empty token list, returned
`null`, and **silently fell through to an unfiltered query returning all 5,103
rows**. Returning the entire corpus for a search term is the worst possible
answer. `listJobs()` now treats `""` as "match nothing".

**bm25 returns NEGATIVE scores** — more negative is a better match. Ordering is
`MIN(f.rank) ASC`; `MAX()` would rank the worst hit first.

**`dedup_key` must be written on the UPDATE branch too**, or a retitled posting
keeps a stale key and silently stops collapsing with its twin.

Triggers keep `jobs_fts` in sync. External-content FTS tables are not
auto-populated, and `'delete'` rows must carry the OLD values or the index
corrupts silently.

## Live roles (`worker/`, `schema.sql`)

A job index over the **public ATS board feeds** — the no-auth JSON endpoints
Greenhouse / Lever / Ashby publish so their customers' careers pages can render
"View open positions". Same URLs the company's own site calls. Endpoints match
`jobtracker/fetch.py`, which is where they were proven.

**Never add LinkedIn, Indeed or Naukri.** Assisted browsing under your own login
for your own job hunt is one thing; republishing scraped listings on a public
site makes us the publisher. `worker/sources.js` says so at the top — keep it.

```
Cron (6-hourly) → fetch 19 boards → normalise → D1
Worker /api/jobs?q=&country=&company=&remote=  →  JSON
       /api/facets                             →  counts for the filters
       /api/sync?token=…                       →  manual sweep (SYNC_TOKEN secret)
```

One Worker, not Pages: Pages Functions cannot carry a cron trigger.

Three behaviours worth knowing:

- **Closure detection.** A posting is closed when it stops appearing in its own
  board feed — far better than re-requesting the URL, since boards return HTTP
  200 on an expired posting and redirect to a "create a job alert" page. Scoped
  per source, so one failing board can never mass-close its own jobs.
- **De-duplication happens at query time**, not on write: `GROUP BY company,
  title, location`, mirroring `dedup_jobs` in the tracker. Companies really do
  double-post (Anthropic had one London role under two Greenhouse ids). Every
  row stays in the table so a bad grouping is visible and reversible, and the
  card shows "N postings" rather than silently swallowing them. Different
  *cities* stay separate — one role open in four cities is four jobs.
- **Thin JDs are excluded by default** (`thin = 0`, under 1500 chars), for the
  same reason the X-Ray warns about them: they inflate keyword coverage.

Verified against the live feeds: 19/19 boards responded, 5,591 postings fetched,
0 errors, 5,092 roles after de-duplication, 1,027 remote, 17 countries.

### Local development

```
npm run build
npx wrangler d1 execute moggers --local --file=schema.sql
echo SYNC_TOKEN=local-dev-only > .dev.vars
npx wrangler dev --port 4341 --local
curl "http://127.0.0.1:4341/api/sync?token=local-dev-only"
```

`wrangler dev` does **not** pick up a rebuilt `dist/` — restart it after
`npm run build` or it serves a stale asset manifest and the dynamic chunks 404.

`vite dev` has no Worker behind it, so `/api/*` is absent and the Live Roles
section removes itself. That is deliberate: the X-Ray must never depend on the
job index being up.

## THE SPECIMEN (inline SVG in `index.html`)

Hand-authored orthographic line art — a figure with a band sweeping down it,
lighting only the slice inside. Faceless and genderless by construction, and in
the same drafting language planned for robosimtools.

**It used to be WebGL and should not go back.** Removing three.js deleted a
**515 kB chunk (130 kB gzipped)** — by an order of magnitude the heaviest thing
on the page — and replaced it with ~2 kB of markup, no GPU, no loader, no async
chunk and no silent-failure path. The procedural bust it replaced could never
have looked right: a `LatheGeometry` is a surface of revolution and human
proportion is not.

Two implementation notes:

- **The clip-path is on the outer `<svg>`, an element in HTML flow — not on the
  inner `<g>`.** Applied to an SVG `<g>`, `inset()` percentages do not resolve
  and the animation sits frozen on its first keyframe. Hence two stacked `<svg>`
  elements sharing one `<g id="figure">` via `<use>`.
- `prefers-reduced-motion` parks the band mid-torso rather than removing it, so
  the figure still reads as sectioned.

**Verifying the motion:** CSS animations do not advance when the browser pane is
hidden — the document timeline freezes and `requestAnimationFrame` never fires,
so a sampled `clip-path` looks stuck on keyframe one. That is the environment,
not a bug. Drive it deterministically instead:

```js
const a = document.getAnimations().find(x => x.animationName === 'specimen-scan');
a.currentTime = 2300;  // expect inset(43% 0px) — a 14%-tall band at mid-height
```

## Sample fixture

`public/sample/broken-resume.pdf` is a synthetic resume rendered through Edge
headless in **Calibri with ligatures left on** — the same font and pipeline that
produced the original bug. Regenerate with `--print-to-pdf` from an HTML that
sets `font-variant-ligatures: common-ligatures`.

## Privacy

The PDF is parsed by `pdf.js` in the visitor's own browser. There is no backend,
no analytics on file contents, and nothing is persisted. Any change that adds an
upload path invalidates the claim made on the page — don't make one quietly.
