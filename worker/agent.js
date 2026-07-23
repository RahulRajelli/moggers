/* The saved-search watcher: one Durable Object per signed-in user.
 *
 * WHY THIS IS A DURABLE OBJECT AND NOT A CRON.
 *
 * A Durable Object gets 30 SECONDS of CPU per request; a free-plan Worker gets
 * 10 ms, cron included. That 10 ms ceiling is what broke the original all-boards
 * sweep — a bare `1102` in production, perfectly fine in local dev — and forced
 * board-slicing plus off-platform seeding. It does not apply in here. The
 * per-user alarm also means the work scales with users rather than with one
 * shared invocation that has to finish inside a single budget.
 *
 * WHAT IT DOES. The ingest already refreshes 19 boards every 6 hours and nobody
 * was watching that stream on anyone's behalf. This re-runs a user's saved
 * search on a schedule, diffs the result against the ids they have already been
 * shown, and keeps the difference. A job seeker does not want to come back and
 * search; they want to be told when the role appears.
 *
 * WHAT IT DELIBERATELY IS NOT:
 *
 *   - Not a tool-calling loop. Retrieval is already good; a loop would spend
 *     neurons re-deriving what one query returns.
 *   - Not an LLM call. The diff is Vectorize + D1 only. The free tier is 8,000
 *     neurons/day and a match costs ~95 of them, so a generative pass per user
 *     per day does not survive contact with a second user. Generation is
 *     reserved for when someone actually opens the result.
 *   - Not email. moggers.in MX points at GoDaddy with a `-all` SPF record, so
 *     sending from the domain means editing the record Rahul's working email
 *     depends on. The delta surfaces in the UI. Deferred on purpose.
 *
 * ADDRESSING IS NOT PUBLIC. There is no `routeAgentRequest` here, and that is a
 * security decision, not an omission: `/agents/mogger-agent/<name>` would let
 * anyone who can guess a user id talk to that user's agent. Instead the Worker
 * resolves the session cookie first and calls `getAgentByName(env.MoggerAgent,
 * user.id)` itself, so the instance name is never client-supplied and every
 * existing guard (session, Origin, rate limit) still sits in front.
 */
import { Agent } from "agents";
import { searchJobs, normalizeSearch, WATCH_LIMIT } from "./search.js";
import { checkBudget, chargeBudget, NEURONS_PER_WATCH } from "./match.js";
import {
  INTERVALS, normalizeInterval, isUsableWatch, describeWatch,
  mergeSeen, mergeFresh, newArrivals, watchEntry,
} from "./watch-core.js";

/* A watch nobody reads is a recurring alarm nobody asked for. After this long
   without the user opening the site, the schedule cancels itself and the watch
   goes dormant — recoverable in one click, but no longer burning D1 reads
   forever for someone who left. */
const DORMANT_AFTER_DAYS = 60;

/* `lastOpened` exists to drive the dormancy check above, so it does not need
   to be exact — and writing it on every page load would mean a Durable Object
   write per visit for no benefit. An hour of slack is plenty against a 60-day
   threshold. */
const OPENED_STAMP_INTERVAL_MS = 3600_000;

const nowIso = () => new Date().toISOString();
const daysSince = (iso) =>
  iso ? (Date.now() - new Date(iso).getTime()) / 86400000 : 0;

export class MoggerAgent extends Agent {
  initialState = {
    userId: null,
    search: null,        // null = no watch configured
    interval: "daily",
    seen: [],            // ids already shown — what makes "new since you looked" possible
    fresh: [],           // the pending delta, newest first
    createdAt: null,
    lastRun: null,
    lastOpened: null,
    lastError: null,
    runs: 0,
    dormant: false,
  };

  /* Everything the API returns. Built here rather than in the route so the
     shape cannot drift between the read endpoint and the write endpoints,
     which all return it too. `seen` is never included: it is bookkeeping, it
     is up to 600 ids, and the client has no use for it. */
  async #snapshot(extra = {}) {
    const s = this.state;
    /* How many alarms are actually armed. This is diagnostic and it earns its
       place: if scheduleEvery() ever fails or a cancel leaves a duplicate
       behind, every other field still reads "watching" and the feature simply
       never fires — or fires twice. Anything other than 1 while watching is a
       bug, and the UI says so rather than leaving it to a dashboard. */
    let armed = 0;
    let nextRun = null;
    try {
      const schedules = await this.listSchedules();
      armed = schedules.length;

      /* The REAL next-alarm time, read from the schedule rather than computed
         as lastRun + interval. Those two diverge the moment anyone presses
         "check now": a manual run updates lastRun but does not move the alarm,
         so the arithmetic version would promise a check that is not coming. */
      const soonest = schedules.map((s) => s.time).filter(Boolean).sort((a, b) => a - b)[0];
      if (soonest) {
        // Seconds since epoch, but tolerate milliseconds rather than render 1970.
        nextRun = new Date(soonest < 1e12 ? soonest * 1000 : soonest).toISOString();
      }
    } catch (err) {
      console.error("listSchedules failed", err);
    }

    return {
      armed,
      next_run: nextRun,
      watching: Boolean(s.search),
      search: s.search,
      summary: s.search ? describeWatch(s.search) : "",
      interval: s.interval,
      intervals: Object.keys(INTERVALS),
      fresh: s.fresh,
      count: s.fresh.length,
      created_at: s.createdAt,
      last_run: s.lastRun,
      last_error: s.lastError,
      runs: s.runs,
      dormant: s.dormant,
      ...extra,
    };
  }

  /** Read the watch. Stamps activity, which is what keeps it out of dormancy. */
  async snapshot(userId = null) {
    const s = this.state;
    const stale =
      !s.lastOpened || Date.now() - new Date(s.lastOpened).getTime() > OPENED_STAMP_INTERVAL_MS;
    if (s.search && stale) {
      this.setState({ ...s, lastOpened: nowIso(), userId: userId ?? s.userId });
    }
    return this.#snapshot();
  }

  /**
   * Create or replace the watch.
   *
   * THE BASELINE IS THE IMPORTANT PART. The first run seeds `seen` with
   * everything the search currently returns and reports nothing as new. The
   * user has just been looking at those results — that is where the button
   * they pressed lives — so announcing all fifty back to them as "new since
   * you looked" would be both false and the fastest way to teach them the
   * feature is noise.
   */
  async setWatch({ userId, search, interval } = {}) {
    const params = normalizeSearch(search || {});
    if (!isUsableWatch(params)) {
      return {
        error: "add a search term or a filter first — an unfiltered watch is the whole board",
      };
    }

    const saved = {
      q: params.q,
      country: params.country,
      company: params.company,
      remote: params.remote,
      mode: params.mode,
    };
    const chosen = normalizeInterval(interval);

    /* Cancel first. scheduleEvery() is idempotent per (callback, interval,
       payload), so a user switching daily -> weekly would otherwise be left
       with BOTH alarms running and get every result twice. */
    await this.#cancelAll();

    /* Changing only the frequency must not throw away the roles already found.
       Re-baselining an unchanged search would silently clear the delta the user
       came back to read — the one thing this feature exists to show them. */
    const unchanged =
      this.state.search &&
      Object.keys(saved).every((k) => this.state.search[k] === saved[k]);

    let seen = this.state.seen;
    let error = null;
    if (!unchanged) {
      seen = [];
      try {
        const { jobs } = await this.#runSearch(saved);
        seen = mergeSeen(jobs.map((j) => j.id));
      } catch (err) {
        /* A failed baseline is not a failed watch: seed empty and let the first
           scheduled run establish it. Reporting everything as new once is a far
           better failure than refusing to save the search at all. */
        console.error("watch baseline failed", err);
        error = "could not read the board just now — the first check will catch up";
      }
    }

    this.setState({
      ...this.state,
      userId: userId ?? this.state.userId ?? this.name,
      search: saved,
      interval: chosen,
      seen,
      fresh: unchanged ? this.state.fresh : [],
      createdAt: unchanged ? this.state.createdAt : nowIso(),
      lastRun: nowIso(),
      lastOpened: nowIso(),
      lastError: error,
      runs: unchanged ? this.state.runs : 0,
      dormant: false,
    });

    await this.scheduleEvery(INTERVALS[chosen], "runWatch");
    return this.#snapshot({ baseline: seen.length });
  }

  /** Stop watching and forget everything about the search. */
  async clearWatch() {
    await this.#cancelAll();
    this.setState({ ...this.initialState, userId: this.state.userId });
    return this.#snapshot();
  }

  /** Mark the delta as read. `seen` already contains these ids. */
  async ack() {
    this.setState({ ...this.state, fresh: [], lastOpened: nowIso() });
    return this.#snapshot();
  }

  /** Run the check now, on demand. Same path as the alarm. */
  async checkNow() {
    if (!this.state.search) return this.#snapshot({ error: "no watch configured" });

    /* Re-arm on demand. A manual check is what someone presses when the watch
       looks stuck, so it should fix the stuck case rather than only reporting
       it — whether the alarm went away because the watch went dormant or
       because a schedule was lost. scheduleEvery() is idempotent per
       (callback, interval, payload), so this cannot stack duplicates. */
    if (this.state.dormant || (await this.listSchedules()).length === 0) {
      await this.scheduleEvery(INTERVALS[normalizeInterval(this.state.interval)], "runWatch");
      this.setState({ ...this.state, dormant: false, lastOpened: nowIso() });
    }

    await this.#check();
    return this.#snapshot();
  }

  /* ── the scheduled callback ─────────────────────────────────────────── */

  /** Named in scheduleEvery(). Renaming this orphans every live schedule. */
  async runWatch() {
    /* Three ways a schedule outlives its reason to exist, all of which leave an
       alarm firing forever against a free-tier D1 quota. Check them before
       doing any work. */
    if (!this.state.search) return this.#cancelAll();

    if (daysSince(this.state.lastOpened) > DORMANT_AFTER_DAYS) {
      await this.#cancelAll();
      this.setState({ ...this.state, dormant: true });
      return;
    }

    /* Account deletion cascades in D1 (users -> sessions, saved_jobs) but a
       Durable Object is not in that graph and nothing else would ever stop it.
       This is the only thing that does. */
    if (!(await this.#userExists())) {
      await this.#cancelAll();
      this.setState({ ...this.initialState });
      return;
    }

    await this.#check();
  }

  /* ── internals ──────────────────────────────────────────────────────── */

  async #check() {
    const s = this.state;
    try {
      const { jobs, degraded } = await this.#runSearch(s.search);
      const arrivals = newArrivals(jobs, s.seen);
      const stamp = nowIso();

      this.setState({
        ...this.state,
        seen: mergeSeen(jobs.map((j) => j.id), s.seen),
        fresh: mergeFresh(arrivals.map((j) => watchEntry(j, stamp)), s.fresh),
        lastRun: stamp,
        lastError: degraded,
        runs: s.runs + 1,
      });
    } catch (err) {
      /* Never surface the raw error: D1 messages echo SQL and column names, and
         this string is rendered in the user's browser. Log the real one. */
      console.error("watch run failed", s.userId, err);
      this.setState({
        ...this.state,
        lastRun: nowIso(),
        lastError: "last check failed — it will try again on schedule",
        runs: s.runs + 1,
      });
    }
  }

  /* Semantic mode costs one embedding call. Metered against the same daily
     counter as the matcher, and DOWNGRADED rather than skipped when the budget
     is gone: a keyword check still finds most new arrivals, where refusing to
     run finds none. */
  async #runSearch(search) {
    let mode = search.mode;
    let spent = false;

    if (mode === "semantic" && !(await checkBudget(this.env.DB, NEURONS_PER_WATCH))) {
      mode = "keyword";
      spent = true;
    }

    const result = await searchJobs(this.env, { ...search, mode, limit: WATCH_LIMIT });

    /* Charge on the way OUT, and only if the embedding really ran. searchJobs
       falls back to FTS whenever Vectorize or Workers AI is unavailable and
       reports the mode it actually used — billing on the way in would have
       spent budget on calls that never happened. */
    if (result.mode === "semantic") await chargeBudget(this.env.DB, NEURONS_PER_WATCH);

    /* A watch saved "by meaning" that quietly ran as a keyword search finds
       different roles, and searchJobs falls back without raising anything. Say
       which of the two reasons it was: one resolves itself at midnight, the
       other is a backend that is down. Silence here would look like a watch
       that simply never matches anything. */
    const degraded =
      search.mode === "semantic" && result.mode !== "semantic"
        ? spent
          ? "checked by keyword — the daily AI budget is spent"
          : "checked by keyword — semantic search was unavailable"
        : null;

    return { jobs: result.jobs || [], degraded };
  }

  async #userExists() {
    const id = this.state.userId;
    if (!id) return true; // pre-userId state — do not delete a watch over bookkeeping
    try {
      const row = await this.env.DB.prepare(`SELECT 1 FROM users WHERE id = ?1`)
        .bind(id).first();
      return Boolean(row);
    } catch (err) {
      /* A D1 blip must not be read as "the account is gone". Fail towards
         keeping the watch; the next run will re-check. */
      console.error("watch user check failed", id, err);
      return true;
    }
  }

  async #cancelAll() {
    const schedules = await this.listSchedules();
    for (const s of schedules) await this.cancelSchedule(s.id);
  }
}
