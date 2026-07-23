/* The watcher's UI.
 *
 * One saved search per account. The button saves whatever the filters above it
 * currently say, the strip below shows what has appeared since — and that is
 * the whole feature. It is the only thing on this site that gives anyone a
 * reason to come back rather than search again.
 *
 * NO EMAIL, and not as an oversight: moggers.in's MX points at GoDaddy with a
 * `-all` SPF record, so sending from the domain means editing the record a real
 * working mailbox depends on. The delta lives here instead.
 */
import { escapeHtml, safeUrl, currentFilters } from "./jobs.js";
import { isSignedIn, onAuthChange } from "./auth.js";

const $ = (id) => document.getElementById(id);

const LABELS = { "6h": "every 6 hours", daily: "daily", weekly: "weekly" };

let el = null;
let state = null;   // last snapshot from /api/watch
let busy = false;

/* Same shape the job list uses, minus the save star — a role in this strip is
   here because it is new, and starring it belongs to the list below. */
function card(j) {
  const href = safeUrl(j.url);
  const tags = [
    j.remote ? `<span class="jtag jtag--remote">REMOTE</span>` : "",
    j.location ? `<span class="jtag">${escapeHtml(j.location)}</span>` : "",
    `<span class="jtag jtag--new">NEW</span>`,
  ].filter(Boolean).join("");

  const inner = `
      <span class="job__co">${escapeHtml(j.company)}</span>
      <span class="job__title">${escapeHtml(j.title)}</span>
      <span class="job__tags">${tags}</span>`;

  return href
    ? `<div class="job"><a class="job__link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${inner}</a></div>`
    : `<div class="job job--nolink"><div class="job__link job__link--dead">${inner}</div></div>`;
}

/* True when the filters on screen are the ones being watched. Drives the
   button label, so someone who has narrowed their search is told they can
   update the watch rather than being shown a button that appears to do
   nothing. */
function matchesCurrent() {
  const now = currentFilters();
  const saved = state?.search;
  if (!now || !saved) return false;
  return ["q", "country", "company", "mode"].every((k) => (now[k] || "") === (saved[k] || ""))
    && Boolean(now.remote) === Boolean(saved.remote);
}

function render() {
  if (!el) return;

  if (!isSignedIn()) {
    el.go.textContent = "◉ WATCH THIS SEARCH";
    el.state.innerHTML = `<a href="/signin.html">sign in</a> and we will check the boards for you`;
    el.every.hidden = true;
    el.check.hidden = true;
    el.stop.hidden = true;
    el.fresh.hidden = true;
    return;
  }

  const watching = Boolean(state?.watching);
  el.every.hidden = false;
  el.check.hidden = !watching;
  el.stop.hidden = !watching;

  if (!watching) {
    el.go.textContent = "◉ WATCH THIS SEARCH";
    el.state.textContent = "we re-run it on a schedule and show you what is new";
    el.fresh.hidden = true;
    return;
  }

  el.go.textContent = matchesCurrent() ? "◉ WATCHING" : "◉ UPDATE WATCH TO THIS";
  el.go.classList.toggle("is-on", matchesCurrent());

  const when = state.last_run ? relative(state.last_run) : "not yet";
  /* `armed` is the number of live alarms. Watching with none means the
     schedule did not survive — every other field would still read "watching"
     while nothing ever fired again, which is the failure this whole feature is
     least able to notice on its own. Say it out loud. */
  const unarmed = !state.dormant && state.armed === 0;

  el.state.textContent = state.dormant
    ? `paused after 60 quiet days — press check to resume`
    : unarmed
    ? `${state.summary} · schedule is not running — press check to restart it`
    : state.last_error
    ? `${state.summary} · ${state.last_error}`
    : `${state.summary} · checked ${when}`;
  el.state.classList.toggle(
    "is-warn",
    Boolean(state.last_error) || state.dormant || unarmed
  );

  const fresh = state.fresh || [];
  el.fresh.hidden = fresh.length === 0;
  if (fresh.length) {
    el.count.textContent = `${fresh.length} NEW SINCE YOU LOOKED`;
    el.list.innerHTML = fresh.map(card).join("");
  }
}

function relative(iso) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (Number.isNaN(mins)) return "";
  if (mins < 60) return "just now";
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/* Every mutation returns the full snapshot, so there is one render path and no
   chance of the button and the strip disagreeing about what is saved. */
async function call(path, options = {}) {
  if (busy) return;
  busy = true;
  el.go.disabled = true;
  try {
    const res = await fetch(path, {
      headers: { "content-type": "application/json" },
      ...options,
    });
    const data = await res.json();
    if (!res.ok) {
      el.state.textContent = data.error || "that did not work — try again";
      el.state.classList.add("is-warn");
      return;
    }
    state = data;
    render();
  } catch {
    el.state.textContent = "could not reach the watcher — try again in a moment";
    el.state.classList.add("is-warn");
  } finally {
    busy = false;
    el.go.disabled = false;
  }
}

function save() {
  if (!isSignedIn()) {
    location.href = "/signin.html";
    return;
  }
  return call("/api/watch", {
    method: "POST",
    body: JSON.stringify({ search: currentFilters(), interval: el.every.value }),
  });
}

export async function initWatch() {
  const section = $("watch");
  if (!section) return;

  el = {
    section,
    go: $("watchGo"),
    every: $("watchEvery"),
    state: $("watchState"),
    check: $("watchCheck"),
    stop: $("watchStop"),
    fresh: $("watchFresh"),
    count: $("watchCount"),
    list: $("watchList"),
    ack: $("watchAck"),
  };

  el.every.innerHTML = Object.entries(LABELS)
    .map(([v, label]) => `<option value="${v}"${v === "daily" ? " selected" : ""}>${label}</option>`)
    .join("");

  el.go.addEventListener("click", save);
  /* Re-saving with the same search keeps the pending roles — the agent only
     re-baselines when the search itself changed — so changing frequency does
     not throw away what the user came back to read. */
  el.every.addEventListener("change", () => state?.watching && save());
  el.check.addEventListener("click", () => call("/api/watch/check", { method: "POST" }));
  el.stop.addEventListener("click", () => call("/api/watch", { method: "DELETE" }));
  el.ack.addEventListener("click", () => call("/api/watch/ack", { method: "POST" }));

  // The label depends on whether the filters still match what is saved.
  document.addEventListener("moggers:search", render);
  onAuthChange(() => refresh());

  section.hidden = false;
  await refresh();
}

async function refresh() {
  if (!isSignedIn()) {
    state = null;
    render();
    return;
  }
  try {
    const res = await fetch("/api/watch");
    if (!res.ok) throw new Error(res.status);
    state = await res.json();
    if (state.interval) el.every.value = state.interval;
  } catch {
    /* No watcher behind us (vite dev, or the binding is missing). Say nothing
       rather than offering a button that cannot work. */
    el.section.hidden = true;
    return;
  }
  render();
}
