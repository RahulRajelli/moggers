/* Interview prep for one role.
 *
 * Takes a job id, reads that posting's own JD out of D1, and asks a model what
 * it would actually be asked. The value is entirely in the grounding: generic
 * "tell me about yourself" lists are free everywhere and worth what they cost.
 * Questions drawn from THIS posting's requirements are not.
 *
 * BUDGET SHAPE, and why it differs from the matcher:
 *   - One call, one job, no retrieval. Cheaper than a match (no embedding, no
 *     Vectorize query) but the generation is longer, so it is charged at a
 *     similar rate rather than a token one.
 *   - BYOK FIRST is the default here, not the fallback. The matcher is the
 *     feature that makes an account worth having and gets the shared budget;
 *     this one is a nice-to-have, and a nice-to-have should not be what empties
 *     an 8,000-neuron day.
 */

import { generateWithGemini } from "./gemini.js";
import { DEFAULT_GEN_MODEL } from "./match.js";

export const NEURONS_PER_INTERVIEW = 110;

/* Long enough to characterise the role, short enough to leave room for the
   answer. The JD head carries the requirements; the tail is benefits and equal
   opportunity boilerplate, which produces questions about nothing. */
const JD_CHARS = 4500;

const SYSTEM =
  "You are an engineer who has sat on both sides of technical hiring. " +
  "Given a job description, write the questions this specific team would " +
  "actually ask. Ground every question in something the posting names — a " +
  "technology, a domain, a scale, a responsibility. Never write generic " +
  "questions that would suit any job. Reply with JSON only.";

const SHAPE =
  `{"technical":[{"q":"<question>","why":"<what they are testing, max 12 words>"}],` +
  `"experience":[{"q":"<question>","why":"<max 12 words>"}],` +
  `"ask_them":["<a question worth asking THEM, drawn from the posting>"]}`;

/** Pull the posting. Returns null if the id is unknown — never trust the client. */
export async function loadJob(db, jobId) {
  return db
    .prepare(
      `SELECT id, company, title, location, jd FROM jobs WHERE id = ?1 AND active = 1`
    )
    .bind(jobId)
    .first();
}

function buildMessages(job) {
  const jd = String(job.jd || "").slice(0, JD_CHARS);
  return [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content:
        `ROLE: ${job.title} at ${job.company}` +
        (job.location ? ` (${job.location})` : "") +
        `\n\nJOB DESCRIPTION:\n${jd}\n\n` +
        `Write 5 technical questions and 3 experience questions this team would ask, ` +
        `plus 2 questions worth asking them. Reply with exactly this JSON shape and ` +
        `nothing else:\n${SHAPE}`,
    },
  ];
}

/* Two cases, and the second is the one that is easy to miss.
 *
 * 1. A STRING with the JSON somewhere inside it. Models wrap JSON in prose or
 *    fences however firmly they are told not to, so take the outermost braces.
 * 2. AN OBJECT, already parsed. Workers AI parses valid JSON out of the
 *    response before handing it back, so a model that behaves perfectly
 *    returns a live object here — and `String(obj)` is "[object Object]",
 *    which has no braces and fails. The better the model behaves, the more
 *    surely the string-only version breaks. That cost a debugging round. */
function parseJson(raw) {
  if (raw && typeof raw === "object") return raw;

  const text = String(raw || "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const cleanList = (arr, max) =>
  (Array.isArray(arr) ? arr : [])
    .map((item) =>
      typeof item === "string"
        ? { q: item.slice(0, 300), why: "" }
        : { q: String(item?.q || "").slice(0, 300), why: String(item?.why || "").slice(0, 120) }
    )
    .filter((x) => x.q)
    .slice(0, max);

/**
 * Generate prep for one job. `geminiKey` runs on the user's own quota and
 * skips our budget entirely.
 */
export async function prepInterview(env, job, { geminiKey = null } = {}) {
  const messages = buildMessages(job);

  let raw;
  if (geminiKey) {
    raw = await generateWithGemini(geminiKey, messages, { maxTokens: 1100 });
  } else {
    const res = await env.AI.run(env.GEN_MODEL || DEFAULT_GEN_MODEL, {
      messages,
      max_tokens: 1100,
    });
    /* Three shapes, same reason as the matcher: llama returns `response`,
       gpt-oss and friends return an OpenAI chat completion. Pinning to one
       family is how this silently returns "" on a model swap. */
    raw =
      res?.response ??
      res?.result?.response ??
      res?.choices?.[0]?.message?.content ??
      "";
  }

  const parsed = parseJson(raw);
  if (!parsed) {
    /* A model that would not produce JSON is a failure worth reporting, not
       worth papering over with an empty list that looks like "no questions".
       Log a slice of what it DID say — without it this is unfalsifiable from
       the outside, which cost a debugging round the first time. */
    console.error(
      "interview: unparseable model output",
      typeof raw,
      JSON.stringify(raw).slice(0, 500)
    );
    return { error: "the model did not return usable questions — try again" };
  }

  const technical = cleanList(parsed.technical, 5);
  const experience = cleanList(parsed.experience, 3);
  const askThem = cleanList(parsed.ask_them, 2).map((x) => x.q);

  if (!technical.length && !experience.length) {
    return { error: "the model did not return usable questions — try again" };
  }

  return {
    job: { id: job.id, company: job.company, title: job.title },
    technical,
    experience,
    ask_them: askThem,
    byok: Boolean(geminiKey),
  };
}
