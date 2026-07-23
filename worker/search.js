/* Job search — one implementation, two callers.
 *
 * This was inline in worker/index.js until the watcher landed. The watcher
 * re-runs a user's saved search on a schedule and reports what is new; if it ran
 * its own query the two would drift, and a watcher that disagrees with the site
 * is worse than no watcher, because by then the user has stopped checking for
 * themselves. Same filters, same de-duplication, same fallback, both callers.
 *
 * Callers pass a plain object rather than a URL: the HTTP route has a
 * URLSearchParams, the agent has a saved-search record in Durable Object state,
 * and neither should have to fake the other's shape.
 */
import { semanticSearch } from "./embed.js";

/* Deliberately below the 200 the HTTP endpoint allows. The watcher only needs
   enough of the head of the result set to notice new arrivals, and every row it
   reads comes out of the same 5M/day D1 quota the public site is living on. */
export const WATCH_LIMIT = 50;

/* Turn anything caller-shaped into the one set of parameters the query
   understands. Strings ("1") and booleans (true) both mean "on" — the route
   gets the first from a query string, the agent gets the second from JSON. */
export function normalizeSearch(raw = {}) {
  const on = (v) => v === "1" || v === true || v === 1;
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const int = (v, dflt, max) => {
    const n = parseInt(v, 10);
    return Math.min(Number.isFinite(n) && n > 0 ? n : dflt, max);
  };

  return {
    q: str(raw.q).slice(0, 200),
    country: str(raw.country).slice(0, 80),
    company: str(raw.company).slice(0, 120),
    remote: on(raw.remote),
    /* Thin JDs inflate every keyword score, which is the same reason the X-Ray
       warns about them — so they are excluded unless asked for. */
    includeThin: on(raw.thin),
    mode: raw.mode === "semantic" ? "semantic" : "keyword",
    limit: int(raw.limit, 50, 200),
    offset: Math.max(parseInt(raw.offset, 10) || 0, 0),
  };
}

/* Turn user input into an FTS5 MATCH expression.
 *
 * FTS5 query syntax is a real grammar: bare `"`, `*`, `-`, `NEAR`, `AND`/`OR`
 * and unbalanced parens all raise SQLITE_ERROR, which would surface as a 500 on
 * a typo. So every token is quoted as a literal — quoting is also what makes
 * `c++` and `ROS2` searchable rather than parse errors.
 *
 * Prefix-matching the final token ("robot" → "robot"*) makes search feel live
 * as the user types, which is how the debounced input actually behaves. */
export function ftsQuery(raw) {
  const tokens = String(raw)
    .toLowerCase()
    .split(/[^\p{L}\p{N}+#.]+/u)
    /* Strip trailing punctuation the unicode61 tokenizer discards anyway, so
       "c++" searches for the indexed token "c" rather than the literal "c++",
       which matches nothing. Keep 1-char results: dropping them turned "c++"
       into an empty token list. */
    .map((t) => t.replace(/[+#.]+$/g, ""))
    .filter(Boolean)
    .slice(0, 8); // a 40-word paste should not become a 40-clause query
  if (!tokens.length) return "";
  const quoted = tokens.map((t) => `"${t.replace(/"/g, '""')}"`);
  /* Prefix only the final token, and only when it is long enough to be
     selective — a 2-char prefix like "ai"* matches half the index and drowns
     the ranking. */
  const last = quoted.length - 1;
  if (tokens[last].length >= 3) quoted[last] += "*";
  return quoted.join(" AND ");
}

/* The columns every caller renders. Kept in one place so the watcher's payload
   and the job list can never describe a role differently. */
const COLUMNS = `j.id, j.company, j.title, j.url, j.location, j.location_raw,
                 j.country, j.remote, j.jd_chars, j.first_seen`;

/* Semantic path: Vectorize gives ranked ids, D1 supplies every displayable
   field and applies the same filters and de-duplication as keyword search.
   Vectorize stores only ids, so there is one source of truth and the index can
   never serve a stale title. */
async function semantic(env, p) {
  /* Over-fetch to the cap: filters are applied AFTER ranking, so a narrow
     filter can leave few survivors. 100 is Vectorize's hard maximum. */
  const ranked = await semanticSearch(env, p.q, { topK: 100 });
  if (!ranked.length) {
    return { jobs: [], total: 0, limit: p.limit, offset: p.offset, mode: "semantic" };
  }

  const rank = new Map(ranked.map((r, i) => [r.id, { i, score: r.score }]));
  const ids = ranked.map((r) => r.id);

  const where = ["j.active = 1", `j.id IN (${ids.map(() => "?").join(",")})`];
  const binds = [...ids];
  const bind = (v) => { binds.push(v); return "?"; };

  if (p.country) where.push(`j.country = ${bind(p.country)}`);
  if (p.company) where.push(`j.company = ${bind(p.company)}`);
  if (p.remote) where.push("j.remote = 1");
  if (!p.includeThin) where.push("j.thin = 0");

  const rows = await env.DB.prepare(
    `SELECT ${COLUMNS},
            MAX(COALESCE(j.posted_at, j.first_seen)) AS posted_at,
            COUNT(*) AS listings
     FROM jobs j WHERE ${where.join(" AND ")}
     GROUP BY j.dedup_key`
  ).bind(...binds).all();

  /* Restore Vectorize's ordering — SQL returned rows in arbitrary order, and
     the whole point of this path is the ranking. */
  const all = (rows.results || [])
    .map((r) => ({ ...r, _score: rank.get(r.id)?.score ?? 0, _i: rank.get(r.id)?.i ?? 1e9 }))
    .sort((a, b) => a._i - b._i);

  return {
    jobs: all.slice(p.offset, p.offset + p.limit)
             .map(({ _i, _score, ...j }) => ({ ...j, score: _score })),
    total: all.length,
    limit: p.limit, offset: p.offset, mode: "semantic",
  };
}

async function keyword(env, p) {
  const where = ["j.active = 1"];
  const binds = [];
  const bind = (v) => {
    binds.push(v);
    return `?${binds.length}`;
  };

  /* FTS5 replaces `jd LIKE '%q%'`, which could not use an index and scanned
     every row's 6 kB blob. Joining against the external-content index turns it
     into an inverted-index lookup, and gives BM25 relevance ordering for free. */
  const match = p.q ? ftsQuery(p.q) : null;

  /* A search that reduces to nothing usable must return NOTHING, not the whole
     corpus. Falling through to an unfiltered query is the worst possible
     answer: "c++" briefly returned all 5,103 rows because its tokens were
     stripped to empty and the search was silently dropped. */
  if (match === "") return { jobs: [], total: 0, limit: p.limit, offset: p.offset, mode: "keyword" };

  const from = match
    ? `jobs j JOIN jobs_fts f ON f.rowid = j.rowid AND jobs_fts MATCH ${bind(match)}`
    : `jobs j`;

  if (p.country) where.push(`j.country = ${bind(p.country)}`);
  if (p.company) where.push(`j.company = ${bind(p.company)}`);
  if (p.remote) where.push("j.remote = 1");
  if (!p.includeThin) where.push("j.thin = 0");

  /* Collapse duplicate postings of the same role. `dedup_key` is stored and
     indexed rather than built per query — companies really do double-post a req
     (Anthropic had one London role under two Greenhouse ids). Different CITIES
     stay separate: one role open in four cities is four jobs.

     Grouped, never deleted: every row stays in the table, so a bad grouping is
     visible and reversible. SQLite resolves the bare columns from the row that
     produced MAX(), so the surviving link is the freshest one. */
  const group = `GROUP BY j.dedup_key`;

  /* Relevance when searching, recency when browsing. MIN(rank) because bm25
     returns NEGATIVE scores — more negative is a better match, so ascending is
     correct and MAX() would rank the worst hit first. */
  const order = match
    ? `ORDER BY MIN(f.rank) ASC, posted_at DESC`
    : `ORDER BY posted_at DESC`;

  const sql = `
    SELECT ${COLUMNS},
           MAX(COALESCE(j.posted_at, j.first_seen)) AS posted_at,
           COUNT(*) AS listings
    FROM ${from}
    WHERE ${where.join(" AND ")}
    ${group}
    ${order}
    LIMIT ${p.limit} OFFSET ${p.offset}`;

  const countSql = `
    SELECT COUNT(*) AS n FROM (
      SELECT 1 FROM ${from} WHERE ${where.join(" AND ")} ${group}
    )`;

  try {
    const [rows, total] = await Promise.all([
      env.DB.prepare(sql).bind(...binds).all(),
      env.DB.prepare(countSql).bind(...binds).first(),
    ]);
    return { jobs: rows.results || [], total: total?.n ?? 0, limit: p.limit, offset: p.offset, mode: "keyword" };
  } catch (err) {
    /* A malformed MATCH is user input, not a server fault — report it as an
       empty result rather than a 500. */
    if (match && /fts5|MATCH|syntax/i.test(String(err))) {
      return { jobs: [], total: 0, limit: p.limit, offset: p.offset, mode: "keyword" };
    }
    throw err;
  }
}

/**
 * Run a search. `raw` is anything normalizeSearch understands.
 *
 * Semantic is opt-in and only meaningful with a query — it costs a Workers AI
 * call, so it must never run for the unfiltered browse view or for a crawler.
 * Any failure falls back to FTS rather than erroring: a degraded search beats no
 * search, and this fallback is what surfaced both Vectorize bugs in embed.js.
 */
export async function searchJobs(env, raw) {
  const p = normalizeSearch(raw);
  if (p.mode === "semantic" && p.q && env.AI && env.VECTORIZE) {
    try {
      return await semantic(env, p);
    } catch (err) {
      console.error("semantic search failed, falling back to fts", err);
    }
  }
  return keyword(env, p);
}
