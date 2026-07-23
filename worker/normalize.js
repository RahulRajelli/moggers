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
  return {
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
}
