-- Daily Workers AI spend cap.
--
-- Free tier is 10,000 Neurons/day. Without a counter, one script could burn the
-- whole day's allowance in minutes and every later visitor gets a dead feature
-- with no explanation. Signing in already gates /api/match, but an account is
-- free to create, so identity alone is not a spend limit.
--
-- One row per UTC day. Old rows are harmless (a few bytes) and are a useful
-- record of demand, so nothing prunes them.

CREATE TABLE IF NOT EXISTS ai_budget (
  day    TEXT PRIMARY KEY,          -- YYYY-MM-DD, UTC
  spent  INTEGER NOT NULL DEFAULT 0 -- neurons, estimated per call
);
