# moggers.in — dual-language ad

~45 s. Hindi + English, one voice each.

## The device

**Hindi is the human. English is the machine.**

The ad never translates itself. The Hindi voice carries what the applicant
feels; the English voice carries what the system does. They never address each
other, and that is the whole point — the ad *is* the product's argument, staged
as two languages talking past one another.

This is why it is bilingual rather than "a Hindi version and an English
version". A subtitled translation would destroy it: the gap between the two
tracks is the message.

**Casting is the concept, so do not soften it:**

| Track | Voice | Direction |
|---|---|---|
| Hindi | Warm, mid-30s, conversational | Someone talking to a friend, not performing. Slightly tired. |
| English | Flat, clipped, synthetic | A system log read aloud. No emotion, no emphasis, no warmth. Never *sinister* — indifferent is worse and truer. |

The English voice must sound **indifferent, not villainous**. An ATS is not
malicious; it simply cannot read. Making it a villain is the cheap version and
also a lie.

## Script

Timings are indicative. Final durations live in `edl.ts` and nowhere else.

| # | Time | Hindi (VO) | English (VO) | On screen |
|---|---|---|---|---|
| 1 | 0–4s | "Teen mahine. Do sau applications." | — | Black. Counter ticking to 200. |
| 2 | 4–8s | "Ek bhi reply nahi." | — | Counter stops. Silence beat. |
| 3 | 8–12s | "Resume perfect hai, yaar. Maine check kiya." | — | A clean, well-designed resume fills the frame. |
| 4 | 12–17s | — | "Parsing document. Extracting text layer." | Acid scan band sweeps the page. |
| 5 | 17–23s | — | "Token: v-e-r-i-□-c-a-t-i-o-n. No match." | **veriﬁcation** → the ﬁ turns red → collapses to □ |
| 6 | 23–26s | "…matlab?" | — | Hold. This is the only moment the two tracks touch. |
| 7 | 26–32s | — | "Candidate not found." | The resume greys out. |
| 8 | 32–38s | "Tumhari galti nahi thi. Font ki thi." | — | Cut to moggers.in. THE MOGGER adjusts his tie. |
| 9 | 38–43s | — | "Check what the machine actually reads." | ATS X-Ray running: 1/5 → ABSOLUTELY MOGGED |
| 10 | 43–45s | "Free hai. Kuch upload nahi hota." | — | `moggers.in` · SURVIVE THE FILTER |

### The line the whole ad is built for

> **"Tumhari galti nahi thi. Font ki thi."**
> *(It wasn't your fault. It was the font's.)*

Everything before it sets this up; everything after it is the call to action.
If a cut has to lose something, it does not lose this.

Beat 6 — the single "…matlab?" — is the only place the human answers the
machine, and the machine does not hear it. Do not add a reply.

## Why this and not the obvious version

The obvious version is a founder explaining features over screen recordings.
That ad is about the product. This one is about the viewer's last three months,
and only mentions the product once it has named the thing they could not.

It also **does not oversell**. The claim is narrow and true: the parser could
not read the words. It does not promise a job, a callback, or a "94% ATS
score" — that is the exact thing this site was built to argue against, and an
ad that made it would poison the product.

## Voice generation (ElevenLabs)

Two voices, one model — `eleven_multilingual_v2` handles both languages.

**Do not paste the API key into chat.** Put it in `.dev.vars` (already
gitignored) as `ELEVENLABS_API_KEY=...` or export it in the shell; the build
script reads it from the environment and never prints it.

Per line, not per track: generate each numbered beat as its own file so a
retimed cut does not need a re-render of the whole VO.

```
audio/hi-01.mp3 … hi-10.mp3
audio/en-04.mp3 … en-09.mp3
```

Hindi direction note: write the Hindi lines in **Devanagari** for the API even
though they are romanised above — romanised Hindi makes the multilingual model
reach for English phonemes and the result sounds like an accent rather than a
speaker.

## Render

Remotion, via the existing Codex pipeline used for the robosimtools promo.
Conventions that carry over and are easy to lose:

- **All timing lives in `src/edl.ts`.** Nothing else holds durations.
- **`--gl=angle` is required** on this machine or the render fails.
- The 3D Mogger belongs here and nowhere else — the site deliberately deleted
  three.js, and an offline render costs the site zero bytes.

## Cutdowns

- **15 s** — beats 3, 5, 8, 10. The reveal and the line, nothing else.
- **6 s (bumper)** — beat 5 and the URL. No voice; the glyph collapse carries it.
