/* The shareable verdict card.
 *
 * A scan result nobody can show anyone is a scan result that spreads nowhere,
 * and this tool's whole distribution argument is that the failure is
 * surprising enough to post about. So: a PNG of the verdict, with the number
 * and the one specific defect on it.
 *
 * IT DOES NOT BREAK THE PRIVACY CLAIM, and that is the constraint everything
 * here bends around:
 *
 *   - The card is drawn on a <canvas> in this browser. No upload, no render
 *     service, no third-party image API — `connect-src 'self'` would refuse one
 *     anyway, which is the point of having the policy.
 *   - NOTHING FROM THE RESUME GOES ON IT. Not the name, not the contact
 *     details, not a line of the text layer. Only the counts, the verdict, and
 *     the ligature GLYPHS themselves (ﬁ, ﬂ — characters, not words). Someone
 *     posting this cannot leak their own CV by accident, which they absolutely
 *     would if it carried the extracted text.
 *   - It is downloaded or handed to the OS share sheet. It is never sent
 *     anywhere by this code.
 */

const W = 1200;
const H = 630;

const INK = "#0B0B0B";
const PAPER = "#F4F1E9";
const ACID = "#D8FF1A";
const ALERT = "#FF3B18";

/* Canvas cannot use a webfont that has not finished loading — it silently
   substitutes and the card comes out in Times. Fontsource loads these, so wait
   for them and fall back to a stack that at least keeps the proportions. */
const DISPLAY = '"Archivo Black", "Arial Black", system-ui, sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';

function roundedText(ctx, text, x, y, maxWidth) {
  let t = String(text);
  while (t.length > 4 && ctx.measureText(t).width > maxWidth) t = t.slice(0, -1);
  if (t !== text) t = t.slice(0, -1) + "…";
  ctx.fillText(t, x, y);
  return t;
}

/**
 * Draw the card. `result` is { passed, total, failed, title, ligatures, worst }.
 * Returns the canvas.
 */
export function drawCard(result) {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  const clean = result.failed === 0;

  // ── ground ──
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);

  // The same 5px rule as the specimen's backing grid, so the card is
  // recognisably from this site even cropped in a timeline.
  ctx.strokeStyle = "rgba(11,11,11,0.05)";
  ctx.lineWidth = 1;
  for (let y = 0; y < H; y += 5) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(W, y + 0.5);
    ctx.stroke();
  }

  ctx.strokeStyle = INK;
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, W - 10, H - 10);

  // ── top bar ──
  ctx.fillStyle = INK;
  ctx.fillRect(10, 10, W - 20, 92);
  ctx.fillStyle = ACID;
  ctx.fillRect(46, 40, 32, 32);
  ctx.fillStyle = PAPER;
  ctx.font = `40px ${DISPLAY}`;
  ctx.textBaseline = "middle";
  ctx.fillText("MOGGERS", 96, 58);
  ctx.font = `20px ${MONO}`;
  ctx.fillStyle = ACID;
  ctx.textAlign = "right";
  ctx.fillText("ATS X-RAY", W - 46, 58);
  ctx.textAlign = "left";

  // ── the score ──
  const boxX = 60;
  const boxY = 150;
  const boxW = 300;
  const boxH = 300;
  ctx.fillStyle = clean ? ACID : INK;
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 6;
  ctx.strokeRect(boxX, boxY, boxW, boxH);

  ctx.fillStyle = clean ? INK : PAPER;
  ctx.font = `180px ${DISPLAY}`;
  ctx.textAlign = "center";
  ctx.fillText(String(result.passed), boxX + boxW / 2, boxY + 130);
  ctx.font = `28px ${MONO}`;
  ctx.fillText(`of ${result.total} checks`, boxX + boxW / 2, boxY + 232);
  ctx.textAlign = "left";

  // ── verdict ──
  const textX = boxX + boxW + 56;
  const textW = W - textX - 60;

  ctx.fillStyle = clean ? INK : ALERT;
  ctx.font = `54px ${DISPLAY}`;
  const lines = wrap(ctx, result.title.toUpperCase(), textW);
  lines.slice(0, 3).forEach((line, i) => {
    ctx.fillText(line, textX, boxY + 44 + i * 62);
  });

  ctx.fillStyle = INK;
  ctx.font = `26px ${MONO}`;
  const detailY = boxY + 44 + Math.min(lines.length, 3) * 62 + 34;

  if (result.ligatures > 0) {
    /* The ligature glyphs themselves are the whole demonstration: they look
       like normal words and are not. Rendered large, in alert red, because on
       a shared image they are the thing that makes someone check their own. */
    ctx.fillText(`${result.ligatures} ligature glyphs the parser cannot search:`, textX, detailY);
    ctx.font = `72px ${DISPLAY}`;
    ctx.fillStyle = ALERT;
    roundedText(ctx, result.worst || "ﬁ ﬂ ﬀ", textX, detailY + 62, textW);
  } else if (result.worst) {
    roundedText(ctx, result.worst, textX, detailY, textW);
  }

  // ── footer ──
  ctx.fillStyle = INK;
  ctx.font = `26px ${MONO}`;
  ctx.fillText("moggers.in", textX, H - 62);
  ctx.fillStyle = "rgba(11,11,11,0.5)";
  ctx.font = `20px ${MONO}`;
  ctx.textAlign = "right";
  ctx.fillText("checked in-browser · nothing uploaded", W - 60, H - 62);
  ctx.textAlign = "left";

  return canvas;
}

function wrap(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/);
  const out = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > maxWidth && line) {
      out.push(line);
      line = w;
    } else {
      line = next;
    }
  }
  if (line) out.push(line);
  return out;
}

const blobFrom = (canvas) =>
  new Promise((resolve) => canvas.toBlob(resolve, "image/png"));

/**
 * Produce the card and hand it to the OS share sheet, or download it.
 *
 * navigator.share with files is the good path on a phone, which is where this
 * gets posted from. It THROWS if the user dismisses the sheet, and that is not
 * an error worth reporting — hence the swallow on AbortError specifically
 * rather than a blanket catch that would hide a real failure.
 */
export async function shareCard(result) {
  if (document.fonts?.ready) await document.fonts.ready;
  const canvas = drawCard(result);
  const blob = await blobFrom(canvas);
  if (!blob) throw new Error("could not render the card");

  const file = new File([blob], "moggers-ats-xray.png", { type: "image/png" });

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        text: `${result.passed}/${result.total} ATS checks survived. Check yours at moggers.in`,
      });
      return "shared";
    } catch (err) {
      if (err?.name === "AbortError") return "cancelled";
      // Sharing can fail for reasons the download path will not — fall through.
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "moggers-ats-xray.png";
  a.click();
  /* Revoke on the next frame, not immediately: Safari has cancelled the
     download when the URL is freed synchronously after click(). */
  requestAnimationFrame(() => URL.revokeObjectURL(url));
  return "downloaded";
}
