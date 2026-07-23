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

/* The key lives in this browser and nowhere else. It is sent with each match
   request, used once server-side, and never persisted there. localStorage is
   readable by any script on this origin — acceptable because the strict CSP
   admits no third-party scripts, and the alternative (storing it on our server)
   would make us custodian of user credentials. */
const KEY_STORE = "moggers_gemini_key";

function loadKey() {
  try { return localStorage.getItem(KEY_STORE) || ""; } catch { return ""; }
}
function saveKey(v) {
  try { v ? localStorage.setItem(KEY_STORE, v) : localStorage.removeItem(KEY_STORE); } catch { /* private mode */ }
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

  const key = $("byokKey")?.value.trim() || "";

  try {
    const res = await fetch("/api/match", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(key ? { resume: text, gemini_key: key } : { resume: text }),
    });
    const data = await res.json();

    if (!res.ok) {
      /* When OUR budget is spent — or the model backend is down — point at the
         fallback rather than just saying no. The user can keep going on their
         own free quota either way, and being told "unavailable" with no way
         forward is what makes a working feature feel broken. */
      const extra = data.budget_exhausted || data.backend_down
        ? ` <button type="button" class="matchout__byok" id="matchOpenByok">use your own Gemini key →</button>`
        : "";
      out.innerHTML = `<p class="matchout__msg">${escapeHtml(data.error || "matching failed")}${extra}</p>`;
      $("matchOpenByok")?.addEventListener("click", () => {
        $("byok").open = true;
        $("byokKey").focus();
      });
      return;
    }
    if (!data.matches?.length) {
      out.innerHTML = `<p class="matchout__msg">No close roles found. Try including more of your skills.</p>`;
      return;
    }

    const banner = data.byok
      ? `<p class="matchout__msg">Matched with your own Gemini key — this did not touch the shared budget.</p>`
      : data.degraded
      ? `<p class="matchout__msg">Ranked by similarity — the model's notes were unavailable this time.</p>`
      : "";
    out.innerHTML = banner + data.matches.map(card).join("");
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

  // Once edited by hand it is the user's text, not the scan's.
  $("matchInput").addEventListener("input", (e) => { delete e.target.dataset.fromScan; });

  const keyInput = $("byokKey");
  const remember = $("byokRemember");
  if (keyInput) {
    const existing = loadKey();
    if (existing) {
      keyInput.value = existing;
      $("byok").open = true;
    }
    const persist = () => saveKey(remember?.checked ? keyInput.value.trim() : "");
    keyInput.addEventListener("change", persist);
    remember?.addEventListener("change", persist);
  }

  /* Prefill from the X-Ray scan. Two entry points for the same action: the
     button inside the results (discoverable right after a scan) and the one
     here (for someone who scrolled down first). Neither sends — that stays the
     SEND button below, in the section carrying the warning. */
  const fill = $("matchFill");

  const prefill = (text) => {
    if (!text) return;
    $("matchInput").value = text.slice(0, 6000);
    /* Marks this text as scan-derived so clearing the scan can remove it, while
       leaving anything the user typed themselves untouched. */
    $("matchInput").dataset.fromScan = "1";
    if (fill) fill.hidden = true;
    section.scrollIntoView({ behavior: "smooth", block: "start" });
    /* Flash the section so it is obvious where the text landed and that a
       second, deliberate click is still required. */
    section.classList.add("is-filled");
    setTimeout(() => section.classList.remove("is-filled"), 1200);
    $("matchInput").focus();
  };

  if (fill && typeof getScanText === "function") {
    fill.addEventListener("click", () => prefill(getScanText()));
    document.addEventListener("moggers:scanned", () => { fill.hidden = false; });
  }
  document.addEventListener("moggers:usescan", (e) => prefill(e.detail));

  /* Clearing the scan clears anything taken from it, so a new PDF cannot be
     matched against the previous resume's text. */
  document.addEventListener("moggers:cleared", () => {
    if (fill) fill.hidden = true;
    if ($("matchInput").value && $("matchInput").dataset.fromScan === "1") {
      $("matchInput").value = "";
    }
    $("matchOut").innerHTML = "";
  });
}
