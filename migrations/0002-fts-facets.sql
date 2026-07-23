-- FTS5 search + precomputed facets + a stored dedup key.
--
-- Purely additive: no existing column changes, so a rollback is just dropping
-- these objects. Verified FTS5 is available in D1 before writing this.
--
-- The three read-path scans this removes, in order of cost:
--   1. `jd LIKE '%q%'` — a leading wildcard cannot use an index, so every query
--      was a full scan doing string matching over ~6 kB blobs.
--   2. `GROUP BY company, title, location` on every request — aggregation that
--      only ever changes at write time.
--   3. `COUNT(DISTINCT ...)` over the whole table on every /api/facets call.
--
-- The binding constraint is not storage (5 GB ≈ 730k jobs) but the 5M row
-- reads/day quota. A full scan of 50k jobs would exhaust it in ~100 requests.
-- Indexed lookups touch tens of rows, which is what makes growth possible.

-- ── 1. stored dedup key ───────────────────────────────────────────────────
-- Same rule as before: company + title + location. Different CITIES stay
-- separate — one role open in four cities is four jobs, not one.
ALTER TABLE jobs ADD COLUMN dedup_key TEXT;

UPDATE jobs
   SET dedup_key = company || '|' || title || '|' || COALESCE(location, '');

CREATE INDEX IF NOT EXISTS idx_jobs_dedup ON jobs(dedup_key, active, thin);

-- Covering index for the default listing (no filters, newest first).
CREATE INDEX IF NOT EXISTS idx_jobs_listing
  ON jobs(active, thin, posted_at DESC);

-- ── 2. FTS5 ───────────────────────────────────────────────────────────────
-- `content=jobs` makes this an external-content index: the text is NOT stored
-- twice, only the inverted index is. Roughly a third the size of a standalone
-- FTS table and it cannot drift from the source rows.
--
-- unicode61 + remove_diacritics: "Zürich" matches "zurich". Tokenizing on
-- the default separators would split "ROS2" oddly, so keep digits attached.
CREATE VIRTUAL TABLE IF NOT EXISTS jobs_fts USING fts5(
  title,
  company,
  jd,
  content='jobs',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- External-content tables are not auto-populated; triggers keep them in sync.
-- 'delete' rows must carry the OLD values or the index corrupts silently.
CREATE TRIGGER IF NOT EXISTS jobs_fts_ins AFTER INSERT ON jobs BEGIN
  INSERT INTO jobs_fts(rowid, title, company, jd)
  VALUES (new.rowid, new.title, new.company, new.jd);
END;

CREATE TRIGGER IF NOT EXISTS jobs_fts_del AFTER DELETE ON jobs BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, company, jd)
  VALUES ('delete', old.rowid, old.title, old.company, old.jd);
END;

CREATE TRIGGER IF NOT EXISTS jobs_fts_upd AFTER UPDATE ON jobs BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, company, jd)
  VALUES ('delete', old.rowid, old.title, old.company, old.jd);
  INSERT INTO jobs_fts(rowid, title, company, jd)
  VALUES (new.rowid, new.title, new.company, new.jd);
END;

-- Build the index over rows that already exist.
INSERT INTO jobs_fts(jobs_fts) VALUES ('rebuild');

-- ── 3. precomputed facets ─────────────────────────────────────────────────
-- Written once per sync, read as a handful of rows instead of aggregating the
-- whole table on every page load.
CREATE TABLE IF NOT EXISTS facet_counts (
  kind   TEXT NOT NULL,          -- 'country' | 'company'
  value  TEXT NOT NULL,
  n      INTEGER NOT NULL,
  PRIMARY KEY (kind, value)
);

CREATE TABLE IF NOT EXISTS facet_meta (
  id         INTEGER PRIMARY KEY CHECK (id = 1),   -- single row
  total      INTEGER NOT NULL DEFAULT 0,
  remote     INTEGER NOT NULL DEFAULT 0,
  synced_at  TEXT
);

INSERT OR IGNORE INTO facet_meta (id, total, remote, synced_at) VALUES (1, 0, 0, NULL);
