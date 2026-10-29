# UH Parrot v2 — offline medical dictation for the browser

Built 2026-10-29 for University Hospitals during the Dragon outage. Version 2 (same day, evening): speech model fine-tuned on surgical dictation. Contact: Matthew Burstein, MD, PhD.

UH Parrot is a static web app. A clinician opens it in Chrome or Edge, presses Record, dictates, and copies the
finished text into Epic. Speech recognition runs inside the browser using the OpenAI Whisper model via WebAssembly.
There is no server-side code, no database, no login, and no network traffic other than loading the static files
from this site.

## What is in this folder

| Path | Purpose | Size |
|---|---|---|
| `index.html` | The app page (includes the Content-Security-Policy that blocks all external connections) | 15 KB |
| `netguard.js` | Refuses any request that is not to this site's own origin; loaded first in the page and the worker | 2 KB |
| `app.js`, `textengine.js`, `phonetic.js`, `english_exclusions.js`, `terms/*.js`, `logo.png`, `favicon.png` | Interface, voice commands, medical vocabulary (about 9,000 terms) with phonetic correction | ~2 MB |
| `worker.js`, `engine.js` | Web Worker that runs the speech model off the UI thread | 5 KB |
| `lib/transformers.min.js` | Transformers.js v3 (Hugging Face), Apache-2.0 | 0.6 MB |
| `lib/ort-wasm-simd-threaded.asyncify.{mjs,wasm}` | ONNX Runtime Web (Microsoft), MIT | 27 MB |
| `model/whisper-base.en/` | OpenAI Whisper base.en (MIT), fine-tuned by UH on about 8,000 surgical dictation clips (real op-note sentences in 20 synthetic voices plus about 25 minutes of surgeon dictation), int8 ONNX. Same architecture and runtime as v1. | 105 MB |
| `SHA256SUMS.txt` | Checksums of every file | |
| `NETWORK-AUDIT.txt` | Log of every network request made during a full load-and-transcribe run in headless Chrome | |

## Deployment

1. Copy this folder to any static web host (IIS, nginx, Apache, SharePoint library that serves raw files). No
   server-side runtime is needed.
2. **Serve over HTTPS.** Chrome refuses microphone access on plain `http://` pages. An internal certificate is fine.
   If HTTPS is impossible, the alternative is the Chrome policy `OverrideSecurityRestrictionsOnInsecureOrigin`
   (shown in chrome://flags as "Insecure origins treated as secure") listing the site URL.
3. MIME types: `.wasm` → `application/wasm`, `.onnx` → `application/octet-stream`, `.mjs` and `.js` →
   `text/javascript`, `.json` → `application/json`. IIS needs `.wasm`, `.onnx`, and `.mjs` added under MIME Types.
4. Cache headers for `lib/` and `model/`: `Cache-Control: public, max-age=31536000, immutable`. First load pulls
   ~135 MB over the intranet; afterwards the browser cache makes loads instant.
5. Optional, for speed: response headers `Cross-Origin-Opener-Policy: same-origin` and
   `Cross-Origin-Embedder-Policy: require-corp` let the engine use up to 4 CPU threads. Without them it runs
   single-threaded, which still works.
6. Optional, for convenience: Chrome policy `AudioCaptureAllowedUrls` with the site URL pre-approves the microphone
   so users are not prompted.

## Workstation requirements

Chrome or Edge version 100 or newer (UH is on Chrome 152), Windows 10 or 11, any microphone. No admin rights,
no install, nothing written to disk beyond the browser cache. RAM while running: about 450 MB.
Speed on a typical workstation CPU: close to real time.

## Security and privacy

* Content-Security-Policy in `index.html`: `default-src 'self'; connect-src 'self'; ...`. The browser itself blocks
  any connection to a host other than this site. Attempts show up as blocked in DevTools → Network.
* `netguard.js` additionally overrides `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, and
  `importScripts` to refuse any non-same-origin URL, in both the page and the worker.
* Transformers.js is configured with `allowRemoteModels = false`, so it never contacts huggingface.co or any CDN.
* Audio is processed in memory and discarded. The transcript lives in the open tab (and in that browser's
  localStorage as a crash-recovery draft) until the user clears it. Nothing is sent anywhere.
* The only persistent data is the user's custom vocabulary and preferences in localStorage, which contain no PHI.
* Verify yourself: open DevTools → Network, reload, record a sentence. Every request will be to this site.
  `NETWORK-AUDIT.txt` contains this exact test run.

## Verifying the files

```
sha256sum -c SHA256SUMS.txt
```
(or on Windows: `CertUtil -hashfile <file> SHA256` and compare.)

## Upstream sources

* https://github.com/huggingface/transformers.js (Apache-2.0)
* https://github.com/microsoft/onnxruntime (MIT)
* https://github.com/openai/whisper (MIT); ONNX conversions from https://huggingface.co/onnx-community

## Version history

* **v2 (2026-10-29 evening)**: speech model fine-tuned on surgical dictation (on a held-out op note dictated by a
  surgeon: word error rate 20.6% → 11.7%, long medical words recognized 77% → 92%, before the vocabulary layer).
  Fixed a recorder bug that could stop hearing after 2 to 3 minutes of continuous dictation (noise-floor runaway).
  Added: optional "keep my recordings" with zip download for engine tuning, clear-all button, repetition-loop
  guard, about 60 new spoken variants from real dictation, new icon. The optional small.en model was dropped (v2
  base is more accurate on surgical terms and 3x faster).
* **v1 (2026-10-29 afternoon)**: initial release, stock Whisper base.en with the 9,000-term vocabulary layer.
