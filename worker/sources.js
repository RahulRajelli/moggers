/* Public ATS job-board feeds.
 *
 * These are the no-auth JSON endpoints each ATS publishes so its customers'
 * careers pages can render "View open positions" — the same URLs the company's
 * own site calls from the browser. No scraping, no login, no anti-bot evasion.
 *
 * Endpoints match jobtracker/fetch.py (greenhouse_board / lever_postings /
 * ashby_board), which is where they were proven.
 *
 * Deliberately NOT here: LinkedIn, Indeed, Naukri. Assisted browsing under your
 * own login for your own job hunt is one thing; republishing scraped listings on
 * a public site makes us the publisher. Don't add them.
 */

export const BOARDS = [
  // ── humanoid / physical AI ──
  { ats: "greenhouse", token: "figureai", company: "Figure" },
  { ats: "greenhouse", token: "agilityrobotics", company: "Agility Robotics" },
  { ats: "ashby", token: "physicalintelligence", company: "Physical Intelligence" },
  // ── defence / autonomy ──
  { ats: "greenhouse", token: "andurilindustries", company: "Anduril" },
  { ats: "greenhouse", token: "vannevarlabs", company: "Vannevar Labs" },
  { ats: "lever", token: "palantir", company: "Palantir" },
  // ── frontier labs ──
  { ats: "greenhouse", token: "anthropic", company: "Anthropic" },
  { ats: "ashby", token: "openai", company: "OpenAI" },
  { ats: "ashby", token: "cohere", company: "Cohere" },
  { ats: "lever", token: "mistral", company: "Mistral AI" },
  { ats: "ashby", token: "character", company: "Character.AI" },
  { ats: "ashby", token: "elevenlabs", company: "ElevenLabs" },
  // ── AI infra / data ──
  { ats: "greenhouse", token: "scaleai", company: "Scale AI" },
  { ats: "greenhouse", token: "databricks", company: "Databricks" },
  { ats: "greenhouse", token: "gleanwork", company: "Glean" },
  { ats: "ashby", token: "baseten", company: "Baseten" },
  { ats: "ashby", token: "modal", company: "Modal" },
  { ats: "ashby", token: "sierra", company: "Sierra" },
  { ats: "ashby", token: "mercor", company: "Mercor" },
];

const UA = "moggers.in job index (+https://moggers.in)";

/* ── relevance filter ──────────────────────────────────────────────────
 * Two jobs at once, and the second is why this is not optional.
 *
 * PRODUCT: this is a robotics / physical-AI board. Indexing all 2,155 Anduril
 * roles means recruiters, counsel and facilities managers drown the ~200 an
 * engineer actually wants.
 *
 * CPU: the free plan allows 10 ms of CPU per invocation — cron included, which
 * is not obvious and would have made the sweep fail silently forever. The
 * expensive step is toText() running six regex passes over each JD. Titles are
 * cheap to test, so filtering on title FIRST means the costly parse only runs
 * on survivors. Order matters: test title, then parse.
 *
 * Deliberately generous — a false positive costs a parse, a false negative
 * loses a real job. sync() reports `skipped` so the pattern can be tuned
 * against evidence rather than guesswork.
 */
const RELEVANT_TITLE = new RegExp(
  [
    "robot", "autonom", "self.?driving", "perception", "\\bslam\\b", "localizat",
    "motion planning", "manipulat", "grasp", "kinematic", "actuat", "servo",
    "control(s| system|ler)?\\b", "\\bgnc\\b", "guidance", "navigation",
    "simulat", "\\bsim\\b", "digital twin", "physics",
    "embedded", "firmware", "\\brtos\\b", "bare.?metal", "\\bfpga\\b", "\\bpcb\\b",
    "mechatronic", "mechanical", "electrical", "hardware", "\\bcad\\b",
    "machine learning", "deep learning", "reinforcement learning", "\\bml\\b",
    "\\bai\\b", "computer vision", "\\bcv\\b", "research (scientist|engineer)",
    "applied scientist", "foundation model", "\\bllm\\b",
    "sensor", "lidar", "radar", "\\bimu\\b", "calibrat",
    "aerospace", "avionics", "\\buav\\b", "drone", "flight", "propulsion",
    "software engineer", "systems engineer", "test engineer", "platform engineer",
    "infrastructure engineer", "forward deployed", "solutions? architect",
  ].join("|"),
  "i"
);

/* Titles that contain an include-word but are not the job. "Sales Engineer" and
 * "Technical Recruiter, Hardware" both match above; neither belongs here. */
/* Stems match as PREFIXES (`\w*`), not whole words. `\brecruit\b` looks right
   and silently fails on "Recruiter" — the trailing boundary cannot sit between
   two word characters. "Technical Recruiter, Hardware" then matched the include
   list on "hardware" and survived. Caught by tests/security.test.js; keep the
   `\w*` on every stem that takes a suffix. */
const IRRELEVANT_TITLE = new RegExp(
  "\\b(" + [
    "recruit\\w*", "sourcer", "talent", "counsel\\w*", "legal", "paralegal",
    "account(ant|ing)", "payroll", "sales", "market(ing|er)", "brand",
    "content", "communication\\w*", "people ops", "facilit(y|ies)",
    "executive assistant", "customer success", "support specialist",
    "program manager", "finance", "financial", "procurement",
  ].join("|") + ")\\b",
  "i"
);

export function isRelevantTitle(title = "") {
  const t = String(title);
  return RELEVANT_TITLE.test(t) && !IRRELEVANT_TITLE.test(t);
}

/* toText() cost scales with input length, so cap before parsing rather than
   after. 6 kB is comfortably past the requirements section of a normal posting;
   the full JD is not needed for keyword coverage. */
const MAX_RAW_JD = 6000;
const clipRaw = (s) => String(s ?? "").slice(0, MAX_RAW_JD);

async function getJson(url) {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": UA },
    cf: { cacheTtl: 300 },
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

/* ATS payloads carry JD bodies as HTML (sometimes entity-escaped twice). We keep
   plain text only: it is what the keyword tooling needs, and it removes any
   chance of storing markup that later gets rendered. */
const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'",
};
export function toText(html = "") {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&([a-z]+|#x?\d+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m)
    .replace(/[ \t ]+/g, " ")
    // Opening tags collapse to a space, so a block boundary leaves "One\n Two".
    // Strip padding around newlines before collapsing blank runs.
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function greenhouse({ token, company }) {
  const body = await getJson(
    `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`
  );
  const all = body.jobs || [];
  const kept = all.filter((j) => isRelevantTitle(j.title));
  return {
    seen: all.length,
    rows: kept.map((j) => ({
      external_id: String(j.id),
      company,
      title: j.title,
      url: j.absolute_url,
      location_raw: j.location?.name || "",
      remote_flag: null, // greenhouse encodes remote only in the location string
      jd: toText(clipRaw(j.content)),
      posted_at: j.updated_at || j.first_published || null,
    })),
  };
}

async function lever({ token, company }) {
  const body = await getJson(`https://api.lever.co/v0/postings/${token}?mode=json`);
  const all = body || [];
  const kept = all.filter((j) => isRelevantTitle(j.text));
  return {
    seen: all.length,
    rows: kept.map((j) => ({
      external_id: String(j.id),
      company,
      title: j.text,
      url: j.hostedUrl,
      location_raw: j.categories?.location || "",
      remote_flag:
        j.workplaceType === "remote" ? 1 : j.workplaceType === "onsite" ? 0 : null,
      jd: toText(clipRaw(j.descriptionPlain || j.description)),
      posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
    })),
  };
}

async function ashby({ token, company }) {
  const body = await getJson(
    `https://api.ashbyhq.com/posting-api/job-board/${token}?includeCompensation=true`
  );
  const all = body.jobs || [];
  const kept = all.filter((j) => isRelevantTitle(j.title));
  return {
    seen: all.length,
    rows: kept.map((j) => ({
      external_id: String(j.id),
      company,
      title: j.title,
      url: j.jobUrl || j.applyUrl,
      location_raw:
        [j.location, ...(j.secondaryLocations || []).map((l) => l?.location)]
          .filter(Boolean)
          .join(" · "),
      remote_flag: j.isRemote === true ? 1 : j.isRemote === false ? 0 : null,
      jd: toText(clipRaw(j.descriptionPlain || j.descriptionHtml)),
      posted_at: j.publishedAt || null,
    })),
  };
}

const FETCHERS = { greenhouse, lever, ashby };

/** Fetch one board. Never throws — a renamed token must not abort the sweep.
 *  `seen` is the pre-filter count, so sync() can report what the title filter
 *  discarded instead of silently shrinking the corpus. */
export async function fetchBoard(board) {
  try {
    const { seen, rows } = await FETCHERS[board.ats](board);
    return { board, rows, seen, error: null };
  } catch (err) {
    return { board, rows: [], seen: 0, error: String(err) };
  }
}
