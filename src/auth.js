/* Sign-in state and saved roles.
 *
 * The account is deliberately narrow: ATS X-Ray never asks who you are, and
 * nothing here is required to use it. Signing in buys exactly one thing today —
 * saved roles — and later the matching agent. If a feature does not need
 * identity, it must not sit behind this.
 */

const $ = (id) => document.getElementById(id);

let user = null;
const saved = new Set();

export const isSignedIn = () => user !== null;
export const isSaved = (jobId) => saved.has(jobId);

const listeners = new Set();
export const onAuthChange = (fn) => listeners.add(fn);
const emit = () => listeners.forEach((fn) => fn(user));

async function loadSaved() {
  saved.clear();
  if (!user) return;
  try {
    const res = await fetch("/api/saved");
    if (!res.ok) return;
    const { jobs } = await res.json();
    for (const j of jobs || []) saved.add(j.id);
  } catch {
    /* saved roles are additive — failing to load them must not break the page */
  }
}

/** Toggle a save. Returns the new state, or null if the user must sign in. */
export async function toggleSaved(jobId) {
  if (!user) return null;
  const currently = saved.has(jobId);
  // Optimistic: the star should respond instantly, then reconcile.
  currently ? saved.delete(jobId) : saved.add(jobId);
  try {
    const res = await fetch("/api/saved", {
      method: currently ? "DELETE" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ job_id: jobId }),
    });
    if (!res.ok) throw new Error(res.status);
    return !currently;
  } catch {
    currently ? saved.add(jobId) : saved.delete(jobId); // roll back
    return currently;
  }
}

function render() {
  const box = $("authBox");
  if (!box) return;

  if (!user) {
    box.innerHTML = `<a class="bar__signin" href="/signin.html">SIGN IN</a>`;
    return;
  }

  const label = user.name || user.email || "account";
  box.innerHTML = `
    <span class="bar__who" title="${escapeAttr(user.email || "")}">${escapeText(label)}</span>
    <a class="bar__signin" href="/auth/logout">SIGN OUT</a>`;
}

const escapeText = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
const escapeAttr = escapeText;

export async function initAuth() {
  try {
    const res = await fetch("/api/me");
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    user = data.user;
  } catch {
    user = null; // no auth backend (vite dev) — the site simply stays signed out
  }
  await loadSaved();
  render();
  emit();
  return user;
}
