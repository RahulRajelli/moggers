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
| **Bullet roast** | `src/roast.js` — six objective checks on resume bullets. Client-side, free, no account, no AI call. |
| **Interview prep** | `/api/interview` — questions drawn from a posting's own JD. BYOK-first, shared budget hard-capped at 110 neurons/call. |

## Next up

Both of these were chosen deliberately; neither is blocked.

### Phase 2 — India roles

The write quota was the gate and it is gone: ~19k/day of 100k, so there is room
for several more boards.

India roles today arrive only as the India offices of the 19 global boards. Add
India-based robotics / EV / AI companies **that publish a Greenhouse, Lever or
Ashby feed**.

**Verify the feed responds BEFORE adding anything.** Many Indian firms run on
Naukri or Darwinbox, which have no public feed and are off-limits — the repo
bans scraping for publisher-liability reasons, and that rule does not bend for
a good candidate. Worth checking: Ather Energy, Ola Electric / Krutrim,
ideaForge, Sarvam AI.

Process per board: confirm the feed → add to `BOARDS` in `worker/sources.js` →
seed off-platform with `node tools/seed.mjs` (a full sweep cannot run in a
Worker; that is the 10 ms CPU limit, not a bug) → backfill embeddings via
`/api/embed` in slices.

Check `sync()`'s `seen / fetched / skipped_by_title` per board afterwards. The
title filter is aggressive by design, and a board that contributes 3 roles out
of 400 is worth knowing about before it is permanent.

### Phase 7 — the launch video

~60–85 s, rendered offline with the **existing Codex + Remotion pipeline** used
for the robosimtools promo (see the `files/` directory beside this repo). Reuse
its conventions rather than reinventing them:

- **All timing lives in `src/edl.ts`.** Nothing else holds durations.
- **`--gl=angle` is required** on this machine or the render fails.
- The honesty stance from that project applies here too: do not imply
  capability the product does not have.

Beats already agreed:

1. Ligature glitch hook — "your resume says veriﬁcation… the parser sees □"
2. The X-Ray scan
3. Live roles
4. MATCH ME, landing on a named gap
5. The watcher — "we watch 19 boards so you don't"
6. THE MOGGER adjusting his tie
7. "SURVIVE THE FILTER. moggers.in"

**The 3D Mogger lives in the video and nowhere else.** The site deliberately
deleted three.js once (130 kB gzipped); the video is rendered offline, so it
costs the site zero bytes. The traced 2D art is in `index.html`'s sprite
(`#moggerInk` / `#moggerAcid`) if a reference is wanted.

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
