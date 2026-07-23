/* OAuth sign-in (GitHub + Google) and session management.
 *
 * OAuth only, deliberately: there is no password column and none should be
 * added. Not storing credentials means never having to get hashing, reset
 * flows, or credential-stuffing defence right.
 *
 * This does NOT break the site's CSP. The provider round trip is a top-level
 * navigation, not a fetch, and the code-for-token exchange happens server-side
 * inside the Worker — so `connect-src 'self'` holds and the page still talks to
 * exactly one origin.
 *
 * These are confidential clients: the client secret lives in a Worker secret and
 * never reaches the browser, so `state` is the security-critical parameter (CSRF
 * on the callback). PKCE adds little for a confidential client and GitHub's
 * support for it is inconsistent, so it is intentionally omitted.
 */

const SESSION_COOKIE = "mog_session";
const SESSION_DAYS = 30;
const STATE_TTL_MINUTES = 10;

export const PROVIDERS = {
  github: {
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    scope: "read:user user:email",
    idKey: "GITHUB_CLIENT_ID",
    secretKey: "GITHUB_CLIENT_SECRET",
  },
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
    idKey: "GOOGLE_CLIENT_ID",
    secretKey: "GOOGLE_CLIENT_SECRET",
  },
};

const nowIso = () => new Date().toISOString();
const plusMs = (ms) => new Date(Date.now() + ms).toISOString();

function randomToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* Sessions are stored hashed. The cookie carries the secret; the database keeps
   only its digest, so leaking the table does not hand over live sessions. */
async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cookie(value, maxAgeSeconds) {
  // Lax (not Strict) so returning from the provider redirect carries the cookie.
  return [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

function readCookie(request) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return v.join("=");
  }
  return null;
}

/* ── flow ─────────────────────────────────────────────────────────────── */

/* Secrets set by piping (`echo x | wrangler secret put`) keep the trailing
   newline, and `gh secret set` from a file does the same. A stray \n in a
   client_id is invisible everywhere except the wire, where it arrives as %0A
   and the provider rejects it — GitHub sign-in failed exactly this way. Trim
   every credential at the point of use so it cannot recur. */
const clean = (v) => (typeof v === "string" ? v.trim() : v);

export async function startLogin(db, env, url, providerName) {
  const provider = PROVIDERS[providerName];
  if (!provider) return null;

  const clientId = clean(env[provider.idKey]);
  if (!clientId) return null; // provider not configured — caller renders an error

  const state = randomToken(16);
  await db
    .prepare(
      `INSERT INTO oauth_state (state, provider, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4)`
    )
    .bind(state, providerName, nowIso(), plusMs(STATE_TTL_MINUTES * 60_000))
    .run();

  const auth = new URL(provider.authorize);
  auth.searchParams.set("client_id", clientId);
  auth.searchParams.set("redirect_uri", `${url.origin}/auth/callback/${providerName}`);
  auth.searchParams.set("scope", provider.scope);
  auth.searchParams.set("state", state);
  auth.searchParams.set("response_type", "code");
  return auth.toString();
}

async function consumeState(db, state, providerName) {
  if (!state) return false;
  const row = await db
    .prepare(`SELECT provider, expires_at FROM oauth_state WHERE state = ?1`)
    .bind(state)
    .first();
  // Single use, always: delete whether or not it validated.
  await db.prepare(`DELETE FROM oauth_state WHERE state = ?1`).bind(state).run();
  if (!row || row.provider !== providerName) return false;
  return row.expires_at > nowIso();
}

async function fetchProfile(providerName, accessToken) {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    accept: "application/json",
    "user-agent": "moggers.in",
  };

  if (providerName === "github") {
    const me = await (await fetch("https://api.github.com/user", { headers })).json();
    let email = me.email;
    if (!email) {
      // GitHub hides the address unless it is public; ask the emails endpoint.
      const emails = await (
        await fetch("https://api.github.com/user/emails", { headers })
      ).json();
      email = Array.isArray(emails)
        ? emails.find((e) => e.primary && e.verified)?.email ?? null
        : null;
    }
    return { id: String(me.id), email, name: me.name || me.login, avatar: me.avatar_url };
  }

  const me = await (
    await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers })
  ).json();
  return { id: String(me.sub), email: me.email, name: me.name, avatar: me.picture };
}

export async function completeLogin(db, env, url, providerName) {
  const provider = PROVIDERS[providerName];
  if (!provider) return { error: "unknown provider" };

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) return { error: "missing code" };
  if (!(await consumeState(db, state, providerName))) return { error: "bad state" };

  const body = new URLSearchParams({
    client_id: clean(env[provider.idKey]),
    client_secret: clean(env[provider.secretKey]),
    code,
    redirect_uri: `${url.origin}/auth/callback/${providerName}`,
    grant_type: "authorization_code",
  });

  const tokenRes = await fetch(provider.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const tokenJson = await tokenRes.json();
  const accessToken = tokenJson.access_token;
  if (!accessToken) return { error: "token exchange failed" };

  const profile = await fetchProfile(providerName, accessToken);
  if (!profile?.id) return { error: "profile fetch failed" };

  const existing = await db
    .prepare(`SELECT id FROM users WHERE provider = ?1 AND provider_id = ?2`)
    .bind(providerName, profile.id)
    .first();

  const userId = existing?.id ?? crypto.randomUUID();
  if (existing) {
    await db
      .prepare(
        `UPDATE users SET email=?2, name=?3, avatar_url=?4, last_seen=?5 WHERE id=?1`
      )
      .bind(userId, profile.email, profile.name, profile.avatar, nowIso())
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO users (id, provider, provider_id, email, name, avatar_url, created_at, last_seen)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?7)`
      )
      .bind(userId, providerName, profile.id, profile.email, profile.name, profile.avatar, nowIso())
      .run();
  }

  const token = randomToken(32);
  const maxAge = SESSION_DAYS * 86400;
  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?1,?2,?3,?4)`
    )
    .bind(await sha256(token), userId, nowIso(), plusMs(maxAge * 1000))
    .run();

  return { cookie: cookie(token, maxAge) };
}

/** Resolve the signed-in user, or null. Cheap enough to call per request. */
export async function currentUser(db, request) {
  const token = readCookie(request);
  if (!token) return null;
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.name, u.avatar_url, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ?1`
    )
    .bind(await sha256(token))
    .first();
  if (!row || row.expires_at <= nowIso()) return null;
  return { id: row.id, email: row.email, name: row.name, avatar: row.avatar_url };
}

export async function logout(db, request) {
  const token = readCookie(request);
  if (token) {
    await db.prepare(`DELETE FROM sessions WHERE id = ?1`).bind(await sha256(token)).run();
  }
  return cookie("", 0);
}

/* Full erasure, not a soft delete. saved_jobs and sessions cascade off users, so
   deleting the row leaves nothing behind — which is what the privacy page
   promises and what the DPDP Act expects. */
export async function deleteAccount(db, userId) {
  await db.prepare(`DELETE FROM users WHERE id = ?1`).bind(userId).run();
}

/* Housekeeping for the cron: expired sessions and abandoned state nonces are
   pure garbage and both tables are unbounded without this. */
export async function purgeExpired(db) {
  const t = nowIso();
  await db.batch([
    db.prepare(`DELETE FROM sessions WHERE expires_at <= ?1`).bind(t),
    db.prepare(`DELETE FROM oauth_state WHERE expires_at <= ?1`).bind(t),
  ]);
}
