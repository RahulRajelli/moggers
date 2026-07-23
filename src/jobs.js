/* Live roles, served from the Worker's D1 index (see worker/index.js).
 *
 * The API is optional by design: `vite dev` has no Worker behind it, so the
 * section removes itself rather than showing a broken shell. The ATS X-Ray must
 * never depend on the job index being up.
 */

import { isSignedIn, isSaved, toggleSaved, onAuthChange } from "./auth.js";

const $ = (id) => document.getElementById(id);
const PAGE = 24;

/* Resolved in initJobs(), not at module scope: touching `document` on import
   would make this module impossible to unit-test, and escapeHtml/safeUrl below
   are the security boundary for third-party ATS data — they need coverage. */
let el = null;

/* Job titles, companies and locations come from third-party ATS feeds and are
   interpolated into innerHTML, so this is the XSS boundary for data we do not
   control. `'` is escaped too: relying on every attribute in card() being
   double-quoted is a correctness argument that survives exactly until someone
   writes href='...'. Escape all five and the question never arises. */
export const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

let offset = 0;
let total = 0;
let seq = 0; // guards against a slow response overwriting a newer one

function relative(iso) {
  if (!iso) return "";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (Number.isNaN(days)) return "";
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function query() {
  const p = new URLSearchParams();
  if (el.q.value.trim()) p.set("q", el.q.value.trim());
  if (el.country.value) p.set("country", el.country.value);
  if (el.company.value) p.set("company", el.company.value);
  if (el.remote.checked) p.set("remote", "1");
  p.set("limit", String(PAGE));
  p.set("offset", String(offset));
  return p;
}

/* Escaping is not enough for an href: `javascript:alert(1)` contains no
   character escapeHtml touches, and the ATS feed controls this value. Validate
   the scheme instead, and drop the link entirely if it is anything but http(s).
   Relative URLs would also be wrong here — every posting is off-site. */
export function safeUrl(raw) {
  try {
    const u = new URL(String(raw));
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

function card(j) {
  const tags = [
    j.remote ? `<span class="jtag jtag--remote">REMOTE</span>` : "",
    j.location ? `<span class="jtag">${escapeHtml(j.location)}</span>` : "",
    relative(j.posted_at || j.first_seen)
      ? `<span class="jtag jtag--muted">${relative(j.posted_at || j.first_seen)}</span>`
      : "",
    /* Say so rather than silently swallowing the collapsed rows. */
    j.listings > 1 ? `<span class="jtag jtag--muted">${j.listings} postings</span>` : "",
  ].filter(Boolean).join("");

  const href = safeUrl(j.url);
  const inner = `
      <span class="job__co">${escapeHtml(j.company)}</span>
      <span class="job__title">${escapeHtml(j.title)}</span>
      <span class="job__tags">${tags}</span>`;

  /* The star sits OUTSIDE the anchor. Nesting a button inside a link is invalid
     HTML and makes the click target ambiguous for keyboard and screen readers. */
  const star = `<button type="button" class="job__star${isSaved(j.id) ? " is-on" : ""}"
      data-job="${escapeHtml(j.id)}"
      aria-pressed="${isSaved(j.id)}"
      title="${isSignedIn() ? "Save this role" : "Sign in to save roles"}">★</button>`;

  // A posting we cannot safely link to is still worth showing — just not as a link.
  const body = href
    ? `<a class="job__link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
    : `<div class="job__link job__link--dead">${inner}</div>`;

  return `<div class="job${href ? "" : " job--nolink"}">${body}${star}</div>`;
}

async function load({ append = false } = {}) {
  const mine = ++seq;
  if (!append) {
    offset = 0;
    el.list.innerHTML = `<p class="joblist__msg">Loading…</p>`;
  }

  let data;
  try {
    const res = await fetch(`/api/jobs?${query()}`);
    if (!res.ok) throw new Error(res.status);
    data = await res.json();
  } catch {
    if (mine === seq) el.section.remove();
    return;
  }
  if (mine !== seq) return;

  total = data.total;
  const html = (data.jobs || []).map(card).join("");

  if (append) el.list.insertAdjacentHTML("beforeend", html);
  else el.list.innerHTML = html || `<p class="joblist__msg">No roles match that. Try widening the filters.</p>`;

  offset += (data.jobs || []).length;
  el.more.hidden = offset >= total || !(data.jobs || []).length;
  el.stat.textContent = total ? `${total} open right now.` : "";
}

async function loadFacets() {
  const res = await fetch("/api/facets");
  if (!res.ok) throw new Error(res.status);
  const f = await res.json();

  const fill = (sel, rows, key) => {
    sel.insertAdjacentHTML(
      "beforeend",
      rows.map((r) => `<option value="${escapeHtml(r[key])}">${escapeHtml(r[key])} (${r.n})</option>`).join("")
    );
  };
  fill(el.country, f.countries, "country");
  fill(el.company, f.companies, "company");
  renderFreshness(f.synced_at);
}

/* If the cron dies quietly, closed roles keep rendering as live and the site
   becomes a liar without anything going red. The sweep runs 6-hourly, so past
   ~14h something is wrong and it must be visible to the visitor, not just in a
   dashboard nobody opens. */
const STALE_HOURS = 14;

function renderFreshness(syncedAt) {
  const box = $("jobsFresh");
  if (!box) return;
  if (!syncedAt) {
    box.textContent = "";
    return;
  }
  const hours = (Date.now() - new Date(syncedAt).getTime()) / 3600000;
  if (Number.isNaN(hours)) return;

  const label =
    hours < 1 ? "just now"
      : hours < 24 ? `${Math.round(hours)}h ago`
      : `${Math.round(hours / 24)}d ago`;

  box.textContent = hours > STALE_HOURS
    ? `⚠ last synced ${label} — listings may be out of date`
    : `synced ${label}`;
  box.classList.toggle("is-stale", hours > STALE_HOURS);
}

let debounce;
export async function initJobs() {
  el = {
    section: $("jobs"),
    stat: $("jobsStat"),
    q: $("jobQ"),
    country: $("jobCountry"),
    company: $("jobCompany"),
    remote: $("jobRemote"),
    list: $("jobList"),
    more: $("jobMore"),
  };
  if (!el.section) return;
  try {
    await loadFacets();
  } catch {
    el.section.remove(); // no index behind us — say nothing rather than half-work
    return;
  }

  el.q.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => load(), 250);
  });
  for (const c of [el.country, el.company, el.remote]) {
    c.addEventListener("change", () => load());
  }
  el.more.addEventListener("click", () => load({ append: true }));

  /* Delegated: cards are re-rendered on every filter change, so per-card
     listeners would leak and go stale. */
  el.list.addEventListener("click", async (e) => {
    const btn = e.target.closest(".job__star");
    if (!btn) return;
    e.preventDefault();

    if (!isSignedIn()) {
      location.href = "/signin.html";
      return;
    }

    const jobId = btn.dataset.job;
    btn.classList.toggle("is-on");                       // optimistic
    btn.setAttribute("aria-pressed", String(btn.classList.contains("is-on")));
    const result = await toggleSaved(jobId);
    btn.classList.toggle("is-on", result === true);      // reconcile
    btn.setAttribute("aria-pressed", String(result === true));
  });

  // Signing in mid-session should light up the stars without a reload.
  onAuthChange(() => load());

  await load();
}
