#!/usr/bin/env node
// Renders demo/out/showcase.html in a throwaway HEADLESS Zen (Flatpak) or Firefox profile,
// grabs viewport screenshots over Marionette while the scripted (simulated) scenario runs,
// and encodes them with ffmpeg into demo/out/preyt-showcase.mp4.
//
//   node scripts/build-demo.mjs && node scripts/record-demo.mjs
//   PREYT_GECKO_BIN=/usr/bin/firefox node scripts/record-demo.mjs   # non-Flatpak browser
//
// The user's own browser profile and running instance are never touched (-no-remote,
// fresh profile, one-off Flatpak filesystem grant for the work dir only).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'demo', 'out');
const W = 1280;
const H = 720;
const PORT = 28290 + Math.floor(Math.random() * 500);
const work = fs.mkdtempSync(path.join(process.env.PREYT_DEMO_WORK || os.tmpdir(), 'preyt-demo-'));
const profile = path.join(work, 'profile');
const frames = path.join(work, 'frames');
fs.mkdirSync(profile);
fs.mkdirSync(frames);
fs.copyFileSync(path.join(out, 'showcase.html'), path.join(work, 'showcase.html'));
fs.writeFileSync(path.join(profile, 'user.js'), [
  ['marionette.port', PORT], ['browser.shell.checkDefaultBrowser', false], ['browser.aboutwelcome.enabled', false],
  ['startup.homepage_welcome_url', ''], ['browser.startup.homepage_override.mstone', 'ignore'], ['datareporting.policy.dataSubmissionEnabled', false],
  ['toolkit.telemetry.enabled', false], ['app.update.enabled', false], ['layout.css.devPixelsPerPx', '1.0'], ['ui.systemUsesDarkTheme', 0],
  ['zen.welcome-screen.seen', true], ['browser.tabs.warnOnClose', false],
].map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n') + '\n');

const geckoArgs = ['--marionette', '--no-remote', '--profile', profile];
const env = { ...process.env, MOZ_HEADLESS: '1', MOZ_HEADLESS_WIDTH: String(W + 400), MOZ_HEADLESS_HEIGHT: String(H + 300) };
const browser = process.env.PREYT_GECKO_BIN
  ? spawn(process.env.PREYT_GECKO_BIN, geckoArgs, { env, stdio: 'ignore' })
  : spawn('flatpak', ['run', `--filesystem=${work}`, '--env=MOZ_HEADLESS=1', `--env=MOZ_HEADLESS_WIDTH=${W + 400}`, `--env=MOZ_HEADLESS_HEIGHT=${H + 300}`,
    'app.zen_browser.zen', ...geckoArgs], { env, stdio: 'ignore' });

function stopBrowser() {
  try { browser.kill('SIGTERM'); } catch { /* gone */ }
  try { execFileSync('pkill', ['-f', '--', `--profile ${profile}`]); } catch { /* none left */ }
}
process.on('exit', stopBrowser);

// ---- minimal Marionette client ------------------------------------------------------
async function connect() {
  for (let i = 0; i < 120; i++) {
    try {
      return await new Promise((resolve, reject) => {
        const s = net.connect(PORT, '127.0.0.1', () => resolve(s));
        s.once('error', reject);
      });
    } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error('Marionette did not start');
}
const sock = await connect();
let buf = Buffer.alloc(0);
const waiting = new Map();
let hello;
const helloP = new Promise((r) => { hello = r; });
sock.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const colon = buf.indexOf(':');
    if (colon === -1) return;
    const len = Number(buf.subarray(0, colon).toString());
    if (buf.length < colon + 1 + len) return;
    const msg = JSON.parse(buf.subarray(colon + 1, colon + 1 + len).toString());
    buf = buf.subarray(colon + 1 + len);
    if (!Array.isArray(msg)) { hello(msg); continue; }
    const [, id, err, result] = msg;
    const w = waiting.get(id);
    waiting.delete(id);
    if (err) w.reject(new Error(`${err.error}: ${err.message}`)); else w.resolve(result);
  }
});
let seq = 0;
function cmd(name, params = {}) {
  const id = ++seq;
  const body = JSON.stringify([0, id, name, params]);
  sock.write(`${Buffer.byteLength(body)}:${body}`);
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
}
const exec = async (script, args = []) => (await cmd('WebDriver:ExecuteScript', { script, args })).value;

await helloP;
await cmd('WebDriver:NewSession', { capabilities: { alwaysMatch: { acceptInsecureCerts: false } } });
// Size the window so the content viewport is exactly W x H.
await cmd('WebDriver:SetWindowRect', { width: W + 400, height: H + 300 });
await cmd('WebDriver:Navigate', { url: 'about:blank' });
for (let i = 0; i < 4; i++) {
  const [iw, ih] = await exec('return [window.innerWidth, window.innerHeight];');
  const rect = await cmd('WebDriver:GetWindowRect');
  if (iw === W && ih === H) break;
  await cmd('WebDriver:SetWindowRect', { width: rect.width + (W - iw), height: rect.height + (H - ih) });
}
const [iw, ih] = await exec('return [window.innerWidth, window.innerHeight];');
console.log(`viewport ${iw}x${ih}; UA ${await exec('return navigator.userAgent;')}`);

await cmd('WebDriver:Navigate', { url: `file://${path.join(work, 'showcase.html')}` });
const t0 = Date.now();
const times = [];
let n = 0;
for (;;) {
  const shot = await cmd('WebDriver:TakeScreenshot', { full: false, hash: false });
  times.push(Date.now() - t0);
  fs.writeFileSync(path.join(frames, `f${String(n++).padStart(5, '0')}.png`), Buffer.from(shot.value, 'base64'));
  if (n % 8 === 0 && await exec('return window.__demoDone === true;')) break;
  if (Date.now() - t0 > 120_000) throw new Error('demo did not finish in 120 s');
  const err = n % 8 === 4 ? await exec("return document.getElementById('caption').textContent.startsWith('Demo error') ? document.getElementById('caption').textContent : '';") : '';
  if (err) throw new Error(err);
}
// Hold the final frame for a moment.
times.push(Date.now() - t0 + 1500);
stopBrowser();
sock.destroy();

// ---- encode -----------------------------------------------------------------------------
const list = [];
for (let i = 0; i < n; i++) {
  list.push(`file '${path.join(frames, `f${String(i).padStart(5, '0')}.png`)}'`);
  list.push(`duration ${((times[i + 1] - times[i]) / 1000).toFixed(3)}`);
}
list.push(`file '${path.join(frames, `f${String(n - 1).padStart(5, '0')}.png`)}'`);
fs.writeFileSync(path.join(work, 'frames.txt'), list.join('\n') + '\n');
const mp4 = path.join(out, 'preyt-showcase.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(work, 'frames.txt'),
  '-vf', `fps=30,scale=${W}:${H}:flags=lanczos,format=yuv420p`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-movflags', '+faststart',
  '-metadata', 'title=Preyt showcase (SIMULATED data)', '-metadata', 'comment=Rendered in headless Gecko from the real popup/controller code; videos, transcripts and model answers are invented.',
  mp4]);
// A poster frame from the summary state (~55% through).
fs.copyFileSync(path.join(frames, `f${String(Math.floor(n * 0.55)).padStart(5, '0')}.png`), path.join(out, 'preyt-showcase-poster.png'));
fs.rmSync(work, { recursive: true, force: true });
console.log(`${n} frames over ${(times.at(-1) / 1000).toFixed(1)} s -> ${path.relative(root, mp4)}`);
process.exit(0);
