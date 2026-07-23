# Next: moggers.in

Handoff for a fresh session. Read `README.md` before touching anything — it
documents the platform limits that broke earlier designs, and each one is a trap
that will be re-hit otherwise.

## Where things stand (2026-07-23)

Everything below is **live and verified in production**, not merely committed.

| | Shipped |
|---|---|
| **Watcher** | `MoggerAgent` Durable Object, one per user. A saved search re-runs on a schedule, diffs against seen ids and surfaces the delta. `/api/watch`, `/watch/check`, `/watch/ack`. |
| **D1 change detection** | `jd_hash` + a conditional FTS trigger. An unchanged posting now writes **0 rows** (measured: 8/row before). ~19k writes/day against the 100k cap, down from ~80k. |
| **Meme layer** | Rank scale (`ABSOLUTELY MOGGED` → `UNMOGGABLE`) in the hero and stamped on the verdict; shareable verdict card (canvas PNG, nothing from the resume on it). |
| **THE MOGGER** | Traced line art. Hero specimen frame with the X-ray scan band, 404, both empty states, footer mark, card 04, resilient page, share card. |
| **Gap → path** | `src/paths.js` — static keyword map, zero AI cost. A `CLOSE THE GAP` row under each match card. |
| **resilient.html** | Six hands-on trade tracks, curated free links. In the nav bar, sitemap and `run_worker_first`. |

## The two candidates for next

### Phase 2 — India boards (unblocked, clear payoff)

The write quota was the gate and it is gone: ~19k/day of 100k, so there is room
for several more boards.

Add India-based robotics/EV/AI companies **that have a public
Greenhouse/Lever/Ashby feed**. Verify by *fetching the feed first* — many Indian
firms use Naukri or Darwinbox, which have no public feed and are off-limits.
Candidates: Ather Energy, Ola Electric / Krutrim, ideaForge, Sarvam AI.

Process: verify the feed responds → add to `BOARDS` in `worker/sources.js` →
seed off-platform with `node tools/seed.mjs` → embed backfill via `/api/embed`.
The title filter keeps only relevant roles regardless.

### Phase 6 — further AI features

**Read the gate first.** The plan says "pick after the watcher proves
retention", and there is no retention data yet — the watcher has been live for
hours, with one user, who then deleted their watch. All three candidates spend
against an 8,000/day neuron budget:

1. **Interview prep per role** — likely questions from a JD. BYOK-first.
2. **Resume bullet roaster** — *the exception*: client-side heuristics
   (weak-verb list, no-metrics detector) are free, need no retention data and
   can ship today without guessing. AI rewrite behind BYOK.
3. **Watcher digest ranking** — rank a delta against the saved resume excerpt,
   **on open only**, never on the schedule. That is the neuron rule the watcher
   was designed around.

Explicitly not: the tool-calling loop, auto-apply, anything that hits the ATS
boards harder.

## Traps this codebase has already paid for

- **Never `wrangler dev --local`.** It refuses the `remote = true` AI/Vectorize
  bindings; semantic search silently degrades to keyword and the matcher 500s.
  Use plain `wrangler dev` — the startup banner must read `remote` for both.
- **`wrangler dev` does not pick up a rebuilt `dist/`.** Restart it after
  `npm run build` or you are testing the previous bundle.
- **`run_worker_first` in `wrangler.toml` is EXCLUSIVE.** Any new `.html` page
  must be added to it or `www.` serves a duplicate of that page.
- **`.html` URLs 307 to the extension-less form.** Point canonicals and internal
  links at `/resilient`, not `/resilient.html`.
- **No inline `<script>` or `style=""`, anywhere** — the CSP carries no hashes
  by design. This includes throwaway preview harnesses; use presentation
  attributes instead.
- **A `<use>` is not a `<path>`.** `src/share.js` reads `d` off the sprite nodes
  to redraw the mascot on canvas, so restructuring the sprite into nested
  `<use>` silently produced a headless cockroach on the share card.
- **`\b` after `+` never matches.** `/\bc\+\+\b/` does not match "C++
  experience". Hit twice now — in `ftsQuery`, and again in `src/paths.js`.
- **Verify external links by requesting them.** Six links in the first draft of
  `resilient.html` were dead, and all six were consumer-content sites.

## Loose ends

- **Rotate the GitHub and Google OAuth client secrets** if they were only
  re-entered rather than regenerated — both were pasted into a chat transcript.
  Phase 5 pairs this with LinkedIn OIDC sign-in, which *is* allowed: the repo's
  LinkedIn ban covers republishing **listings**, not authentication.
- **No scheduled watcher alarm has ever been observed firing.** Creating a watch
  works and `armed` reads 1; `scheduleEvery` re-arming across a real 6h boundary
  is unconfirmed. If it silently becomes a one-shot there is no other symptom —
  check `armed` is still 1 after one fires.
- **The share card has never been eyeballed at full size**, only pixel-sampled.
  It is correct; whether it is *balanced* is unverified.
