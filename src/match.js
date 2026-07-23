/* The matcher UI.
 *
 * Strictly opt-in. Nothing leaves the browser until the button is pressed, and
 * the copy says so at the point of action rather than buried in a policy page.
 * Accepts PASTED TEXT ONLY — never the PDF — so the X-Ray's "your file never
 * leaves your device" claim stays literally true.
 */
import { isSignedIn } from "./auth.js";

const $ = (id) => document.getElementById(id);

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

function safeUrl(raw) {
  try {
    const u = new URL(String(raw));
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

function card(m) {
  const href = safeUrl(m.url);
  const fit = typeof m.fit === "number" ? m.fit : null;
  const band = fit === null ? "" : fit >= 75 ? " is-strong" : fit >= 50 ? " is-mid" : " is-weak";

  const inner = `
    <span class="match__fit${band}">${fit === null ? "—" : fit}</span>
    <span class="match__body">
      <span class="match__co">${escapeHtml(m.company)}</span>
      <span class="match__title">${escapeHtml(m.title)}</span>
      ${m.why ? `<span class="match__why">${escapeHtml(m.why)}</span>` : ""}
      ${m.gap ? `<span class="match__gap"><b>GAP</b> ${escapeHtml(m.gap)}</span>` : ""}
    </span>`;

  return href
    ? `<a class="match" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
    : `<div class="match match--nolink">${inner}</div>`;
}

let busy = false;

async function run() {
  if (busy) return;
  const text = $("matchInput").value.trim();
  const out = $("matchOut");
  const note = $("matchNote");

  if (text.length < 120) {
    note.textContent = "paste a bit more — a few hundred characters at least";
    return;
  }
  if (!isSignedIn()) {
    note.textContent = "";
    out.innerHTML = `<p class="matchout__msg">Matching needs an account —
      <a href="/signin.html">sign in</a> and try again. It is what keeps the AI
      budget from being drained by scripts.</p>`;
    return;
  }

  busy = true;
  $("matchGo").disabled = true;
  note.textContent = "";
  out.innerHTML = `<p class="matchout__msg">Embedding your resume, retrieving roles, ranking…</p>`;

  try {
    const res = await fetch("/api/match", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resume: text }),
    });
    const data = await res.json();

    if (!res.ok) {
      out.innerHTML = `<p class="matchout__msg">${escapeHtml(data.error || "matching failed")}</p>`;
      return;
    }
    if (!data.matches?.length) {
      out.innerHTML = `<p class="matchout__msg">No close roles found. Try including more of your skills.</p>`;
      return;
    }

    out.innerHTML =
      (data.degraded
        ? `<p class="matchout__msg">Ranked by similarity — the model's notes were unavailable this time.</p>`
        : "") + data.matches.map(card).join("");
  } catch {
    out.innerHTML = `<p class="matchout__msg">Matching failed. Try again in a moment.</p>`;
  } finally {
    busy = false;
    $("matchGo").disabled = false;
  }
}

export function initMatch(getScanText) {
  const section = $("matcher");
  if (!section) return;
  section.hidden = false;

  $("matchGo").addEventListener("click", run);

  /* Offer to prefill from the X-Ray scan — the text is already in the page, so
     this saves a copy-paste. It is still the user pressing send. */
  const fill = $("matchFill");
  if (fill && typeof getScanText === "function") {
    fill.addEventListener("click", () => {
      const t = getScanText();
      if (t) {
        $("matchInput").value = t.slice(0, 6000);
        fill.hidden = true;
        $("matchInput").focus();
      }
    });
    document.addEventListener("moggers:scanned", () => { fill.hidden = false; });
  }
}
