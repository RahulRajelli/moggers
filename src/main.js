import "./style.css";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/* ── thresholds, ported from jobtracker/pdfcheck.py ───────────────────────
   A one-page resume extracting under MIN_CHARS_PER_PAGE isn't a text PDF —
   it's an image, or the fonts carry no usable encoding. Either way the
   parser sees nothing.                                                     */
const MIN_CHARS_PER_PAGE = 900;
const MAX_RESUME_PAGES = 2;

/* Typographic ligatures are the trap: the renderer writes "verification"
   into the text layer as veri<U+FB01>cation — a single glyph. Visually
   perfect; a keyword search for "verification" does not match it. */
const LIGATURES = {
  "ﬀ": "ff",
  "ﬁ": "fi",
  "ﬂ": "fl",
  "ﬃ": "ffi",
  "ﬄ": "ffl",
  "ﬅ": "ft",
  "ﬆ": "st",
};
const LIG_CHARS = Object.keys(LIGATURES);
const LIG_CLASS = `[${LIG_CHARS.join("")}]`;
const LIG_RX = new RegExp(LIG_CLASS, "g"); // scanning/highlighting only
const HAS_LIG = new RegExp(LIG_CLASS); // non-global: safe for .test() in a loop

const CONTACT_RX = {
  email: /[\w.+-]+@[\w-]+\.[\w.]+/,
  phone: /\+?\d[\d\s()-]{8,}\d/,
  linkedin: /linkedin\.com\/in\/[\w-]+/i,
};

/* A JD under this length is a fragment, not a posting. Few skills are
   detectable, so keyword coverage looks misleadingly high. */
const MIN_JD_CHARS = 1500;

const STOP = new Set(`a an and are as at be by for from has have in is it its of on or that the to
with will you your our we they their this these those but not can able using use used work works
working experience experienced years year role position job candidate candidates team teams company
companies who what when where which while about across into over under more most other others
such than then them there they've we're you'll must should would could may might also including
include includes strong good great excellent ability skills skill knowledge understanding new
across within per via based help helps required require requires requirements responsibilities
etc plus preferred desired ideal ideally looking join build building develop developing support
learn learning ensure ensuring deliver delivering drive driving lead leading manage managing`
  .split(/\s+/).filter(Boolean));

/* ── DOM ─────────────────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const drop = $("drop");
const fileInput = $("file");
const dropLabel = $("dropLabel");
const results = $("results");
const jdBox = $("jd");
const jdWarn = $("jdWarn");

/* ── text extraction ─────────────────────────────────────────────────── */
async function extractPdf(buffer) {
  const doc = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    /* disableNormalization is essential. Left on, pdf.js silently rewrites
       U+FB01 to "fi" — which would hide the exact defect this tool exists to
       find, and disagree with what pypdf/pdftotext (and therefore a real ATS)
       actually see. Off, the raw glyph survives.

       Items are concatenated with no separator: a ligature arrives as its own
       text item, so joining on " " would fabricate "veri ﬁ cation". pdf.js
       already carries intra-line spacing inside item.str; only line breaks
       need adding. */
    const tc = await page.getTextContent({ disableNormalization: true });
    let out = "";
    for (const it of tc.items) {
      out += it.str;
      if (it.hasEOL) out += "\n";
    }
    pages.push(out);
  }
  return { text: pages.join("\n"), pageCount: doc.numPages };
}

const flatten = (s) => s.split(/\s+/).filter(Boolean).join(" ");
const deligature = (s) => LIG_CHARS.reduce((acc, c) => acc.split(c).join(LIGATURES[c]), s);

/* ── the five checks ─────────────────────────────────────────────────── */
function runChecks(text, pageCount) {
  const flat = flatten(text);
  const checks = [];

  // 1 — is there a text layer at all
  checks.push(
    flat.length === 0
      ? {
          state: "fail",
          title: "No text layer",
          body: "The parser reads nothing at all from this file — it is a scanned image, or the fonts carry no usable encoding.",
          fix: "Export straight from your editor as PDF. Never 'print to image', never scan a printout.",
        }
      : {
          state: "pass",
          title: "Text layer present",
          body: `${flat.length.toLocaleString()} characters extracted. A parser can read this file.`,
        }
  );

  // 2 — ligatures (the headline check)
  const found = [...new Set(text.match(LIG_RX) || [])];
  if (found.length) {
    const words = [...new Set(
      text.split(/\s+/)
        .filter((w) => HAS_LIG.test(w))
        .map((w) => w.replace(/^[.,;:()[\]"']+|[.,;:()[\]"']+$/g, ""))
        .filter(Boolean)
    )].slice(0, 8);
    checks.push({
      state: "fail",
      title: `${found.length} ligature glyph${found.length > 1 ? "s" : ""} in the text layer`,
      body:
        "These words are NOT keyword-searchable by an ATS: " +
        words.map((w) => `“${w}” → “${deligature(w)}”`).join(", ") +
        ".",
      fix: "Set font-variant-ligatures: none in your resume template (or pick a font without them), then re-export.",
    });
  } else {
    checks.push({
      state: "pass",
      title: "No ligatures",
      body: "Every word in the text layer is searchable as plain characters.",
    });
  }

  // 3 — page count
  checks.push(
    pageCount === 0
      ? { state: "fail", title: "Unreadable page count", body: "The file may be corrupt." }
      : pageCount > MAX_RESUME_PAGES
      ? {
          state: "warn",
          title: `${pageCount} pages`,
          body: `Over the ${MAX_RESUME_PAGES}-page limit. Recruiters and parsers routinely truncate.`,
          fix: "Cut to two pages. Anything a parser truncates may as well not exist.",
        }
      : { state: "pass", title: `${pageCount} page${pageCount > 1 ? "s" : ""}`, body: "Within the limit parsers and recruiters read." }
  );

  // 4 — text density
  const expected = MIN_CHARS_PER_PAGE * Math.min(pageCount || 1, 1);
  checks.push(
    flat.length > 0 && flat.length < expected
      ? {
          state: "warn",
          title: "Thin text layer",
          body: `Only ${flat.length.toLocaleString()} characters across ${pageCount} page(s). Much of the page is probably not extractable — text baked into graphics, or a text box the parser skips.`,
          fix: "Avoid text inside images, icons or shapes. Keep a single-column layout with no tables.",
        }
      : {
          state: flat.length ? "pass" : "fail",
          title: "Text density",
          body: flat.length ? "Enough extractable text for the whole document to be read." : "Nothing to measure — there is no text layer.",
        }
  );

  // 5 — contact details (the most expensive failure in the pipeline)
  const contact = Object.fromEntries(
    Object.entries(CONTACT_RX).map(([k, rx]) => [k, rx.test(flat)])
  );
  const missing = Object.entries(contact).filter(([, ok]) => !ok).map(([k]) => k);
  const critical = missing.filter((m) => m !== "linkedin");
  checks.push(
    critical.length
      ? {
          state: "fail",
          title: `Contact details unreadable (${critical.join(", ")})`,
          body: "An automated parser cannot extract how to reach you. This is the single most expensive failure on the list — everything else is moot if nobody can reply.",
          fix: "Put email and phone as plain selectable text in the body. Not in the header/footer, not as an icon, not as an image.",
        }
      : {
          state: missing.length ? "warn" : "pass",
          title: missing.length ? "Contact details readable (LinkedIn missing)" : "Contact details readable",
          body: `Parseable: ${Object.entries(contact).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}.`,
        }
  );

  return checks;
}

/* ── JD keywords ─────────────────────────────────────────────────────── */
function jdKeywords(jd, limit = 20) {
  const freq = new Map();
  for (const raw of jd.toLowerCase().match(/[a-z][a-z0-9+#./-]{1,}/g) || []) {
    const t = raw.replace(/^[./-]+|[./-]+$/g, "");
    if (t.length < 3 || STOP.has(t)) continue;
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([t]) => t);
}

/* ── rendering ───────────────────────────────────────────────────────── */
/* The text layer comes from a PDF the visitor chose, so this is self-XSS at
   worst — but it is still attacker-controlled markup if someone is handed a
   malicious "resume" to test. Escape all five, same as src/jobs.js. */
const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

function renderChecks(checks) {
  $("checks").innerHTML = checks
    .map(
      (c) => `
    <li class="check check--${c.state}">
      <span class="check__flag">${c.state.toUpperCase()}</span>
      <div class="check__body">
        <strong>${escapeHtml(c.title)}</strong>
        <p>${escapeHtml(c.body)}</p>
        ${c.fix ? `<p class="check__fix">FIX → ${escapeHtml(c.fix)}</p>` : ""}
      </div>
    </li>`
    )
    .join("");
}

function renderVerdict(checks) {
  const passed = checks.filter((c) => c.state === "pass").length;
  const failed = checks.filter((c) => c.state === "fail").length;
  const el = $("verdict");
  el.classList.toggle("is-fail", failed > 0);
  el.classList.toggle("is-pass", passed === checks.length);
  $("verdictNum").textContent = passed;
  $("verdictTitle").textContent = failed
    ? "THE PARSER IS DROPPING YOU"
    : passed === checks.length
    ? "CLEAN — THE PARSER READS EVERYTHING"
    : "READABLE, WITH WARNINGS";
  $("verdictSub").textContent = failed
    ? `${failed} check${failed > 1 ? "s" : ""} failed. Fix these before you send this resume anywhere else — every application until then is being filtered on arrival.`
    : passed === checks.length
    ? "Every keyword on this resume is machine-readable. Now go make the content worth reading."
    : "Nothing is silently broken, but the warnings below cost you reach.";
}

function renderLayer(text, pageCount) {
  const flat = flatten(text);
  $("layerMeta").textContent = `${pageCount} page(s) · ${flat.length.toLocaleString()} chars · pdf.js text layer`;
  $("layer").innerHTML =
    escapeHtml(flat.slice(0, 6000)).replace(LIG_RX, (c) => `<span class="lig">${c}</span>`) ||
    "(empty — the parser sees nothing)";
}

function renderKeywords(text) {
  const jd = jdBox.value.trim();
  const panel = $("kwPanel");
  if (!jd) { panel.hidden = true; return; }

  jdWarn.hidden = jd.length >= MIN_JD_CHARS;
  if (!jdWarn.hidden) {
    jdWarn.textContent = `⚠ This JD is ${jd.length} characters — under ${MIN_JD_CHARS}, it's a fragment, not a full posting. Keyword coverage measured on it will read far higher than reality.`;
  }

  // Match against the RAW layer — that is what the ATS actually sees.
  const low = flatten(text).toLowerCase();
  const kws = jdKeywords(jd);
  panel.hidden = kws.length === 0;
  $("kw").innerHTML = kws
    .map((k) => {
      const hit = low.includes(k);
      return `<span class="chip chip--${hit ? "hit" : "miss"}">${hit ? "✓" : "✗"} ${escapeHtml(k)}</span>`;
    })
    .join("");
}

/* ── flow ────────────────────────────────────────────────────────────── */
async function handleFile(file) {
  if (!file) return;
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    dropLabel.textContent = "THAT'S NOT A PDF";
    return;
  }

  drop.classList.add("is-busy");
  dropLabel.textContent = "READING…";

  try {
    const { text, pageCount } = await extractPdf(await file.arrayBuffer());
    const checks = runChecks(text, pageCount);

    renderVerdict(checks);
    renderChecks(checks);
    renderLayer(text, pageCount);
    renderKeywords(text);

    results.hidden = false;
    /* Kept in memory only, so the matcher can offer a prefill. Never sent. */
    lastScanText = deligature(flatten(text));
    document.dispatchEvent(new CustomEvent("moggers:scanned"));
    dropLabel.textContent = file.name.toUpperCase();
    results.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    console.error(err);
    dropLabel.textContent = "COULDN'T READ THAT FILE";
  } finally {
    drop.classList.remove("is-busy");
  }
}

/* Reset back to a clean slate. The file input must be cleared explicitly:
   without it, re-picking the SAME file fires no `change` event (the value is
   unchanged), so a user who fixed their PDF and re-selected it would see
   nothing happen — which reads as a broken tool. */
function resetScan() {
  fileInput.value = "";
  lastScanText = "";
  results.hidden = true;
  $("checks").innerHTML = "";
  $("layer").innerHTML = "";
  $("kwPanel").hidden = true;
  dropLabel.textContent = "DROP YOUR PDF";
  drop.classList.remove("is-busy");
  document.dispatchEvent(new CustomEvent("moggers:cleared"));
  drop.scrollIntoView({ behavior: "smooth", block: "center" });
}

$("scanReset").addEventListener("click", resetScan);

/* Hand the scanned text to the matcher and scroll there. Deliberately does NOT
   send: the X-Ray section promises nothing leaves the device, so the one click
   that transmits stays the matcher's own SEND button, in the section that
   carries the warning. Prefilling is not sending. */
$("matchFromScan").addEventListener("click", () => {
  document.dispatchEvent(new CustomEvent("moggers:usescan", { detail: lastScanText }));
});

drop.addEventListener("click", () => fileInput.click());
drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener("change", (e) => handleFile(e.target.files[0]));

["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("is-over"); })
);
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("is-over"); })
);
drop.addEventListener("drop", (e) => handleFile(e.dataTransfer.files[0]));

/* The specimen used to be WebGL and is now inline SVG in index.html, animated
   in CSS — no import, no chunk, no runtime, nothing to fail. That removed the
   130 kB three.js bundle, which was the heaviest thing on the page by an order
   of magnitude. Don't reintroduce it for decoration. */

/* Same contract for the job index: it needs a Worker + D1 behind it, which
   `vite dev` does not have. If the API is absent the section removes itself.
   Auth resolves first so the first render of the job list already knows which
   roles are saved — otherwise every star flickers on. */
import("./auth.js")
  .then(({ initAuth }) => initAuth())
  .catch((err) => console.warn("auth unavailable:", err))
  .finally(() => {
    import("./jobs.js")
      .then(({ initJobs }) => initJobs())
      /* The watcher sits inside the job section and saves the same filters, so
         it only makes sense once that section is up. It removes itself if the
         /api/watch endpoint is not there. */
      .then(() => import("./watch.js").then(({ initWatch }) => initWatch()))
      .catch((err) => console.warn("job index unavailable:", err));
    /* The matcher needs the same Worker backend. It reveals itself only if the
       module loads, so `vite dev` (no API) shows nothing rather than a button
       that always fails. */
    import("./match.js")
      .then(({ initMatch }) => initMatch(() => lastScanText))
      .catch((err) => console.warn("matcher unavailable:", err));
  });

/* Held so the matcher can offer to prefill from a scan the user already ran —
   it never leaves the page on its own. */
let lastScanText = "";

/* A resume rendered from the same template with ligatures left on — the exact
   defect this tool looks for, so the failure mode is demonstrable without
   asking anyone to hand over their CV. */
$("sample").addEventListener("click", async () => {
  dropLabel.textContent = "FETCHING SAMPLE…";
  try {
    const res = await fetch("/sample/broken-resume.pdf");
    if (!res.ok) throw new Error(res.status);
    await handleFile(new File([await res.blob()], "broken-resume.pdf", { type: "application/pdf" }));
  } catch (err) {
    console.error(err);
    dropLabel.textContent = "SAMPLE UNAVAILABLE";
  }
});
