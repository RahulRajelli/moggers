/* moggers.in — Worker: static assets + job API + scheduled ATS sweep.
 *
 * One Worker rather than Pages + a separate cron Worker: Pages Functions cannot
 * carry a cron trigger, and splitting them means two deploys sharing one D1.
 */
import { BOARDS, fetchBoard } from "./sources.js";
import { normalizeJob } from "./normalize.js";
import {
  withSecurity, READ_CACHE, clientKey, checkRate, tooManyRequests, safeEqual,
} from "./security.js";
import {
  PROVIDERS, startLogin, completeLogin, currentUser, logout, deleteAccount, purgeExpired,
} from "./auth.js";
import { indexJobs, semanticSearch, EMBED_MODEL, EMBED_DIMS, BATCH } from "./embed.js";
import { matchResume, checkBudget, chargeBudget, DAILY_NEURON_BUDGET } from "./match.js";

/* SameSite=Lax already withholds the session cookie from cross-site POSTs, so
   this is belt-and-braces — but it is two lines and it closes the gap for any
   future route that relaxes the cookie policy. */
function sameOrigin(request, url) {
  const origin = request.headers.get("origin");
  return !origin || origin === url.origin;
}

function redirect(location, cookieHeader) {
  const headers = new Headers({ location });
  if (cookieHeader) headers.append("set-cookie", cookieHeader);
  return new Response(null, { status: 302, headers });
}

/* Cache-control is applied by withSecurity(), never here — a single place to
   set it is what stops /api/jobs and /api/facets drifting apart again. */
const json = (data, status = 200, cache) =>
  withSecurity(
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
    { cache }
  );


/* ── API ──────────────────────────────────────────────────────────────── */

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

/* Semantic path: Vectorize gives ranked ids, D1 supplies every displayable
   field and applies the same filters and de-duplication as keyword search.
   Vectorize stores only ids, so there is one source of truth and the index can
   never serve a stale title. */
async function listJobsSemantic(env, url, query) {
  const p = url.searchParams;
  const limit = Math.min(parseInt(p.get("limit") || "50", 10) || 50, 200);
  const offset = Math.max(parseInt(p.get("offset") || "0", 10) || 0, 0);

  /* Over-fetch to the cap: filters are applied AFTER ranking, so a narrow
     filter can leave few survivors. 100 is Vectorize's hard maximum. */
  const ranked = await semanticSearch(env, query, { topK: 100 });
  if (!ranked.length) return { jobs: [], total: 0, limit, offset, mode: "semantic" };

  const rank = new Map(ranked.map((r, i) => [r.id, { i, score: r.score }]));
  const ids = ranked.map((r) => r.id);

  const where = ["j.active = 1", `j.id IN (${ids.map(() => "?").join(",")})`];
  const binds = [...ids];
  const bind = (v) => { binds.push(v); return "?"; };

  const country = (p.get("country") || "").trim();
  if (country) where.push(`j.country = ${bind(country)}`);
  const company = (p.get("company") || "").trim();
  if (company) where.push(`j.company = ${bind(company)}`);
  if (p.get("remote") === "1") where.push("j.remote = 1");
  if (p.get("thin") !== "1") where.push("j.thin = 0");

  const rows = await env.DB.prepare(
    `SELECT j.id, j.company, j.title, j.url, j.location, j.location_raw,
            j.country, j.remote, j.jd_chars, j.first_seen,
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
    jobs: all.slice(offset, offset + limit).map(({ _i, _score, ...j }) => ({ ...j, score: _score })),
    total: all.length,
    limit, offset, mode: "semantic",
  };
}

async function listJobs(db, url) {
  const p = url.searchParams;
  const where = ["j.active = 1"];
  const binds = [];
  const bind = (v) => {
    binds.push(v);
    return `?${binds.length}`;
  };

  /* FTS5 replaces `jd LIKE '%q%'`, which could not use an index and scanned
     every row's 6 kB blob. Joining against the external-content index turns it
     into an inverted-index lookup, and gives BM25 relevance ordering for free. */
  const limit = Math.min(parseInt(p.get("limit") || "50", 10) || 50, 200);
  const offset = Math.max(parseInt(p.get("offset") || "0", 10) || 0, 0);

  const q = (p.get("q") || "").trim();
  const match = q ? ftsQuery(q) : null;

  /* A search that reduces to nothing usable must return NOTHING, not the whole
     corpus. Falling through to an unfiltered query is the worst possible
     answer: "c++" briefly returned all 5,103 rows because its tokens were
     stripped to empty and the search was silently dropped. */
  if (match === "") return { jobs: [], total: 0, limit, offset };

  const from = match
    ? `jobs j JOIN jobs_fts f ON f.rowid = j.rowid AND jobs_fts MATCH ${bind(match)}`
    : `jobs j`;

  const country = (p.get("country") || "").trim();
  if (country) where.push(`j.country = ${bind(country)}`);

  const company = (p.get("company") || "").trim();
  if (company) where.push(`j.company = ${bind(company)}`);

  if (p.get("remote") === "1") where.push("j.remote = 1");
  // Thin JDs inflate every keyword score, so they are excluded by default.
  if (p.get("thin") !== "1") where.push("j.thin = 0");

  /* Collapse duplicate postings of the same role. `dedup_key` is now stored and
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
    SELECT j.id, j.company, j.title, j.url, j.location, j.location_raw,
           j.country, j.remote, j.jd_chars, j.first_seen,
           MAX(COALESCE(j.posted_at, j.first_seen)) AS posted_at,
           COUNT(*) AS listings
    FROM ${from}
    WHERE ${where.join(" AND ")}
    ${group}
    ${order}
    LIMIT ${limit} OFFSET ${offset}`;

  const countSql = `
    SELECT COUNT(*) AS n FROM (
      SELECT 1 FROM ${from} WHERE ${where.join(" AND ")} ${group}
    )`;

  try {
    const [rows, total] = await Promise.all([
      db.prepare(sql).bind(...binds).all(),
      db.prepare(countSql).bind(...binds).first(),
    ]);
    return { jobs: rows.results || [], total: total?.n ?? 0, limit, offset };
  } catch (err) {
    /* A malformed MATCH is user input, not a server fault — report it as an
       empty result rather than a 500. */
    if (match && /fts5|MATCH|syntax/i.test(String(err))) {
      return { jobs: [], total: 0, limit, offset };
    }
    throw err;
  }
}

/* Read the precomputed tables — two indexed scans over a few dozen rows instead
   of COUNT(DISTINCT ...) over the whole corpus on every page load. Written by
   refreshFacets() at the end of each sync. */
async function facets(db) {
  const [rows, meta] = await Promise.all([
    db.prepare(
      `SELECT kind, value, n FROM facet_counts ORDER BY n DESC`
    ).all(),
    db.prepare(
      `SELECT total, remote, synced_at FROM facet_meta WHERE id = 1`
    ).first(),
  ]);

  const all = rows.results || [];
  return {
    countries: all.filter((r) => r.kind === "country").map((r) => ({ country: r.value, n: r.n })),
    companies: all.filter((r) => r.kind === "company").map((r) => ({ company: r.value, n: r.n })),
    total: meta?.total ?? 0,
    remote: meta?.remote ?? 0,
    synced_at: meta?.synced_at ?? null,
  };
}

/* Recompute the facet tables. Runs once per sync — the aggregation the read
   path used to do on every request. Counts DISTINCT dedup_key so the numbers
   agree with what listJobs() actually returns; they drifted once before and the
   header disagreed with the list. */
export async function refreshFacets(db) {
  const BASE = `FROM jobs WHERE active = 1 AND thin = 0`;
  await db.batch([
    db.prepare(`DELETE FROM facet_counts`),
    db.prepare(
      `INSERT INTO facet_counts (kind, value, n)
       SELECT 'country', country, COUNT(DISTINCT dedup_key) ${BASE}
         AND country IS NOT NULL GROUP BY country`
    ),
    db.prepare(
      `INSERT INTO facet_counts (kind, value, n)
       SELECT 'company', company, COUNT(DISTINCT dedup_key) ${BASE}
       GROUP BY company`
    ),
    db.prepare(
      `INSERT OR REPLACE INTO facet_meta (id, total, remote, synced_at)
       SELECT 1,
              COUNT(DISTINCT dedup_key),
              COUNT(DISTINCT CASE WHEN remote = 1 THEN dedup_key END),
              MAX(last_seen)
       ${BASE}`
    ),
  ]);
}

/* ── scheduled sweep ──────────────────────────────────────────────────── */

/* `only` restricts the sweep to a subset of boards. The free plan allows 10 ms
   of CPU per invocation — cron included — and a full 19-board sweep is orders of
   magnitude over that, so production must sweep in slices. Passing nothing
   sweeps everything, which is only safe off-platform (see tools/seed.mjs). */
export async function sync(db, only = null) {
  const now = new Date().toISOString();
  const boards = only ? BOARDS.filter((b) => only.includes(b.token)) : BOARDS;
  const results = await Promise.all(boards.map(fetchBoard));

  const errors = results.filter((r) => r.error).map((r) => `${r.board.token}: ${r.error}`);
  const jobs = results.flatMap((r) => r.rows.map((row) => normalizeJob(row, r.board)));

  const seen = new Set();
  const statements = [];
  for (const j of jobs) {
    if (seen.has(j.id)) continue; // a role listed in several cities arrives twice
    seen.add(j.id);
    statements.push(
      db
        .prepare(
          /* dedup_key is stored, not derived per query. Must be written on both
             the insert and the update or a retitled posting keeps a stale key
             and silently stops collapsing with its twin. */
          `INSERT INTO jobs (id, source, company, title, url, location_raw, location,
                             country, remote, jd, jd_chars, thin, posted_at,
                             first_seen, last_seen, active, dedup_key)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?14,1,
                   ?3 || '|' || ?4 || '|' || COALESCE(?7, ''))
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title, url = excluded.url,
             location_raw = excluded.location_raw, location = excluded.location,
             country = excluded.country, remote = excluded.remote,
             jd = excluded.jd, jd_chars = excluded.jd_chars, thin = excluded.thin,
             posted_at = excluded.posted_at, last_seen = excluded.last_seen,
             active = 1, dedup_key = excluded.dedup_key`
        )
        .bind(
          j.id, j.source, j.company, j.title, j.url, j.location_raw, j.location,
          j.country, j.remote, j.jd, j.jd_chars, j.thin, j.posted_at, now
        )
    );
  }

  if (statements.length) await db.batch(statements);

  /* Anything not seen in this sweep of a board that DID respond is closed.
     Scoped per source so one failing board never mass-closes its own jobs. */
  const healthy = results.filter((r) => !r.error).map((r) => `${r.board.ats}:${r.board.token}`);
  const seenTotal = results.reduce((n, r) => n + (r.seen || 0), 0);
  let closed = 0;
  if (healthy.length) {
    const placeholders = healthy.map((_, i) => `?${i + 2}`).join(",");
    const res = await db
      .prepare(
        `UPDATE jobs SET active = 0
         WHERE active = 1 AND last_seen < ?1 AND source IN (${placeholders})`
      )
      .bind(now, ...healthy)
      .run();
    closed = res.meta?.changes ?? 0;
  }

  await db
    .prepare(
      `INSERT OR REPLACE INTO sync_log (ran_at, boards, fetched, upserted, closed, errors)
       VALUES (?1,?2,?3,?4,?5,?6)`
    )
    .bind(now, boards.length, jobs.length, statements.length, closed,
          errors.length ? errors.join(" | ") : null)
    .run();

  /* Facets are derived from jobs, so they must be rebuilt after every write —
     including the closures above, or closed roles keep inflating the counts. */
  await refreshFacets(db);

  /* `seen` vs `fetched` is the title filter's effect. Reported rather than
     hidden — a filter that quietly drops 80% of a corpus is indistinguishable
     from a broken fetcher unless you can see both numbers. */
  return { ran_at: now, boards: boards.length, seen: seenTotal, fetched: jobs.length,
           skipped_by_title: seenTotal - jobs.length,
           upserted: statements.length, closed, errors };
}

/* ── entry points ─────────────────────────────────────────────────────── */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    /* One canonical host. www is attached as a custom domain purely so it can be
       redirected here — serving both would be duplicate content, and it would
       also mean OAuth callbacks could arrive on a hostname the provider config
       does not list. 301 because this is permanent. */
    if (url.hostname.startsWith("www.")) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }

    /* ── auth: browser navigations, not fetches ─────────────────────────
       These redirect rather than return JSON, which is exactly why the CSP
       survives: the provider round trip is a top-level navigation and the
       token exchange happens here, server-side. */
    if (url.pathname.startsWith("/auth/")) {
      const [, , action, providerName] = url.pathname.split("/");

      if (action === "login" && PROVIDERS[providerName]) {
        const dest = await startLogin(env.DB, env, url, providerName);
        return dest
          ? redirect(dest)
          : redirect(`/signin.html?error=unconfigured&provider=${providerName}`);
      }

      if (action === "callback" && PROVIDERS[providerName]) {
        const result = await completeLogin(env.DB, env, url, providerName);
        if (result.error) {
          console.error("oauth callback", providerName, result.error);
          // Never surface the reason: it distinguishes CSRF from misconfiguration.
          return redirect("/signin.html?error=failed");
        }
        return redirect("/", result.cookie);
      }

      if (action === "logout") {
        return redirect("/", await logout(env.DB, request));
      }

      return redirect("/signin.html");
    }

    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    /* Read endpoints are GET-only. Anything else is a client bug or a probe. */
    const isRead = url.pathname === "/api/jobs" || url.pathname === "/api/facets";
    if (isRead && request.method !== "GET") {
      return json({ error: "method not allowed" }, 405);
    }

    /* Burst protection on every API path. These are read-only and D1-backed, so
       the exposure is quota exhaustion (5M row reads/day on free), not data
       loss — hence fail-open. The agent endpoint, when it lands, must pass
       failClosed: true because its exposure is real spend. */
    const rate = await checkRate(env.API_LIMITER, clientKey(request));
    if (!rate.ok) return tooManyRequests();

    try {
      if (url.pathname === "/api/jobs") {
        /* Semantic is opt-in per request. It costs a Workers AI call (10k
           Neurons/day), so it must never be the default for crawlers or the
           unfiltered browse view — which is also why it only runs when there
           is an actual query. Falls back to FTS on any failure rather than
           erroring: a degraded search beats no search. */
        const q = (url.searchParams.get("q") || "").trim();
        if (q && url.searchParams.get("mode") === "semantic" && env.AI && env.VECTORIZE) {
          try {
            return json(await listJobsSemantic(env, url, q), 200, READ_CACHE);
          } catch (err) {
            console.error("semantic search failed, falling back to fts", err);
          }
        }
        return json(await listJobs(env.DB, url), 200, READ_CACHE);
      }

      if (url.pathname === "/api/facets") {
        return json(await facets(env.DB), 200, READ_CACHE);
      }

      /* ── account ─────────────────────────────────────────────────────
         Never cached: a shared cache serving one visitor's identity to
         another is the classic way this goes wrong. json() defaults to
         no-store, which is why no cache argument is passed here. */
      if (url.pathname === "/api/me") {
        const user = await currentUser(env.DB, request);
        return json({ user: user ?? null, providers: Object.keys(PROVIDERS) });
      }

      if (url.pathname === "/api/saved") {
        const user = await currentUser(env.DB, request);
        if (!user) return json({ error: "sign in required" }, 401);

        if (request.method === "GET") {
          const rows = await env.DB.prepare(
            `SELECT j.id, j.company, j.title, j.url, j.location, j.country,
                    j.remote, j.posted_at, j.first_seen, s.saved_at
             FROM saved_jobs s JOIN jobs j ON j.id = s.job_id
             WHERE s.user_id = ?1 ORDER BY s.saved_at DESC LIMIT 200`
          ).bind(user.id).all();
          return json({ jobs: rows.results || [] });
        }

        if (request.method === "POST" || request.method === "DELETE") {
          if (!sameOrigin(request, url)) return json({ error: "bad origin" }, 403);
          const { job_id: jobId } = await request.json().catch(() => ({}));
          if (typeof jobId !== "string" || !jobId) return json({ error: "job_id required" }, 400);

          if (request.method === "DELETE") {
            await env.DB.prepare(`DELETE FROM saved_jobs WHERE user_id=?1 AND job_id=?2`)
              .bind(user.id, jobId).run();
            return json({ saved: false });
          }

          // Validate against the index rather than trusting the client's id.
          const exists = await env.DB.prepare(`SELECT 1 FROM jobs WHERE id = ?1`)
            .bind(jobId).first();
          if (!exists) return json({ error: "unknown job" }, 404);

          await env.DB.prepare(
            `INSERT OR IGNORE INTO saved_jobs (user_id, job_id, saved_at) VALUES (?1,?2,?3)`
          ).bind(user.id, jobId, new Date().toISOString()).run();
          return json({ saved: true });
        }

        return json({ error: "method not allowed" }, 405);
      }

      /* RAG matcher. Sign-in required — this is the answer to the
         unauthenticated-LLM-endpoint problem: an account gives a stable
         identity to meter against, where an IP rotates. It is also the first
         feature that makes an account worth creating. */
      if (url.pathname === "/api/match") {
        if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
        if (!sameOrigin(request, url)) return json({ error: "bad origin" }, 403);

        const user = await currentUser(env.DB, request);
        if (!user) return json({ error: "sign in required" }, 401);

        /* Fails CLOSED, unlike the read endpoints: a missing limiter must not
           mean unlimited inference. */
        const burst = await checkRate(env.API_LIMITER, `match:${user.id}`, { failClosed: true });
        if (!burst.ok) return json({ error: "too many requests — wait a minute" }, 429);

        if (!env.AI || !env.VECTORIZE) return json({ error: "matcher unavailable" }, 503);

        if (!(await checkBudget(env.DB))) {
          return json({
            error: "daily AI budget reached — the matcher resets at 00:00 UTC",
            budget: DAILY_NEURON_BUDGET,
          }, 429);
        }

        const body = await request.json().catch(() => ({}));
        const resume = typeof body?.resume === "string" ? body.resume : "";
        if (!resume.trim()) return json({ error: "resume text required" }, 400);

        const result = await matchResume(env, resume);
        if (result.error) return json(result, 400);
        // Charge only on success, so a failed run does not consume budget.
        await chargeBudget(env.DB);
        return json(result);
      }

      /* Model bench. Token-guarded, no session needed — it exists to compare
         latency and output quality across models on the real pipeline, which
         cannot be done honestly from the outside. Safe to delete. */
      if (url.pathname === "/api/bench") {
        if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
        const token = request.headers.get("x-sync-token") || "";
        if (!env.SYNC_TOKEN || !safeEqual(token, env.SYNC_TOKEN)) {
          return json({ error: "unauthorized" }, 401);
        }
        const model = url.searchParams.get("model");
        if (!model) return json({ error: "?model= required" }, 400);
        const body = await request.json().catch(() => ({}));
        const t0 = Date.now();
        const result = await matchResume({ ...env, GEN_MODEL: model }, body?.resume || "");
        return json({ ...result, ms: Date.now() - t0 });
      }

      if (url.pathname === "/api/account" && request.method === "DELETE") {
        if (!sameOrigin(request, url)) return json({ error: "bad origin" }, 403);
        const user = await currentUser(env.DB, request);
        if (!user) return json({ error: "sign in required" }, 401);
        await deleteAccount(env.DB, user.id);
        return withSecurity(
          new Response(JSON.stringify({ deleted: true }), {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8",
                       "set-cookie": await logout(env.DB, request) },
          })
        );
      }

      /* Manual sweep, for first population and debugging. Secret-guarded so it
         cannot be used to hammer the upstream boards on our behalf. POST-only:
         a GET would sit in browser history, proxy logs and Referer headers with
         the token in the query string. */
      if (url.pathname === "/api/sync") {
        if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
        const token = request.headers.get("x-sync-token") || "";
        if (!env.SYNC_TOKEN || !safeEqual(token, env.SYNC_TOKEN)) {
          return json({ error: "unauthorized" }, 401);
        }
        /* Slice required. A full sweep exceeds the 10 ms CPU limit and returns
           a bare 1102 with no explanation, so refuse it with one instead. */
        const only = (url.searchParams.get("boards") || "")
          .split(",").map((s) => s.trim()).filter(Boolean);
        if (!only.length) {
          return json({
            error: "specify ?boards=<token>[,<token>] — a full sweep exceeds the CPU limit",
            available: BOARDS.map((b) => b.token),
          }, 400);
        }
        return json(await sync(env.DB, only));
      }

      /* Embed a slice of the corpus into Vectorize. Same secret guard as sync,
         and sliced for the same reason: 50 subrequests per invocation on free,
         so this walks the table `limit` rows at a time rather than trying to do
         2,000+ in one go. Returns the next offset to continue from. */
      if (url.pathname === "/api/embed") {
        if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
        const token = request.headers.get("x-sync-token") || "";
        if (!env.SYNC_TOKEN || !safeEqual(token, env.SYNC_TOKEN)) {
          return json({ error: "unauthorized" }, 401);
        }
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 500);
        const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0);

        const rows = await env.DB.prepare(
          `SELECT id, title, company, location, jd FROM jobs
           WHERE active = 1 AND thin = 0
           ORDER BY id LIMIT ?1 OFFSET ?2`
        ).bind(limit, offset).all();

        const jobs = rows.results || [];
        const written = jobs.length ? await indexJobs(env, jobs) : 0;
        return json({
          model: EMBED_MODEL, dims: EMBED_DIMS, batch: BATCH,
          offset, written, next_offset: offset + jobs.length,
          done: jobs.length < limit,
        });
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      /* Never return err to the client — D1 messages can echo SQL and column
         names. Log it, return nothing useful. */
      console.error("api error", url.pathname, err);
      return json({ error: "internal error" }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    /* ONE board per run, rotating.
     *
     * Cron gets the same 10 ms CPU as an HTTP request on the free plan — which
     * is not obvious, and is why the original all-19-boards sweep failed with
     * 1102 every time while looking fine in local dev, where limits are not
     * enforced. One board fits; nineteen do not.
     *
     * Rotation is derived from the clock rather than stored state, so it stays
     * correct if a run is missed. At 4 runs/day the full set refreshes about
     * every 5 days. That is the honest cost of the free tier: Workers Paid
     * raises cron CPU to 30 s, at which point this reverts to a full sweep.
     */
    const slot = Math.floor(Date.now() / (6 * 3600 * 1000)) % BOARDS.length;
    const board = BOARDS[slot].token;
    ctx.waitUntil(
      Promise.all([sync(env.DB, [board]), purgeExpired(env.DB)])
        .catch((err) => console.error("scheduled sweep failed", board, err))
    );
  },
};
