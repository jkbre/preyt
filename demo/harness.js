// Showcase harness: runs the REAL JobController, view model and popup code from
// extension/ with SIMULATED transcript retrieval and SIMULATED Gemini answers.
// Nothing here talks to YouTube, Google or any model.
// Module sources are provided by build-demo.mjs as window.__PREYT_MODULES (blob URLs).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mods = window.__PREYT_MODULES;
const { JobController } = await import(mods['lib/controller.js']);
const { DEFAULT_SETTINGS } = await import(mods['lib/settings.js']);

// ---- simulated data (fictional videos, invented text) ---------------------------------
const VIDEOS = {
  Zx9Demo_v01: {
    meta: { title: 'Sourdough from scratch: a 20-minute walkthrough', channel: 'Demo Kitchen (fictional)', durationSec: 1214, description: '' },
    transcript: true,
    summary: 'A step-by-step sourdough walkthrough: build an active starter, mix and rest the dough, strengthen it with stretch-and-folds, then cold-proof overnight and bake hot in a covered pot for a crisp crust.',
    keypoints: [
      [42, 'Feed the starter 4–6 h ahead; it should double and smell mildly sour'],
      [186, 'Autolyse flour and water for 30 min before adding starter and salt'],
      [402, 'Four sets of stretch-and-folds, 30 min apart, build structure'],
      [655, 'Shape tightly and cold-proof 12–16 h for flavour and easier scoring'],
      [918, 'Bake at 250 °C covered for 20 min, then 20–25 min uncovered'],
      [1130, 'Cool at least an hour before slicing so the crumb sets'],
    ],
  },
  Qm4Demo_v02: {
    meta: { title: 'Live: city skyline timelapse (no narration)', channel: 'Example Streams (fictional)', durationSec: 3600,
      description: 'Four hours of skyline timelapse condensed into one. Chapters: sunset, blue hour, night traffic, sunrise. Shot on a rooftop with a fixed lens.' },
    transcript: false,
    summary: 'Based only on the title and description, this appears to be a narration-free skyline timelapse that condenses four hours of footage into one, moving from sunset through blue hour and night traffic to sunrise.',
    keypoints: [[0, 'Sunset'], [900, 'Blue hour'], [1800, 'Night traffic'], [2700, 'Sunrise']],
  },
};

// Thumbnails off: the fictional ids have no real thumbnails and the demo makes no network requests.
let settings = { ...DEFAULT_SETTINGS, apiKey: 'demo-key-not-real-000000', consentGiven: false, showThumbnails: false };
const controller = new JobController({
  getSettings: async () => settings,
  saveSettings: async (p) => { settings = { ...settings, ...p }; return settings; },
  getTranscript: async (videoId, { onStage }) => {
    onStage('tab');
    await sleep(1600);
    const v = VIDEOS[videoId];
    if (!v.transcript) return { status: 'none', method: 'tab', meta: v.meta, segments: [], chapters: [], captionKind: 'unknown', reason: 'no_captions', problems: ['tab: no_captions'] };
    return { status: 'ok', method: 'tab-api', meta: v.meta, segments: Array.from({ length: 312 }, (_, i) => ({ start: i * 4, text: 'simulated line' })), chapters: [], captionKind: 'manual', problems: [] };
  },
  createSummarizer: () => ({
    summarize: async (payload) => {
      await sleep(payload.source === 'metadata' ? 1800 : 2600);
      const v = VIDEOS[payload.videoId];
      return { source: payload.source, summary: v.summary, keypoints: v.keypoints.map(([start, text]) => ({ start, text })),
        model: settings.model, truncated: false, coverage: 1, elapsedMs: payload.source === 'metadata' ? 1800 : 2600 };
    },
  }),
  openUrl: () => {},
});

// ---- mock WebExtension API for the popup iframe ------------------------------------------
function mockBrowser() {
  const listeners = [];
  const port = {
    postMessage: (msg) => { if (msg?.type !== 'openOptions') controller.handle(msg); },
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onDisconnect: { addListener: () => {} },
  };
  const send = (snap) => listeners.forEach((fn) => fn({ type: 'state', snapshot: snap, settings: { ...settings, hasApiKey: true } }));
  controller.subscribe(send);
  return {
    runtime: { connect: () => { setTimeout(() => send(controller.snapshot()), 0); return port; } },
    tabs: { query: async () => [] },
  };
}

// ---- stage helpers -------------------------------------------------------------------------
const $ = (s) => document.querySelector(s);
const cursor = $('#cursor');
const caption = $('#caption');
const popup = $('#popup');
const menu = $('#menu');
let frameDoc = null;

function say(text) { caption.textContent = text; }
async function moveTo(el, dx = 0.5, dy = 0.5, ms = 700) {
  const r = el.getBoundingClientRect();
  cursor.style.transition = `transform ${ms}ms cubic-bezier(.4,.0,.2,1)`;
  cursor.style.transform = `translate(${r.left + r.width * dx}px, ${r.top + r.height * dy}px)`;
  await sleep(ms + 120);
}
async function click(el) {
  cursor.classList.add('down');
  await sleep(140);
  cursor.classList.remove('down');
  el.click();
}
async function contextMenuOn(link) {
  await moveTo(link, 0.35, 0.5);
  cursor.classList.add('down'); await sleep(120); cursor.classList.remove('down');
  const r = link.getBoundingClientRect();
  menu.style.left = `${r.left + r.width * 0.35 + 4}px`;
  menu.style.top = `${r.top + r.height * 0.5 + 4}px`;
  menu.hidden = false;
  await sleep(700);
  const item = menu.querySelector('.preyt');
  await moveTo(item, 0.3, 0.5, 450);
  item.classList.add('hover');
  await sleep(450);
  await click(item);
  item.classList.remove('hover');
  menu.hidden = true;
}
async function openPopup(videoId) {
  popup.hidden = false;
  $('#ext').classList.add('active');
  if (!frameDoc) {
    const iframe = popup.querySelector('iframe');
    window.__mockBrowser = mockBrowser(); // picked up by the popup document as window.browser
    iframe.srcdoc = window.__PREYT_POPUP_HTML;
    await new Promise((r) => { iframe.onload = r; });
    frameDoc = iframe.contentDocument;
  }
  await controller.request({ videoId, origin: { kind: 'link' } });
}
async function frameButton(text, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const b = [...frameDoc.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(text) && !x.hidden);
    if (b) return b;
    await sleep(100);
  }
  throw new Error(`button ${text} not found`);
}
async function moveToFrameEl(el, ms) {
  const fr = popup.querySelector('iframe').getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const fake = { getBoundingClientRect: () => ({ left: fr.left + r.left, top: fr.top + r.top, width: r.width, height: r.height }) };
  await moveTo(fake, 0.5, 0.5, ms);
}
async function waitState(predicate, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (predicate(controller.snapshot().current)) return; await sleep(80); }
}

// ---- scenario ------------------------------------------------------------------------------
window.__demoDone = false;
export async function run() {
  say('Right-click any YouTube link…');
  await sleep(900);
  await contextMenuOn($('#link1'));
  say('…and choose “Summarize YouTube video”. First use shows exactly what will be sent, and where.');
  await openPopup('Zx9Demo_v01');
  await sleep(2600);
  const send = await frameButton('Send & summarize');
  await moveToFrameEl(send, 650);
  await click(send);
  say('The transcript is read from a muted background tab, then summarized by Gemini with your own API key.');
  await waitState((j) => j?.status === 'done');
  say('Summary and timestamped key points. Each timestamp opens the video at that moment.');
  await sleep(1200);
  const chip = frameDoc.querySelectorAll('.chip')[2];
  await moveToFrameEl(chip, 700);
  chip.classList.add('hover');
  await sleep(2600);
  chip.classList.remove('hover');
  popup.hidden = true;
  $('#ext').classList.remove('active');
  say('No transcript? Preyt never passes metadata off as a video summary.');
  await sleep(800);
  await contextMenuOn($('#link2'));
  await openPopup('Qm4Demo_v02');
  await waitState((j) => j?.status === 'no-transcript');
  await sleep(1600);
  say('You choose: paste a transcript, or an explicitly labelled title/description-only summary.');
  const meta = await frameButton('Summarize title & description only');
  await moveToFrameEl(meta, 700);
  await sleep(500);
  await click(meta);
  await waitState((j) => j?.status === 'done');
  say('Metadata-only results carry a clear warning label.');
  await sleep(3800);
  window.__demoDone = true;
}
