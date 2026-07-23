/* Semantic layer: Workers AI embeddings + Vectorize.
 *
 * Model is @cf/baai/bge-small-en-v1.5 (384 dims), deliberately the same family
 * as the fastembed/BGE-small the local Job Tracker uses, so ranking here behaves
 * like `semantic_search` there.
 *
 * THE CONSTRAINT THAT SHAPES THIS FILE: the free plan allows 50 subrequests per
 * invocation. Embedding 2,138 jobs one call at a time is impossible in a Worker.
 * bge accepts an ARRAY of texts per call, so batching is what makes bulk
 * embedding feasible at all — 2,138 jobs at 100/batch is ~22 calls, inside the
 * limit. Never rewrite this to embed one row per call.
 */

export const EMBED_MODEL = "@cf/baai/bge-small-en-v1.5";
export const EMBED_DIMS = 384;

/* Conservative: bge has a 512-token context, so long inputs are truncated by
   the model anyway. Batch size trades subrequest count against payload size. */
export const BATCH = 50;
const MAX_CHARS = 1200;

/* What actually gets embedded. Title and company carry most of the signal for
   "what kind of job is this", and the JD head holds the requirements before the
   boilerplate about benefits and equal-opportunity statements. Embedding the
   full JD makes every posting at a company look alike. */
export function embedText(job) {
  return [job.title, job.company, job.location, (job.jd || "").slice(0, MAX_CHARS)]
    .filter(Boolean)
    .join(" — ")
    .slice(0, MAX_CHARS + 200);
}

/** Embed an array of strings in one Workers AI call. */
export async function embedBatch(ai, texts) {
  if (!texts.length) return [];
  const res = await ai.run(EMBED_MODEL, { text: texts });
  /* Shape has moved between model versions — accept both rather than break on
     an upgrade. */
  const vectors = res?.data ?? res?.result?.data ?? [];
  if (vectors.length !== texts.length) {
    throw new Error(`embed: asked for ${texts.length} vectors, got ${vectors.length}`);
  }
  return vectors;
}

/** Embed a single query string. */
export async function embedQuery(ai, text) {
  const [v] = await embedBatch(ai, [String(text).slice(0, MAX_CHARS)]);
  return v;
}

/**
 * Semantic search: embed the query, ask Vectorize for nearest neighbours,
 * hydrate the rows from D1.
 *
 * Vectorize stores only the job id; every displayable field comes from D1, so
 * there is one source of truth and no risk of the index serving a stale title.
 */
/* Vectorize caps topK at 100 — asking for more fails with 40011, it does not
   silently clamp. This is the real ceiling on how well semantic search composes
   with filters: ranking happens first, so a narrow filter (country=India) may
   leave only a handful of the 100 candidates. Keyword search has no such limit,
   which is one reason it stays the default. */
export const MAX_TOP_K = 100;

export async function semanticSearch(env, query, { topK = MAX_TOP_K } = {}) {
  topK = Math.min(topK, MAX_TOP_K);
  const vector = await embedQuery(env.AI, query);
  /* returnMetadata is a STRING enum ("none" | "indexed" | "all"), not a
     boolean — passing false fails the request body parse with a
     VECTOR_QUERY_ERROR 40026. returnValues really is a boolean. We need
     neither: only ids and scores, since D1 supplies every field. */
  const matches = await env.VECTORIZE.query(vector, {
    topK,
    returnMetadata: "none",
    returnValues: false,
  });
  return (matches?.matches || []).map((m) => ({ id: m.id, score: m.score }));
}

/** Upsert vectors for a batch of jobs. Returns how many were written. */
export async function indexJobs(env, jobs) {
  let written = 0;
  for (let i = 0; i < jobs.length; i += BATCH) {
    const slice = jobs.slice(i, i + BATCH);
    const vectors = await embedBatch(env.AI, slice.map(embedText));
    await env.VECTORIZE.upsert(
      slice.map((j, n) => ({ id: j.id, values: vectors[n] }))
    );
    written += slice.length;
  }
  return written;
}
