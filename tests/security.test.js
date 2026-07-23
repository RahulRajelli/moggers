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
import { safeEqual, checkRate } from "../worker/security.js";
import { normalizeLocation } from "../worker/normalize.js";
import { toText, isRelevantTitle } from "../worker/sources.js";
import { ftsQuery } from "../worker/index.js";

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
