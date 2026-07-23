/* Security-critical pure functions.
 *
 * These exist because the corresponding failures are all silent: a bad escape
 * renders, a javascript: href looks like a link, a fail-open limiter returns
 * 200. Nothing goes red on its own — only a test does.
 *
 * The rate limiter itself cannot be covered end-to-end here: Cloudflare's
 * [[ratelimits]] binding is a no-op in `wrangler dev --local` and only enforces
 * at the edge. So the decision logic is tested directly with a stub, and real
 * enforcement is a post-deploy check (see README).
 */
import { describe, it, expect } from "vitest";
import { escapeHtml, safeUrl } from "../src/jobs.js";
import { pathFor, PATHS } from "../src/paths.js";
import { roastBullet, roastResume, extractBullets } from "../src/roast.js";
import { safeEqual, checkRate } from "../worker/security.js";
import { normalizeLocation, jobHash, hoursAgo,
         REFRESH_AFTER_HOURS, CLOSE_AFTER_HOURS } from "../worker/normalize.js";
import { toText, isRelevantTitle } from "../worker/sources.js";
/* From search.js, not index.js: the Worker entry now exports the Agent class,
   which imports `cloudflare:workers` — a module vitest cannot resolve, so
   importing index.js here would take the whole suite down. */
import { ftsQuery, normalizeSearch } from "../worker/search.js";
import {
  mergeSeen, mergeFresh, newArrivals, isUsableWatch, normalizeInterval, MAX_SEEN,
} from "../worker/watch-core.js";

describe("escapeHtml", () => {
  it("neutralises tag injection", () => {
    expect(escapeHtml('<img src=x onerror="e()">')).toBe(
      "&lt;img src=x onerror=&quot;e()&quot;&gt;"
    );
  });

  it("escapes single quotes — the whole point of not relying on double-quoted attrs", () => {
    expect(escapeHtml("O'Hara")).toBe("O&#39;Hara");
  });

  it("escapes ampersands first so entities cannot be smuggled", () => {
    expect(escapeHtml("&lt;script&gt;")).toBe("&amp;lt;script&amp;gt;");
  });

  it("survives null/undefined without throwing", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

describe("safeUrl", () => {
  it("passes http and https", () => {
    expect(safeUrl("https://example.com/job")).toBe("https://example.com/job");
    expect(safeUrl("http://example.com/job")).toBe("http://example.com/job");
  });

  it("rejects javascript: — escaping alone would not catch this", () => {
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("JavaScript:alert(1)")).toBeNull();
  });

  it("rejects data:, ftp: and relative URLs", () => {
    expect(safeUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeUrl("ftp://example.com/x")).toBeNull();
    expect(safeUrl("/relative/path")).toBeNull();
  });

  it("rejects junk without throwing", () => {
    expect(safeUrl("")).toBeNull();
    expect(safeUrl(null)).toBeNull();
  });
});

describe("safeEqual", () => {
  it("matches identical strings and rejects everything else", () => {
    expect(safeEqual("token", "token")).toBe(true);
    expect(safeEqual("token", "tokes")).toBe(false);
    expect(safeEqual("token", "token ")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });

  it("rejects non-strings rather than coercing", () => {
    expect(safeEqual(undefined, undefined)).toBe(false);
    expect(safeEqual(null, "x")).toBe(false);
  });
});

describe("checkRate", () => {
  const allow = { limit: async () => ({ success: true }) };
  const deny = { limit: async () => ({ success: false }) };
  const broken = { limit: async () => { throw new Error("binding exploded"); } };

  it("passes through the binding verdict", async () => {
    expect((await checkRate(allow, "k")).ok).toBe(true);
    expect((await checkRate(deny, "k")).ok).toBe(false);
  });

  it("fails OPEN by default — read endpoints must not 429 because a binding is missing", async () => {
    expect((await checkRate(undefined, "k")).ok).toBe(true);
    expect((await checkRate(broken, "k")).ok).toBe(true);
  });

  it("fails CLOSED on request — the mode the paid agent endpoint must use", async () => {
    expect((await checkRate(undefined, "k", { failClosed: true })).ok).toBe(false);
    expect((await checkRate(broken, "k", { failClosed: true })).ok).toBe(false);
  });
});

describe("normalizeLocation", () => {
  it("unifies Bangalore and Bengaluru", () => {
    expect(normalizeLocation("Bangalore, India").location).toBe("Bengaluru");
    expect(normalizeLocation("Bengaluru, India").location).toBe("Bengaluru");
  });

  it("maps Indian cities to India", () => {
    for (const raw of ["Delhi, India", "Gurgaon", "Hyderabad, India", "Pune"]) {
      expect(normalizeLocation(raw).country).toBe("India");
    }
  });

  it("lets an explicit vendor flag beat the string", () => {
    expect(normalizeLocation("London, UK", 1).remote).toBe(1);
    expect(normalizeLocation("Remote - US", 0).remote).toBe(0);
  });

  it("does not treat hybrid or on-site as remote", () => {
    expect(normalizeLocation("Remote/Hybrid - London").remote).toBe(0);
    expect(normalizeLocation("Remote, on-site 3 days").remote).toBe(0);
  });

  it("does not resolve Cambridge, MA to the UK", () => {
    expect(normalizeLocation("Cambridge, MA").country).toBe("United States");
  });

  it("always keeps the raw value for auditing", () => {
    expect(normalizeLocation("Somewhere Odd").location_raw).toBe("Somewhere Odd");
  });
});

/* This filter is load-bearing twice over: it defines what the board IS, and it
   is what keeps the sweep inside the 10 ms CPU limit by ensuring the expensive
   JD parse only runs on survivors. A regression here silently changes both. */
describe("isRelevantTitle", () => {
  it("keeps core robotics and physical-AI roles", () => {
    for (const t of [
      "Robotics Software Engineer",
      "Perception Engineer, Autonomy",
      "Motion Planning Engineer",
      "Embedded Firmware Engineer",
      "Controls Engineer",
      "Simulation Infrastructure Engineer",
      "Research Scientist, Reinforcement Learning",
      "Computer Vision Engineer",
      "Mechanical Engineer, Actuators",
      "Forward Deployed Engineer",
    ]) expect(isRelevantTitle(t), t).toBe(true);
  });

  it("drops non-technical roles", () => {
    for (const t of [
      "Technical Recruiter",
      "Corporate Counsel",
      "Payroll Accountant",
      "Brand Marketing Manager",
      "Executive Assistant",
      "Customer Success Manager",
      "Facilities Coordinator",
    ]) expect(isRelevantTitle(t), t).toBe(false);
  });

  it("drops titles that contain an include-word but are not the job", () => {
    // "Sales Engineer" matches /engineer/; the exclude list is what catches it.
    expect(isRelevantTitle("Sales Engineer")).toBe(false);
    expect(isRelevantTitle("Technical Recruiter, Hardware")).toBe(false);
    expect(isRelevantTitle("Program Manager, Robotics")).toBe(false);
  });

  it("handles empty and junk input without throwing", () => {
    expect(isRelevantTitle("")).toBe(false);
    expect(isRelevantTitle(null)).toBe(false);
    expect(isRelevantTitle(undefined)).toBe(false);
  });
});

/* FTS5 query syntax is a real grammar — a stray quote or paren raises
   SQLITE_ERROR. Everything is quoted as a literal, which is also what makes
   "c++" and "ROS2" searchable instead of parse errors. */
describe("ftsQuery", () => {
  it("quotes tokens and prefixes the last one", () => {
    expect(ftsQuery("perception")).toBe('"perception"*');
    expect(ftsQuery("robot learning")).toBe('"robot" AND "learning"*');
  });

  it("does not prefix a short final token — 'ai'* would match half the index", () => {
    expect(ftsQuery("ai")).toBe('"ai"');
  });

  it("strips trailing punctuation the tokenizer discards, keeping the stem", () => {
    // "c++" indexes as "c"; searching the literal "c++" would match nothing.
    expect(ftsQuery("c++")).toBe('"c"');
  });

  it("returns EMPTY STRING for input with no usable tokens", () => {
    // Critical: listJobs treats "" as "return nothing". Returning null here
    // would fall through to an unfiltered query and show the ENTIRE corpus,
    // which is what "c++" briefly did.
    expect(ftsQuery("*")).toBe("");
    expect(ftsQuery("((()")).toBe("");
    expect(ftsQuery("+++")).toBe("");
  });

  it("neutralises FTS operators and quotes rather than erroring", () => {
    expect(ftsQuery('"unbalanced')).toBe('"unbalanced"*');
    expect(ftsQuery("NEAR(")).toBe('"near"*');
  });

  it("caps token count so a long paste cannot build a huge query", () => {
    const many = ftsQuery("a b c d e f g h i j k l m n o p");
    expect(many.split(" AND ")).toHaveLength(8);
  });
});

/* Change detection decides whether a row is written at all, so a hash that
   misses a field means the stored posting keeps a stale value indefinitely and
   nothing anywhere reports it. The field list IS the contract. */
describe("jobHash", () => {
  const base = {
    company: "Anduril", title: "Perception Engineer",
    url: "https://example.com/1", location_raw: "Seattle, WA",
    location: "Seattle", country: "United States", remote: 0,
    jd_chars: 1800, thin: 0, posted_at: "2026-07-01T00:00:00Z",
    jd: "Build the perception stack.",
  };

  it("is stable for identical input — otherwise every row rewrites every sweep", () => {
    expect(jobHash(base)).toBe(jobHash({ ...base }));
    expect(jobHash(base)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("changes when ANY written column changes", () => {
    /* Each of these is a column the upsert's DO UPDATE writes. Miss one and a
       real change to it is invisible to the WHERE clause forever. */
    for (const [k, v] of Object.entries({
      company: "Figure", title: "Controls Engineer", url: "https://example.com/2",
      location_raw: "Remote", location: "Remote", country: "India",
      remote: 1, jd_chars: 9, thin: 1, posted_at: "2026-07-02T00:00:00Z",
      jd: "Different body.",
    })) {
      expect(jobHash({ ...base, [k]: v }), k).not.toBe(jobHash(base));
    }
  });

  it("does not confuse a field boundary shift", () => {
    // Joined on a space these two would be the same string.
    expect(jobHash({ ...base, title: "Perception", url: "Engineer https://x" }))
      .not.toBe(jobHash({ ...base, title: "Perception Engineer", url: "https://x" }));
  });

  it("survives nulls without throwing", () => {
    expect(() => jobHash({ ...base, country: null, posted_at: null, jd: null })).not.toThrow();
  });
});

/* The refresh window and the close window are a matched pair. If they ever
   cross, the sweep closes live roles and the site empties — the one failure
   here that is worse than doing nothing at all. */
describe("sweep windows", () => {
  it("leaves margin for missed sweeps: a row is refreshed long before it can be closed", () => {
    const SWEEP_INTERVAL_HOURS = 6; // the cron in .github/workflows/sync-jobs.yml
    const worstCaseRefresh = REFRESH_AFTER_HOURS + SWEEP_INTERVAL_HOURS;
    expect(worstCaseRefresh).toBeLessThan(CLOSE_AFTER_HOURS);
    // and not by a hair — at least two whole sweeps of slack
    expect(CLOSE_AFTER_HOURS - worstCaseRefresh).toBeGreaterThanOrEqual(2 * SWEEP_INTERVAL_HOURS);
  });

  it("hoursAgo goes backwards, and is comparable as an ISO string", () => {
    const from = Date.parse("2026-07-23T12:00:00.000Z");
    expect(hoursAgo(20, from)).toBe("2026-07-22T16:00:00.000Z");
    // Lexicographic comparison is what the SQL `last_seen < ?` relies on.
    expect(hoursAgo(48, from) < hoursAgo(20, from)).toBe(true);
  });
});

/* The watcher's failure modes are all silent, which is why they are here rather
   than trusted to review: a bad eviction order re-announces roles the user
   already dismissed, a bad diff announces nothing and the feature just looks
   dead, and an unfiltered watch quietly reads the whole board every run. None
   of it throws. */
describe("mergeSeen", () => {
  it("keeps current results at the FRONT so they can never be evicted", () => {
    /* The bug this exists to stop: a long-lived posting ages out of a
       FIFO window while still matching the search, and the next run reports it
       as brand new. */
    const old = Array.from({ length: MAX_SEEN }, (_, i) => `old-${i}`);
    const merged = mergeSeen(["still-listed"], old);
    expect(merged[0]).toBe("still-listed");
    expect(merged).toHaveLength(MAX_SEEN);
    expect(merged).not.toContain(`old-${MAX_SEEN - 1}`); // the oldest went, not the live one
  });

  it("de-duplicates rather than growing on every run", () => {
    expect(mergeSeen(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("survives an empty run without discarding history", () => {
    expect(mergeSeen([], ["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("newArrivals", () => {
  it("returns only ids not already shown", () => {
    const jobs = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(newArrivals(jobs, ["b"]).map((j) => j.id)).toEqual(["a", "c"]);
  });

  it("returns nothing when everything is known — the quiet case must stay quiet", () => {
    expect(newArrivals([{ id: "a" }], ["a"])).toEqual([]);
  });

  it("ignores rows with no id rather than announcing undefined", () => {
    expect(newArrivals([{ id: null }, { id: "a" }], [])).toHaveLength(1);
  });
});

describe("mergeFresh", () => {
  it("puts new finds first and drops repeats of the same role", () => {
    const out = mergeFresh([{ id: "new" }, { id: "old" }], [{ id: "old" }]);
    expect(out.map((e) => e.id)).toEqual(["new", "old"]);
  });

  it("caps the backlog so an ignored watch cannot grow unbounded", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ id: `j${i}` }));
    expect(mergeFresh(many, [], 40)).toHaveLength(40);
  });
});

describe("isUsableWatch", () => {
  it("rejects a watch with no query and no filters — that is the whole board", () => {
    expect(isUsableWatch(normalizeSearch({}))).toBe(false);
    expect(isUsableWatch(normalizeSearch({ mode: "semantic" }))).toBe(false);
  });

  it("accepts any single narrowing term", () => {
    expect(isUsableWatch(normalizeSearch({ q: "perception" }))).toBe(true);
    expect(isUsableWatch(normalizeSearch({ country: "India" }))).toBe(true);
    expect(isUsableWatch(normalizeSearch({ remote: "1" }))).toBe(true);
  });
});

describe("normalizeInterval", () => {
  it("falls back to the default rather than accepting an arbitrary number", () => {
    // A client-supplied interval reaches scheduleEvery(); "60" would be a
    // per-minute alarm on a board that changes every 6 hours.
    expect(normalizeInterval("60")).toBe("daily");
    expect(normalizeInterval(undefined)).toBe("daily");
    expect(normalizeInterval("toString")).toBe("daily"); // not an inherited key
    expect(normalizeInterval("weekly")).toBe("weekly");
  });
});

describe("normalizeSearch", () => {
  it("reads '1' from a query string and true from JSON as the same thing", () => {
    expect(normalizeSearch({ remote: "1" }).remote).toBe(true);
    expect(normalizeSearch({ remote: true }).remote).toBe(true);
    expect(normalizeSearch({ remote: "0" }).remote).toBe(false);
  });

  it("excludes thin JDs unless explicitly asked for", () => {
    expect(normalizeSearch({}).includeThin).toBe(false);
    expect(normalizeSearch({ thin: "1" }).includeThin).toBe(true);
  });

  it("only honours the semantic opt-in, never guesses it", () => {
    expect(normalizeSearch({ mode: "semantic" }).mode).toBe("semantic");
    expect(normalizeSearch({ mode: "SEMANTIC" }).mode).toBe("keyword");
    expect(normalizeSearch({}).mode).toBe("keyword");
  });

  it("clamps limit so a saved search cannot ask for the corpus", () => {
    expect(normalizeSearch({ limit: "9999" }).limit).toBe(200);
    expect(normalizeSearch({ limit: "-5" }).limit).toBe(50);
  });
});

describe("toText", () => {
  it("strips tags and decodes entities", () => {
    expect(toText("<p>Hello &amp; welcome</p>")).toBe("Hello & welcome");
  });

  it("drops script and style bodies entirely", () => {
    expect(toText("<script>alert(1)</script>Real text")).not.toContain("alert");
    expect(toText("<style>.a{color:red}</style>Real text")).not.toContain("color");
  });

  it("turns block ends into newlines rather than gluing words", () => {
    expect(toText("<li>One</li><li>Two</li>")).toBe("One\nTwo");
  });

  it("handles empty input", () => {
    expect(toText("")).toBe("");
    expect(toText(undefined)).toBe("");
  });
});

/* The gap→path map is rendered straight into the match card, so a bad URL here
   is an XSS vector that escaping alone does not close (see safeUrl above), and
   a mis-ordered pattern silently sends people to the wrong material. */
describe("gap -> path map", () => {
  it("matches the specific pattern before the generic one", () => {
    // "motion planning" must not fall through to a broader planning/ML entry.
    expect(pathFor("Motion planning experience").label).toBe("Motion planning");
    expect(pathFor("Needs ROS2 experience").label).toBe("ROS 2");
    expect(pathFor("Humanoid robot experience").label).toBe("Legged robots");
    expect(pathFor("No C++ on the resume").label).toBe("C++");
  });

  it("returns null rather than guessing when nothing fits", () => {
    expect(pathFor("")).toBeNull();
    expect(pathFor(null)).toBeNull();
    expect(pathFor("a strong sense of ownership")).toBeNull();
  });

  it("every link is https and survives safeUrl", () => {
    for (const p of PATHS) {
      expect(p.links.length, p.label).toBeGreaterThan(0);
      expect(p.links.length, p.label).toBeLessThanOrEqual(3);
      for (const [title, url] of p.links) {
        expect(title, url).toBeTruthy();
        expect(url.startsWith("https://"), url).toBe(true);
        expect(safeUrl(url), url).toBe(url);
      }
    }
  });
});

/* The roast is the only feature that judges CONTENT, so a false positive is a
   user being told to fix something that is fine. Each check must fire only on
   the thing it names. */
describe("bullet roast", () => {
  const tags = (t) => roastBullet(t).issues.map((i) => i.tag);

  it("catches the weak opener and names it", () => {
    expect(tags("Responsible for maintaining 12 build servers across 3 regions"))
      .toContain("WEAK OPENER");
    expect(tags("Rebuilt the CI pipeline, cutting build time 40%"))
      .not.toContain("WEAK OPENER");
  });

  it("flags a bullet with no quantity anywhere", () => {
    expect(tags("Improved the deployment process for the platform team")).toContain("NO NUMBER");
    // Spelled-out numbers count — "three regions" is still a quantity.
    expect(tags("Led three engineers through a migration to ROS 2")).not.toContain("NO NUMBER");
  });

  it("does not call an active bullet passive", () => {
    expect(tags("The pipeline was rewritten by the team over 6 weeks")).toContain("PASSIVE");
    expect(tags("Rewrote the pipeline over 6 weeks")).not.toContain("PASSIVE");
  });

  it("catches first person but not words merely containing i", () => {
    expect(tags("I built 4 services handling 12k requests per second")).toContain("FIRST PERSON");
    expect(tags("Built 4 services handling 12k requests per second")).not.toContain("FIRST PERSON");
  });

  it("ignores contact lines, URLs and section headers when finding bullets", () => {
    const text = [
      "PROFESSIONAL EXPERIENCE",
      "someone@example.com · +91 90000 00000 · linkedin.com/in/someone",
      "https://github.com/someone/a-very-long-repository-name-here-indeed",
      "Shipped 3 perception features to 40 production robots over 18 months",
    ].join("\n");
    const bullets = extractBullets(text);
    expect(bullets).toHaveLength(1);
    expect(bullets[0]).toMatch(/^Shipped 3 perception/);
  });

  it("reports clean bullets as clean rather than saying nothing", () => {
    const r = roastResume("Shipped 3 perception features to 40 production robots over 18 months");
    expect(r.total).toBe(1);
    expect(r.flagged).toHaveLength(0);
    expect(r.clean).toBe(1);
  });

  it("sorts the worst offenders first", () => {
    const r = roastResume([
      "Rebuilt the planner and cut replan latency 30% across 200 robots",
      "I was responsible for various tasks and helped the team as a team player",
    ].join("\n"));
    expect(r.flagged[0].text).toMatch(/^I was responsible/);
    expect(r.flagged[0].issues.length).toBeGreaterThan(2);
  });
});
