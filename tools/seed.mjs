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
import { normalizeJob } from "../worker/normalize.js";

const sql = (v) =>
  v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;

const now = new Date().toISOString();
const results = await Promise.all(BOARDS.map(fetchBoard));

let seen = 0, kept = 0;
const seenIds = new Set();
const lines = [];

for (const r of results) {
  seen += r.seen || 0;
  if (r.error) {
    console.error(`  ! ${r.board.token}: ${r.error}`);
    continue;
  }
  for (const row of r.rows) {
    const j = normalizeJob(row, r.board);
    if (seenIds.has(j.id)) continue; // a role listed in several cities arrives twice
    seenIds.add(j.id);
    kept++;
    const dedup = `${j.company}|${j.title}|${j.location ?? ""}`;
    lines.push(
      `INSERT INTO jobs (id,source,company,title,url,location_raw,location,country,` +
      `remote,jd,jd_chars,thin,posted_at,first_seen,last_seen,active,dedup_key) VALUES (` +
      [j.id, j.source, j.company, j.title, j.url, j.location_raw, j.location, j.country]
        .map(sql).join(",") +
      `,${j.remote},${sql(j.jd)},${j.jd_chars},${j.thin},${sql(j.posted_at)},` +
      `${sql(now)},${sql(now)},1,${sql(dedup)}) ON CONFLICT(id) DO UPDATE SET ` +
      `title=excluded.title,url=excluded.url,location_raw=excluded.location_raw,` +
      `location=excluded.location,country=excluded.country,remote=excluded.remote,` +
      `jd=excluded.jd,jd_chars=excluded.jd_chars,thin=excluded.thin,` +
      `posted_at=excluded.posted_at,last_seen=excluded.last_seen,active=1,` +
      `dedup_key=excluded.dedup_key;`
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

lines.push(
  `INSERT OR REPLACE INTO sync_log (ran_at,boards,fetched,upserted,closed,errors) ` +
  `VALUES (${sql(now)},${BOARDS.length},${kept},${kept},0,NULL);`
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
