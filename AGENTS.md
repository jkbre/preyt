# Preyt – agent instructions

Firefox/Zen add-on (`extension/`) that summarizes YouTube videos with Google Gemini, called directly from the add-on with the user's own API key. No local server or bridge. Canonical instruction file; `CLAUDE.md`, `GEMINI.md`, `.cursorrules` are symlinks to it.

## Layout
- `extension/` – MV2 WebExtension, vanilla ES modules, no build step. `lib/` is pure and unit-tested (`gemini.js` = API client and error mapping, `prompt.js` = request normalisation, prompt, output parsing); `background/`, `popup/`, `options/`, `content/` are thin browser glue.
- `scripts/build.mjs` makes `dist/` (unsigned XPI + SHA256SUMS).
- `test/` – `npm test` (unit + flow tests, no network). Manual: `PREYT_GEMINI_KEY_FILE=… npm run test:gecko` (headless Zen/Firefox + network; exit 0 = real summary, 3 = not verified (no key / 429), 1 = failure).
- `demo/` – showcase harness with SIMULATED data and the rendered video.

## Commands
- `npm test` – all automated tests (no network).
- `npm run lint:ext` – `web-ext lint` (pinned version).
- `npm run build` – reproducible unsigned XPI in `dist/`.

## Rules
- API key: stored only in `storage.local` (never `storage.sync`), sent only as the `x-goog-api-key` header to `https://generativelanguage.googleapis.com` (never in a URL, log, error message or popup snapshot; the popup only gets `hasApiKey`). Requests use `credentials: 'omit'` and `referrerPolicy: 'no-referrer'`. Model ids must match `MODEL_RE` before they are put in a path. Tests cover this; keep them green.
- Untrusted text (transcript, title, description, chapters) stays fenced between random boundaries in `prompt.js`; the model gets no tools; answers are parsed as JSON and validated.
- Gemini API shape (`generateContent`, `responseJsonSchema`, error bodies): verify against the current docs (https://ai.google.dev/gemini-api/docs, now served from aistudio.google.com) before changing; keep the change inside `extension/lib/gemini.js`.
- Transcripts are fetched inside a YouTube page (current tab read-only, else an owned muted tab that is always closed). Background-page requests get HTTP 403 (moz-extension Origin); do not add broad `webRequest` to work around it.
- Never present metadata as a video summary; metadata/pasted sources must stay labelled in UI and Markdown export.
- The consent disclosure must name Google as the recipient and state the free-tier data-use terms; changing provider must reset `consentGiven`.
- Popup renders with `textContent`/DOM APIs only – no `innerHTML` with data.
- Do not disable add-on signing or TLS verification anywhere, including docs. Use Node `fetch` (not system curl) for ad-hoc network checks on this machine.
- Do not read or print real API keys.
- YouTube parsing lives in `extension/lib/innertube.js`; update `test/fixtures/youtube.mjs` (synthetic) when shapes change.
