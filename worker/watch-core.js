/* The watcher's decision logic, with no Durable Object and no SDK attached.
 *
 * It lives apart from agent.js for one reason: `agents` imports
 * `cloudflare:workers`, which vitest cannot resolve, so anything importing the
 * Agent class is untestable in this project's test runner. The rules below are
 * exactly the ones that fail SILENTLY when wrong — a bad eviction order
 * re-announces a role the user already dismissed, a bad diff announces nothing
 * at all and the feature just looks dead — so they are the part that most needs
 * a test. Keep this file free of imports.
 */

/* Nothing can appear faster than the ingest produces it: the cron runs 6-hourly
   and sweeps ONE board per run (the 10 ms CPU ceiling — see README). A watcher
   checking every hour would burn five reads to find the same nothing, so 6h is
   the floor rather than a preference. */
export const INTERVALS = {
  "6h": 6 * 3600,
  daily: 24 * 3600,
  weekly: 7 * 24 * 3600,
};
export const DEFAULT_INTERVAL = "daily";

export function normalizeInterval(value) {
  return Object.hasOwn(INTERVALS, value) ? value : DEFAULT_INTERVAL;
}

/* How many ids to remember. The watcher reads 50 results per run, so this is
   ~12 runs of complete turnover before an id could age out — far past anything
   the 6-hourly ingest can produce. Bounded because this list is serialised into
   Durable Object state on every run. */
export const MAX_SEEN = 600;

/* How many new roles to hold for the user. Someone who ignores the watch for a
   month should get the most recent arrivals, not a 400-row backlog — and this
   is also the ceiling on how big the state blob can grow between visits. */
export const MAX_FRESH = 40;

/* Only the fields the UI renders. The JD is deliberately not among them: it is
   up to 6 kB per role, it is already in D1, and copying it into agent state
   would put megabytes behind a feature whose whole job is to say "these three
   are new". */
export function watchEntry(job, foundAt) {
  return {
    id: job.id,
    company: job.company,
    title: job.title,
    url: job.url,
    location: job.location,
    remote: job.remote,
    posted_at: job.posted_at || job.first_seen || null,
    found_at: foundAt,
  };
}

/**
 * Fold this run's results into the seen set.
 *
 * ORDER IS THE WHOLE POINT. Current results go to the FRONT, so anything still
 * matching the search can never be evicted by the cap and then re-announced as
 * new on the following run. A plain append-and-truncate looks correct and
 * produces exactly that bug: a long-lived posting silently ages out of the
 * window while still sitting in the result set, and the user is told about a
 * role they dismissed weeks ago.
 */
export function mergeSeen(resultIds, previousSeen = [], cap = MAX_SEEN) {
  const merged = [];
  const have = new Set();
  for (const id of [...resultIds, ...previousSeen]) {
    if (!id || have.has(id)) continue;
    have.add(id);
    merged.push(id);
    if (merged.length >= cap) break;
  }
  return merged;
}

/** The roles in this run that the user has not been shown yet. */
export function newArrivals(jobs, previousSeen = []) {
  const seen = new Set(previousSeen);
  return jobs.filter((j) => j?.id && !seen.has(j.id));
}

/**
 * Prepend this run's finds to the pending list.
 *
 * Newest first, de-duplicated by id (a role can reappear across runs if it was
 * evicted from `seen`, and showing it twice reads as a bug), capped.
 */
export function mergeFresh(incoming, existing = [], cap = MAX_FRESH) {
  const out = [];
  const have = new Set();
  for (const entry of [...incoming, ...existing]) {
    if (!entry?.id || have.has(entry.id)) continue;
    have.add(entry.id);
    out.push(entry);
    if (out.length >= cap) break;
  }
  return out;
}

/* A watch with no query and no filters matches the entire board, so the first
   run would bank 2,000 ids and every run after it would report the trickle of
   whatever the rotating sweep touched. That is not a saved SEARCH, it is a
   firehose, and it costs the same D1 reads as a useful one. Require at least
   one narrowing term. */
export function isUsableWatch(search) {
  return Boolean(
    search && (search.q || search.country || search.company || search.remote)
  );
}

/** One-line human summary, so the UI and any log line describe it identically. */
export function describeWatch(search) {
  if (!search) return "";
  const bits = [];
  if (search.q) bits.push(`“${search.q}”`);
  if (search.company) bits.push(search.company);
  if (search.country) bits.push(search.country);
  if (search.remote) bits.push("remote only");
  if (search.mode === "semantic") bits.push("by meaning");
  return bits.join(" · ") || "everything";
}
