/* One-shot seeder: runs the full 19-board sweep in Node, emits SQL.
 *
 * Why this exists: the Worker cannot do a full sweep. The free plan allows 10 ms
 * of CPU per invocation (cron included) and parsing thousands of job
 * descriptions is orders of magnitude over — it fails with a bare 1102. Node has
 * no such limit, so the initial fill happens here and the result is applied with
 * `wrangler d1 execute --remote --file`.
 *
 * Reuses the Worker's own fetchers and normaliser, so seeded rows are identical
 * to cron-written ones — no second code path to drift.
 *
 *   node tools/seed.mjs > seed.sql
 *   npx wrangler d1 execute moggers --remote --file=seed.sql -y
 */
import { BOARDS, fetchBoard } from "../worker/sources.js";
import {
  normalizeJob, hoursAgo, REFRESH_AFTER_HOURS, CLOSE_AFTER_HOURS,
} from "../worker/normalize.js";

const sql = (v) =>
  v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;

const now = new Date().toISOString();
/* Change detection. This file is where it matters most: the Worker cron sweeps
   one board, this sweeps all nineteen, four times a day, and it is what was
   sitting at 83% of the D1 write quota. Same two clocks as sync(), same
   reasoning — see normalize.js. */
const refreshBefore = hoursAgo(REFRESH_AFTER_HOURS);
const closeBefore = hoursAgo(CLOSE_AFTER_HOURS);
const results = await Promise.all(BOARDS.map(fetchBoard));

let seen = 0, kept = 0;
const seenIds = new Set();
const lines = [];
const healthy = [];

for (const r of results) {
  seen += r.seen || 0;
  if (r.error) {
    console.error(`  ! ${r.board.token}: ${r.error}`);
    continue;
  }
  healthy.push(`${r.board.ats}:${r.board.token}`);
  for (const row of r.rows) {
    const j = normalizeJob(row, r.board);
    if (seenIds.has(j.id)) continue; // a role listed in several cities arrives twice
    seenIds.add(j.id);
    kept++;
    const dedup = `${j.company}|${j.title}|${j.location ?? ""}`;
    lines.push(
      `INSERT INTO jobs (id,source,company,title,url,location_raw,location,country,` +
      `remote,jd,jd_chars,thin,posted_at,first_seen,last_seen,active,dedup_key,jd_hash) VALUES (` +
      [j.id, j.source, j.company, j.title, j.url, j.location_raw, j.location, j.country]
        .map(sql).join(",") +
      `,${j.remote},${sql(j.jd)},${j.jd_chars},${j.thin},${sql(j.posted_at)},` +
      `${sql(now)},${sql(now)},1,${sql(dedup)},${sql(j.jd_hash)}) ON CONFLICT(id) DO UPDATE SET ` +
      `title=excluded.title,url=excluded.url,location_raw=excluded.location_raw,` +
      `location=excluded.location,country=excluded.country,remote=excluded.remote,` +
      `jd=excluded.jd,jd_chars=excluded.jd_chars,thin=excluded.thin,` +
      `posted_at=excluded.posted_at,last_seen=excluded.last_seen,active=1,` +
      `dedup_key=excluded.dedup_key,jd_hash=excluded.jd_hash ` +
      /* Write only when there is a reason to: the content changed, a closed
         posting is back, or the heartbeat is due. Everything else is left
         untouched — which is the whole saving, since most postings do not
         change between two sweeps six hours apart. */
      `WHERE jobs.jd_hash IS NOT excluded.jd_hash OR jobs.active = 0 ` +
      `OR jobs.last_seen < ${sql(refreshBefore)};`
    );
  }
  console.error(`  ${r.board.token.padEnd(20)} ${String(r.seen).padStart(5)} seen -> ${String(r.rows.length).padStart(4)} kept`);
}

/* Refuse to emit a suspiciously empty sweep.
 *
 * Matters far more in CI than by hand: if every fetch failed (network blip,
 * upstream outage), `kept` is 0, and the facet refresh below would happily set
 * total=0 while the jobs table still holds thousands of rows. The site would
 * show "0 open right now" over a perfectly good corpus. Failing loudly with a
 * non-zero exit is the correct outcome — the previous data stays untouched. */
const MIN_EXPECTED = 200;
if (kept < MIN_EXPECTED) {
  console.error(
    `\n  ABORT: only ${kept} jobs kept (expected >= ${MIN_EXPECTED}).\n` +
    `  Emitting nothing so the existing corpus is left intact.`
  );
  process.exit(1);
}

/* Closure detection, which this file used to leave entirely to the Worker cron
 * — and the Worker cron sweeps ONE board per run, so a role pulled from a feed
 * could sit on the site for the ~5 days it takes the rotation to come back
 * round to that board.
 *
 * It matters more now than it did. Under the old scheme this sweep bumped
 * `last_seen` on every row every six hours, so the Worker's closure pass had a
 * fresh timestamp to compare against; with the heartbeat slowed down, closing
 * had to move to wherever all nineteen boards are actually seen. That is here.
 *
 * Cutoff, not "this run's timestamp": last_seen is only refreshed every ~20h,
 * so comparing against `now` would close the entire live corpus. Scoped to
 * boards that responded, so a single failing feed cannot mass-close its own
 * jobs — and the MIN_EXPECTED guard above has already aborted the whole file if
 * the sweep looks broken, so this line is never reached on a bad run. */
if (healthy.length) {
  lines.push(
    `UPDATE jobs SET active=0 WHERE active=1 AND last_seen < ${sql(closeBefore)} ` +
    `AND source IN (${healthy.map(sql).join(",")});`
  );
}

lines.push(
  `INSERT OR REPLACE INTO sync_log (ran_at,boards,fetched,upserted,closed,errors) ` +
  `VALUES (${sql(now)},${healthy.length},${kept},${kept},0,NULL);`
);

/* Facets are derived, so a seed that skipped this would leave /api/facets
   reporting whatever the previous run saw. Mirrors refreshFacets(). */
const BASE = `FROM jobs WHERE active = 1 AND thin = 0`;
lines.push(
  `DELETE FROM facet_counts;`,
  `INSERT INTO facet_counts (kind,value,n) SELECT 'country', country, COUNT(DISTINCT dedup_key) ${BASE} AND country IS NOT NULL GROUP BY country;`,
  `INSERT INTO facet_counts (kind,value,n) SELECT 'company', company, COUNT(DISTINCT dedup_key) ${BASE} GROUP BY company;`,
  `INSERT OR REPLACE INTO facet_meta (id,total,remote,synced_at) SELECT 1, COUNT(DISTINCT dedup_key), COUNT(DISTINCT CASE WHEN remote=1 THEN dedup_key END), MAX(last_seen) ${BASE};`
);

console.error(`\n  TOTAL  ${seen} seen -> ${kept} kept (${seen - kept} dropped by title filter)`);
process.stdout.write(lines.join("\n") + "\n");
