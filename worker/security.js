/* Security for Worker-generated responses.
 *
 * public/_headers covers static assets only — Cloudflare explicitly does not
 * apply it to responses produced by Worker code. Everything under /api/*
 * therefore gets its headers here. If you change one, change the other.
 */

/* An API response is JSON consumed by our own script. It should never be
   framed, sniffed, or treated as a document, so it gets its own tight policy
   rather than inheriting the page's. */
export const API_SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "strict-transport-security": "max-age=15552000; includeSubDomains",
};

/* Read endpoints are cacheable, but the earlier max-age=300 produced a visible
   bug: /api/facets served a stale total while /api/jobs served a fresh one, so
   the header count disagreed with the list. stale-while-revalidate keeps the
   speed without the disagreement window, and both endpoints must use the SAME
   value or the inconsistency returns. */
export const READ_CACHE = "public, max-age=60, stale-while-revalidate=600";

export function withSecurity(response, { cache } = {}) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(API_SECURITY_HEADERS)) headers.set(k, v);
  if (cache) headers.set("cache-control", cache);
  else headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

/* Client identity for rate limiting. CF-Connecting-IP is set by the edge and
   cannot be spoofed by the client; the header fallbacks are for local dev only,
   where there is no edge and no abuse risk. */
export function clientKey(request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "local"
  );
}

/* Burst protection via the native [[ratelimits]] binding.
 *
 * The binding only supports 10s or 60s windows, so this stops hammering — it is
 * NOT a daily budget. Anything with real per-call cost (the matching agent, once
 * it exists) additionally needs a persistent daily counter; a 60s limiter would
 * happily allow 1,440 expensive calls a day.
 *
 * Fails OPEN when the binding is absent so local dev and a mis-provisioned
 * account degrade to "unlimited" rather than "site down". That is the right
 * trade for read-only endpoints; the agent endpoint must fail CLOSED instead.
 */
export async function checkRate(limiter, key, { failClosed = false } = {}) {
  if (!limiter) return { ok: !failClosed, checked: false };
  try {
    const { success } = await limiter.limit({ key });
    return { ok: success, checked: true };
  } catch {
    return { ok: !failClosed, checked: false };
  }
}

/* Constant-time compare so a shared secret cannot be recovered a byte at a time
   from response timing. Length is compared first and leaks only the length. */
/* No default parameters. With `a = "", b = ""` an undefined secret compared
   against an absent header became "" === "" -> TRUE, i.e. an auth bypass for any
   caller that forgot to null-check the secret first. The typeof guard only
   works if undefined is allowed to stay undefined. */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function tooManyRequests() {
  return withSecurity(
    new Response(JSON.stringify({ error: "rate limited" }), {
      status: 429,
      headers: { "content-type": "application/json; charset=utf-8", "retry-after": "60" },
    })
  );
}
