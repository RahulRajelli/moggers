/* Location normalisation across six ATS vendors.
 *
 * Every vendor formats location differently and none of them agree on what
 * "remote" means. Greenhouse puts it in a freeform string ("Remote - US"),
 * Lever has a workplaceType enum, Ashby has an isRemote boolean plus a separate
 * location. So: trust an explicit vendor flag when there is one, fall back to
 * reading the string, and always keep the raw value so a bad guess is auditable.
 */

/* Order matters — longer, more specific keys are tested first so "New Delhi"
   is not matched by "Delhi" via a different country, and "Cambridge, MA" does
   not resolve to the UK. */
const CITY_COUNTRY = [
  // India
  [/\b(bengaluru|bangalore)\b/i, "India", "Bengaluru"],
  [/\b(gurugram|gurgaon)\b/i, "India", "Gurugram"],
  [/\b(noida|ghaziabad)\b/i, "India", "Noida"],
  [/\b(new delhi|delhi ncr|\bncr\b|delhi)\b/i, "India", "Delhi NCR"],
  [/\b(mumbai|bombay)\b/i, "India", "Mumbai"],
  [/\b(hyderabad)\b/i, "India", "Hyderabad"],
  [/\b(chennai|madras)\b/i, "India", "Chennai"],
  [/\b(pune)\b/i, "India", "Pune"],
  [/\b(kochi|cochin|trivandrum|thiruvananthapuram)\b/i, "India", "Kerala"],
  [/\b(ahmedabad|kolkata|jaipur|coimbatore|indore)\b/i, "India", null],
  [/\bindia\b/i, "India", null],
  // UK / Ireland
  [/\blondon\b/i, "United Kingdom", "London"],
  [/\b(cambridge, uk|oxford|manchester|edinburgh|bristol)\b/i, "United Kingdom", null],
  [/\b(united kingdom|england|scotland|wales|\buk\b)\b/i, "United Kingdom", null],
  [/\b(dublin|ireland)\b/i, "Ireland", "Dublin"],
  // Europe
  [/\b(berlin)\b/i, "Germany", "Berlin"],
  [/\b(munich|münchen|hamburg|frankfurt|stuttgart|cologne)\b/i, "Germany", null],
  [/\b(germany|deutschland)\b/i, "Germany", null],
  [/\b(amsterdam|netherlands|eindhoven|delft)\b/i, "Netherlands", "Amsterdam"],
  [/\b(zurich|zürich|switzerland|geneva|lausanne)\b/i, "Switzerland", null],
  [/\b(paris|france)\b/i, "France", "Paris"],
  [/\b(stockholm|sweden|copenhagen|denmark|oslo|norway|helsinki|finland)\b/i, "Nordics", null],
  [/\b(madrid|barcelona|spain|lisbon|portugal|milan|rome|italy|poland|warsaw)\b/i, "Europe", null],
  // APAC / MEA
  [/\bsingapore\b/i, "Singapore", "Singapore"],
  [/\b(tokyo|japan|osaka)\b/i, "Japan", null],
  [/\b(sydney|melbourne|australia)\b/i, "Australia", null],
  [/\b(dubai|abu dhabi|\buae\b|united arab emirates)\b/i, "UAE", null],
  [/\b(tel aviv|israel)\b/i, "Israel", null],
  [/\b(seoul|korea)\b/i, "South Korea", null],
  // Canada
  [/\b(toronto|vancouver|montreal|ottawa|waterloo|canada)\b/i, "Canada", null],
  // US — last, and broad
  [/\b(san francisco|\bsf\b|bay area|palo alto|mountain view|sunnyvale|menlo park|cupertino|santa clara|san jose)\b/i, "United States", "SF Bay Area"],
  [/\b(new york|nyc|brooklyn|manhattan)\b/i, "United States", "New York"],
  [/\b(seattle|redmond|bellevue)\b/i, "United States", "Seattle"],
  [/\b(austin|dallas|houston|texas)\b/i, "United States", "Texas"],
  [/\b(boston|cambridge, ma|somerville)\b/i, "United States", "Boston"],
  [/\b(los angeles|\bla\b|el segundo|pasadena|irvine|san diego)\b/i, "United States", "Southern California"],
  [/\b(denver|boulder|chicago|atlanta|pittsburgh|washington|arlington|d\.c\.|\bdc\b)\b/i, "United States", null],
  [/\b(united states|\busa\b|\bu\.s\.|remote - us|\bus\b)\b/i, "United States", null],
];

const REMOTE_RX = /\b(remote|work from home|wfh|distributed|anywhere)\b/i;
/* "Remote" next to these words is a qualifier, not a promise. */
const NOT_REALLY_REMOTE_RX = /\b(hybrid|on-?site|in-?office|in-?person)\b/i;

export function normalizeLocation(raw = "", vendorRemoteFlag = null) {
  const text = String(raw || "").trim();

  let remote;
  if (vendorRemoteFlag === 1 || vendorRemoteFlag === 0) {
    remote = vendorRemoteFlag; // an explicit vendor field always wins
  } else if (REMOTE_RX.test(text) && !NOT_REALLY_REMOTE_RX.test(text)) {
    remote = 1;
  } else {
    remote = 0;
  }

  let country = null;
  let city = null;
  for (const [rx, c, town] of CITY_COUNTRY) {
    if (rx.test(text)) {
      country = c;
      city = town;
      break;
    }
  }

  return {
    location_raw: text,
    location: city || (country ? country : text || (remote ? "Remote" : "")),
    country,
    remote,
  };
}

/* A JD under this is a fragment, not a posting — the same threshold the ATS
   X-Ray uses, and the reason keyword coverage on thin JDs reads too high. */
export const MIN_JD_CHARS = 1500;

export function normalizeJob(row, board) {
  const loc = normalizeLocation(row.location_raw, row.remote_flag);
  const jd = (row.jd || "").slice(0, 20000);
  const job = {
    id: `${board.ats}:${board.token}:${row.external_id}`,
    source: `${board.ats}:${board.token}`,
    company: row.company,
    title: (row.title || "").trim(),
    url: row.url,
    ...loc,
    jd,
    jd_chars: jd.length,
    thin: jd.length < MIN_JD_CHARS ? 1 : 0,
    posted_at: row.posted_at,
  };
  return { ...job, jd_hash: jobHash(job) };
}

/* ── the two windows that make change detection safe ──────────────────────
 *
 * Skipping the write for an unchanged posting is only half the saving: the
 * upsert still has to bump `last_seen`, because closure detection is "this
 * posting stopped appearing in its own board feed" and last_seen is how that
 * is measured. Bumping it every sweep means writing every row every sweep,
 * which is the cost we are trying to avoid.
 *
 * So the heartbeat gets its own, slower clock. A row is refreshed only once it
 * is REFRESH_AFTER_HOURS stale, and closed only once it is CLOSE_AFTER_HOURS
 * stale. At a 6-hourly sweep that means one write per row per day instead of
 * four, and the gap between the two numbers is pure safety margin.
 *
 * THE MARGIN IS THE WHOLE DESIGN. A row is refreshed at latest 20 + 6 = 26h
 * after its last bump, and not closed until 48h — 22 hours, or three and a
 * half missed sweeps, of slack. Narrowing that gap risks closing live roles,
 * which empties the site; widening it only delays a dead posting disappearing.
 * The two failure modes are not remotely symmetric, so err wide.
 *
 * The cost is that a role pulled from a board now vanishes here within about a
 * day rather than within six hours. For postings that live for weeks that is a
 * fair trade for 4x the write headroom.
 */
export const REFRESH_AFTER_HOURS = 20;
export const CLOSE_AFTER_HOURS = 48;

export const hoursAgo = (h, from = Date.now()) =>
  new Date(from - h * 3600_000).toISOString();

/* Change detection for the ingest sweep.
 *
 * THE FIELD LIST IS THE CONTRACT: it must cover every column the upsert's
 * DO UPDATE writes, or a change to a missing one is invisible and the stored
 * row silently keeps a stale value forever. `last_seen` and `active` are
 * deliberately absent — those change on every sweep by design and are handled
 * separately, which is the entire point of hashing the rest.
 *
 * FNV-1a, not SHA-256: this runs once per posting per sweep and Web Crypto's
 * digest is async, which would turn a tight synchronous loop over thousands of
 * rows into thousands of awaited promises. Collisions here cost a missed
 * update on one posting until its next real change, not corruption — a 32-bit
 * hash is the right size for that risk.
 */
/* ASCII unit separator (U+001F). Not a space: toText() strips control
   characters from every JD, so no field value can contain this one and bleed
   into its neighbour. Joined on a space, a title ending in one token and a URL
   beginning with another would hash identically to that token having moved
   across the boundary. */
const FIELD_SEP = String.fromCharCode(31);

export function jobHash(job) {
  const material = [
    job.company, job.title, job.url, job.location_raw, job.location,
    job.country, job.remote, job.jd_chars, job.thin, job.posted_at, job.jd,
  ].join(FIELD_SEP);

  let h = 0x811c9dc5;
  for (let i = 0; i < material.length; i++) {
    h ^= material.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
