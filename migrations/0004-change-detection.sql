-- Change detection for the ingest sweep.
--
-- THE PROBLEM. D1 free allows 100,000 rows written/day. One full 19-board sweep
-- writes 20,052 (measured 2026-07-23) and runs 4x/day, plus the Worker cron's
-- own board — about 83% of quota. It works, and it leaves no room: adding a
-- single board to worker/sources.js pushes it over. Every "more roles" plan,
-- India included, is gated on this file.
--
-- WHERE THE WRITES ACTUALLY GO. Only ~13,500 of those 20,052 are jobs rows. The
-- rest are FTS5 index rows, written by the jobs_fts_upd trigger on EVERY upsert
-- — including the overwhelming majority where the posting has not changed at
-- all since the last sweep six hours ago. The sweep re-indexes the entire
-- corpus four times a day to record that almost nothing happened.
--
-- Purely additive: one nullable column and one trigger redefinition. Rolling
-- back means restoring the old trigger body from 0002; no data is transformed.

-- ── 1. the hash ───────────────────────────────────────────────────────────
-- FNV-1a over every field the upsert's DO UPDATE writes. Computed in JS by
-- jobHash() in worker/normalize.js, so the seeder and the Worker cannot drift.
--
-- DELIBERATELY NOT BACKFILLED. There is no md5/sha in D1's SQLite, and a
-- second hash scheme invented here purely to populate the column would be a
-- second thing to keep in sync forever. NULL simply means "unknown", which is
-- never equal to a computed hash, so the first sweep after this migration
-- treats every posting as changed and pays full price once. Every sweep after
-- it is cheap.
ALTER TABLE jobs ADD COLUMN jd_hash TEXT;

-- ── 2. only re-index when the indexed text changed ────────────────────────
-- jobs_fts indexes exactly three columns: title, company, jd. An update that
-- touches none of them — a last_seen bump, an active flag, a re-posted
-- posted_at — has no business rewriting the inverted index, and until now did
-- so on every single row of every single sweep.
--
-- `IS NOT`, not `<>`. `old.jd <> new.jd` evaluates to NULL when either side is
-- NULL, and a NULL WHEN is false, so a JD appearing on a posting that had none
-- would silently never be indexed. `IS NOT` is the null-safe comparison and is
-- the only correct choice here.
DROP TRIGGER IF EXISTS jobs_fts_upd;

CREATE TRIGGER jobs_fts_upd AFTER UPDATE ON jobs
WHEN old.title   IS NOT new.title
  OR old.company IS NOT new.company
  OR old.jd      IS NOT new.jd
BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, company, jd)
  VALUES ('delete', old.rowid, old.title, old.company, old.jd);
  INSERT INTO jobs_fts(rowid, title, company, jd)
  VALUES (new.rowid, new.title, new.company, new.jd);
END;

-- ── 3. find unchanged rows without scanning ───────────────────────────────
-- The upsert's DO UPDATE ... WHERE reads jd_hash and last_seen per row on
-- conflict. Those are single-row lookups by primary key, so this index is not
-- needed for them — it is here for the closure sweep, which now compares
-- last_seen against a cutoff across a whole source.
CREATE INDEX IF NOT EXISTS idx_jobs_lastseen ON jobs(source, last_seen);
