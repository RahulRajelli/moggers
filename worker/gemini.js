/* Bring-your-own-key fallback: Google Gemini.
 *
 * WHY THIS EXISTS: the Workers AI budget is ~90 matches/day. Rather than "come
 * back tomorrow", a user can supply their own free Gemini key (250 req/day from
 * aistudio.google.com) and keep going on their own quota.
 *
 * WHAT THIS DELIBERATELY IS NOT: there is a way to get 1,000 req/day by driving
 * `cloudcode-pa.googleapis.com/v1internal:generateContent` with a user's Google
 * OAuth token. That is the Gemini Code Assist quota reached through an internal
 * endpoint intended for Google's own CLI and IDE plugins. It is undocumented,
 * can break without notice, and routes a USER'S account through an access path
 * Google did not open to third parties — they carry the risk, not us. Use the
 * public documented API with a key the user chose to create. Do not "improve"
 * this by switching endpoints.
 *
 * KEY HANDLING: the key arrives per request, is used once, and is never written
 * to D1, never logged, and never returned in a response. There is no key table
 * to breach because there is no key table.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/* Flash: fast, cheap on the user's quota, and strong enough for ranking plus
   two short strings. Their key, their allowance — but a needlessly expensive
   default would still be rude. */
export const GEMINI_MODEL = "gemini-2.0-flash";

/* A Google API key is `AIza` + 35 chars. Checking the shape before spending a
   round trip gives a clearer error than Google's 400, and stops obvious
   copy-paste mistakes (whole URLs, OAuth tokens) reaching an external service. */
export function looksLikeGeminiKey(key) {
  return typeof key === "string" && /^AIza[\w-]{30,}$/.test(key.trim());
}

/**
 * Run the same prompt through Gemini. Returns the raw text; the caller parses
 * and validates exactly as it does for Workers AI, so a hallucinated job id is
 * dropped on the same code path.
 */
export async function generateWithGemini(apiKey, messages, { maxTokens = 700 } = {}) {
  const key = String(apiKey || "").trim();
  if (!looksLikeGeminiKey(key)) {
    throw new Error("that does not look like a Gemini API key (expected AIza…)");
  }

  /* Gemini takes the system prompt separately and uses `parts`, not `content`. */
  const system = messages.find((m) => m.role === "system")?.content || "";
  const user = messages.filter((m) => m.role !== "system").map((m) => m.content).join("\n\n");

  const res = await fetch(`${ENDPOINT}/${GEMINI_MODEL}:generateContent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Header, not a query param: a key in a URL lands in logs and Referer.
      "x-goog-api-key": key,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: maxTokens,
        responseMimeType: "application/json", // native JSON mode — no fences to strip
      },
    }),
  });

  if (!res.ok) {
    /* Surface Google's reason (bad key, quota exhausted, region blocked) but
       never echo the key itself. */
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.error?.message || "";
    } catch { /* non-JSON error body */ }
    const safe = detail.replace(/AIza[\w-]+/g, "[key]").slice(0, 160);
    throw new Error(`Gemini rejected the request (${res.status})${safe ? `: ${safe}` : ""}`);
  }

  const body = await res.json();
  return body?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}
