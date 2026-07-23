/* THE BULLET ROAST.
 *
 * The X-Ray answers "can a parser read this". This answers "is what it reads
 * any good" — the other half of the same question, and the half every other
 * tool charges for.
 *
 * ENTIRELY CLIENT-SIDE, and that is the design, not a limitation:
 *   - No account, no upload, no AI call, no cost. It runs on the text pdf.js
 *     already extracted, in the same tab, and the "nothing leaves your device"
 *     promise stays literally true.
 *   - The daily neuron budget is 8,000. Spending inference on "this bullet has
 *     no numbers in it" would be spending it on something a regex knows.
 *
 * The checks are deliberately the ones with an OBJECTIVE answer. "Weak verb"
 * and "no metric" are decidable by looking; "is this impressive" is not, and a
 * tool that pretends otherwise is the scoring theatre this site exists to
 * argue against.
 */

/* Openers that describe a job description rather than what someone did. Ordered
   longest-first so "responsible for" is reported instead of the bare "for". */
const WEAK_OPENERS = [
  "was responsible for", "were responsible for", "responsible for",
  "duties included", "tasked with", "involved in", "participated in",
  "worked on", "worked with", "helped with", "helped to", "helped",
  "assisted with", "assisted in", "assisted", "contributed to",
  "part of a team", "supported the",
];

/* Phrases that survive on every resume precisely because they assert nothing.
   None of them can be false, which is what makes them worthless. */
const FILLER = [
  "team player", "hard working", "hard-working", "detail oriented",
  "detail-oriented", "go-getter", "self-starter", "results-driven",
  "results driven", "think outside the box", "synergy", "synergies",
  "wide range of", "various tasks", "passionate about", "dynamic professional",
  "proven track record", "excellent communication skills",
];

/* Regular participles are `\w+ed`; the irregulars are ENUMERATED rather than
   caught with `\w+en`, which would flag "was often" and "was seen to" as
   passive. A false positive here tells someone to rewrite a line that is
   already fine, which is worse than missing one. */
const PASSIVE = new RegExp(
  "\\b(was|were|been|being)\\s+(\\w+ed|" +
    ["written", "rewritten", "driven", "given", "taken", "chosen", "shown",
     "known", "broken", "spoken", "built", "rebuilt", "made", "held", "led",
     "sent", "kept", "brought", "taught", "found", "run", "done", "begun"].join("|") +
    ")\\b",
  "i"
);
const FIRST_PERSON = /\b(i|my|me)\b/i;
const HAS_NUMBER = /\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|dozen|hundred|thousand|million)\b/i;

const MAX_WORDS = 34;
const MIN_BULLET_CHARS = 40;
const MAX_BULLET_CHARS = 400;

/* Pull bullet-like lines out of the raw text layer.
 *
 * Uses the RAW text, not the flattened version the other checks use: flatten()
 * collapses newlines, and without line structure there are no bullets to
 * examine at all. */
export function extractBullets(rawText) {
  return String(rawText || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[•·▪‣◦*\-–—]\s*/, "").trim())
    .filter((l) => {
      if (l.length < MIN_BULLET_CHARS || l.length > MAX_BULLET_CHARS) return false;
      // Contact lines and URLs are not bullets.
      if (/@|https?:\/\/|linkedin\.com/i.test(l)) return false;
      // Section headers: short, and shouting.
      if (l === l.toUpperCase() && l.length < 60) return false;
      // Needs at least a few words to be a claim about anything.
      return l.split(/\s+/).length >= 6;
    })
    .slice(0, 40); // a resume with more than 40 bullets has a bigger problem
}

/** Judge one bullet. Returns { text, issues: [{ tag, note }] }. */
export function roastBullet(text) {
  const issues = [];
  const lower = text.toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);

  const weak = WEAK_OPENERS.find((w) => lower.startsWith(w));
  if (weak) {
    issues.push({
      tag: "WEAK OPENER",
      note: `Starts with "${weak}" — that describes the job, not what you did. Open with the verb: built, shipped, cut, led.`,
    });
  }

  if (!HAS_NUMBER.test(text)) {
    issues.push({
      tag: "NO NUMBER",
      note: "No quantity anywhere. How many, how much faster, how much cheaper? A number is the difference between a claim and evidence.",
    });
  }

  const filler = FILLER.find((f) => lower.includes(f));
  if (filler) {
    issues.push({
      tag: "FILLER",
      note: `"${filler}" cannot be false, so it says nothing. Cut it or replace it with the thing that proves it.`,
    });
  }

  if (PASSIVE.test(text)) {
    issues.push({
      tag: "PASSIVE",
      note: "Passive voice hides who did it. On a resume, that is you — say so.",
    });
  }

  if (FIRST_PERSON.test(text)) {
    issues.push({
      tag: "FIRST PERSON",
      note: "Drop I/my/me. Resume bullets are written in implied first person already.",
    });
  }

  if (words.length > MAX_WORDS) {
    issues.push({
      tag: "TOO LONG",
      note: `${words.length} words. Past about ${MAX_WORDS} nobody finishes the line — split it or cut it.`,
    });
  }

  return { text, issues };
}

/**
 * Roast a whole resume. Returns bullets worst-first, plus a summary, so the
 * worst offenders are the ones on screen without scrolling.
 */
export function roastResume(rawText) {
  const bullets = extractBullets(rawText).map(roastBullet);
  const flagged = bullets.filter((b) => b.issues.length);
  flagged.sort((a, b) => b.issues.length - a.issues.length);

  const counts = {};
  for (const b of flagged) {
    for (const i of b.issues) counts[i.tag] = (counts[i.tag] || 0) + 1;
  }

  return {
    total: bullets.length,
    clean: bullets.length - flagged.length,
    flagged,
    counts,
  };
}
