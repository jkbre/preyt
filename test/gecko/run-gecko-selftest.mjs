#!/usr/bin/env node
// Real-browser integration check (manual, needs network + a Gecko browser):
//   PREYT_GEMINI_KEY_FILE=/path/to/key.txt node test/gecko/run-gecko-selftest.mjs [videoId]
// Loads the extension as a temporary add-on into a throwaway headless profile of
// Zen (Flatpak) or Firefox via web-ext, then runs selftest.html inside the extension:
// read-only fetch from an already-open tab, owned muted tab fetch (and its cleanup), Gemini round trip.
// The key is copied into the throwaway staged extension (never into a URL) and deleted with it.
// Results are POSTed to a one-shot collector on 127.0.0.1 and printed.
// Exit codes (see verdict.mjs): 0 = all passed incl. a real model-generated summary;
// 3 = all passed but the summary was NOT verified (no key given, or Gemini quota exhausted);
// 1 = failure (zero transcript, tab left open, unexpected summarize error, timeout, ...).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, geckoVerdict } from './verdict.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const videoId = process.argv[2] || 'jNQXAC9IVRw';
const work = fs.mkdtempSync(path.join(process.env.PREYT_SELFTEST_DIR || os.tmpdir(), 'preyt-gecko-'));
const UUID = '8f0e7c1a-3b2d-4c5e-9f60-7a8b9c0d1e2f';
const EXT_ID = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8')).browser_specific_settings.gecko.id;

// Stage extension + self-test page.
const stage = path.join(work, 'ext');
fs.cpSync(path.join(root, 'extension'), stage, { recursive: true });
fs.cpSync(path.join(root, 'test/gecko/selftest'), path.join(stage, 'selftest'), { recursive: true });
fs.writeFileSync(path.join(stage, 'selftest/selftest.html'), '<!doctype html><meta charset="utf-8"><pre>running…</pre><script type="module" src="selftest.js"></script>');

const keyFile = process.env.PREYT_GEMINI_KEY_FILE;
const apiKey = keyFile ? fs.readFileSync(keyFile, 'utf8').trim() : '';
fs.writeFileSync(path.join(stage, 'selftest/key.json'), JSON.stringify({ apiKey, model: process.env.PREYT_GEMINI_MODEL || '' }), { mode: 0o600 });

const result = new Promise((resolve) => {
  const collector = http.createServer((req, res) => {
    let s = '';
    req.on('data', (d) => { s += d; });
    req.on('end', () => { res.end('ok'); collector.close(); resolve(JSON.parse(s)); });
  }).listen(47891, '127.0.0.1');
});

const wrapper = path.join(work, 'gecko.sh');
const flatpak = process.env.PREYT_GECKO_BIN ? '' : 'app.zen_browser.zen';
fs.writeFileSync(wrapper, flatpak
  ? `#!/bin/sh\nexec flatpak run --filesystem=${work} --env=MOZ_HEADLESS=1 --env=TMPDIR=${work} ${flatpak} "$@"\n`
  : `#!/bin/sh\nMOZ_HEADLESS=1 exec ${process.env.PREYT_GECKO_BIN} "$@"\n`, { mode: 0o755 });

// The add-on is installed after the browser starts, so the staged background page opens
// the self-test itself (a --start-url would load before the extension exists).
const query = `?v=${videoId}&report=${encodeURIComponent('http://127.0.0.1:47891/report')}`;
fs.appendFileSync(path.join(stage, 'background/main.js'),
  `\n// selftest only\nbrowser.tabs.create({ url: browser.runtime.getURL('selftest/selftest.html') + ${JSON.stringify(query)} });\n`);
const webext = spawn('npx', ['--yes', 'web-ext@10.8.0', 'run', '--source-dir', stage, '--firefox', wrapper, '--no-reload', '--no-input',
  '--pref', `extensions.webextensions.uuids=${JSON.stringify({ [EXT_ID]: UUID })}`,
  '--pref', 'media.autoplay.default=5'], { env: { ...process.env, TMPDIR: work }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let log = '';
webext.stdout.on('data', (d) => { log += d; });
webext.stderr.on('data', (d) => { log += d; });

const timeout = setTimeout(() => { console.error('TIMEOUT; web-ext log tail:\n' + log.slice(-3000)); cleanup(EXIT.FAIL); }, 240_000);
function cleanup(code) {
  clearTimeout(timeout);
  try { process.kill(-webext.pid, 'SIGTERM'); } catch { /* gone */ }
  // Only ever kill the throwaway browser started with our unique profile path.
  spawn('pkill', ['-f', '--', `-profile ${work}`], { stdio: 'ignore' });
  setTimeout(() => { fs.rmSync(work, { recursive: true, force: true }); process.exit(code); }, 1500);
}
const r = await result;
console.log(JSON.stringify(r, null, 2));
const verdict = geckoVerdict(r);
if (verdict.outcome === 'model-generated') console.log('PASS: transcripts read in both modes, tabs cleaned up, and a real model-generated summary came back');
else if (verdict.outcome === 'no-key') console.log('NO KEY (exit 3): transcripts verified; set PREYT_GEMINI_KEY_FILE to also verify a real Gemini summary');
else if (verdict.outcome === 'quota-limited') console.log('QUOTA-LIMITED (exit 3): transcripts verified and Gemini reached, but it returned HTTP 429, so summary generation was NOT verified');
else console.log(`FAIL:\n  - ${verdict.failures.join('\n  - ')}`);
cleanup(verdict.exitCode);
