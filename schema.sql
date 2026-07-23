-- moggers.in job index (D1)
--
-- Only public ATS board feeds land here. No user data of any kind: no accounts,
-- no resumes, no contacts, no search history. If a column ever describes a
-- visitor rather than a job posting, something has gone wrong.

CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,     -- "<ats>:<token>:<external_id>"
  source       TEXT NOT NULL,        -- "greenhouse:anthropic"
  company      TEXT NOT NULL,
  title        TEXT NOT NULL,
  url          TEXT NOT NULL,
  location_raw TEXT,                 -- kept verbatim so a bad guess is auditable
  location     TEXT,                 -- normalised city or country
  country      TEXT,
  remote       INTEGER NOT NULL DEFAULT 0,
  jd           TEXT,
  jd_chars     INTEGER NOT NULL DEFAULT 0,
  thin         INTEGER NOT NULL DEFAULT 0,  -- jd_chars < 1500
  posted_at    TEXT,
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1
);

-- A posting is closed when it stops appearing in its own board feed. That is a
-- far better signal than re-requesting the URL: boards return HTTP 200 on an
-- expired posting and quietly redirect to a "create a job alert" page.
CREATE INDEX IF NOT EXISTS idx_jobs_active   ON jobs(active, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_country  ON jobs(country, active);
CREATE INDEX IF NOT EXISTS idx_jobs_remote   ON jobs(remote, active);
CREATE INDEX IF NOT EXISTS idx_jobs_company  ON jobs(company, active);

-- ── accounts ──────────────────────────────────────────────────────────────
-- OAuth only. No password column exists here and none should ever be added:
-- not storing credentials is the whole reason this is an OAuth-only design.

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,      -- our own uuid, never the provider's
  provider     TEXT NOT NULL,         -- 'github' | 'google'
  provider_id  TEXT NOT NULL,
  email        TEXT,
  name         TEXT,
  avatar_url   TEXT,
  created_at   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  UNIQUE (provider, provider_id)
);

-- `id` holds the SHA-256 of the session token, never the token itself. A dump
-- of this table is therefore not a set of usable sessions.
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);

-- Short-lived CSRF nonces for the OAuth round trip. Server-side so the callback
-- can prove it is answering a request we actually started.
CREATE TABLE IF NOT EXISTS oauth_state (
  state       TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

-- The first thing an account is actually for.
CREATE TABLE IF NOT EXISTS saved_jobs (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id    TEXT NOT NULL,
  saved_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, job_id)
);
CREATE INDEX IF NOT EXISTS idx_saved_user ON saved_jobs(user_id, saved_at DESC);

CREATE TABLE IF NOT EXISTS sync_log (
  ran_at    TEXT PRIMARY KEY,
  boards    INTEGER NOT NULL,
  fetched   INTEGER NOT NULL,
  upserted  INTEGER NOT NULL,
  closed    INTEGER NOT NULL,
  errors    TEXT
);
