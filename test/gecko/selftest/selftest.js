// Runs inside the real extension (moz-extension:// page) in Firefox/Zen.
// Not shipped: run-gecko-selftest.mjs copies it into a staged extension.
import { createGeminiClient } from '../lib/gemini.js';
import { fetchTranscriptFromOpenTab, fetchTranscriptViaTab } from '../lib/transcript.js';

const q = new URLSearchParams(location.search);
const videoId = q.get('v');
const report = q.get('report');
const out = { ua: navigator.userAgent, videoId, steps: {} };
const time = async (name, fn) => {
  const t0 = performance.now();
  try { out.steps[name] = { ok: true, ...(await fn()) }; } catch (e) { out.steps[name] = { ok: false, code: e.code, error: String(e.message ?? e) }; }
  out.steps[name].ms = Math.round(performance.now() - t0);
};

// Simulates "Summarize this video" on a page the user already has open (read-only path).
await time('openTab', async () => {
  const userTab = await browser.tabs.create({ url: `https://www.youtube.com/watch?v=${videoId}`, active: false });
  await new Promise((resolve) => {
    const l = (id, info) => { if (id === userTab.id && info.status === 'complete') { browser.tabs.onUpdated.removeListener(l); resolve(); } };
    browser.tabs.onUpdated.addListener(l);
  });
  try {
    const r = await fetchTranscriptFromOpenTab(videoId, { tabs: browser.tabs, tabId: userTab.id });
    const [paused] = await browser.tabs.executeScript(userTab.id, { code: 'document.querySelector("video") ? String(document.querySelector("video").paused) : "no-video"' });
    const stillOpen = (await browser.tabs.query({})).some((t) => t.id === userTab.id);
    return { status: r.status, method: r.method, segments: r.segments.length, reason: r.reason, userTabStillOpen: stillOpen, videoPausedState: paused };
  } finally {
    await browser.tabs.remove(userTab.id);
  }
});

let realSegments = null;
await time('tab', async () => {
  const before = (await browser.tabs.query({})).length;
  let tabId;
  const r = await fetchTranscriptViaTab(videoId, { tabs: browser.tabs, onTab: (id) => { tabId = id; } });
  if (r.status === 'ok' && r.segments.length) realSegments = r.segments.slice(0, 400);
  const after = await browser.tabs.query({});
  return { status: r.status, method: r.method, segments: r.segments.length, first: r.segments[0], reason: r.reason,
    tabsBefore: before, tabsAfter: after.length, ownedTabStillOpen: after.some((t) => t.id === tabId) };
});

await time('gemini', async () => {
  const { apiKey, model } = await (await fetch('key.json')).json();
  if (!apiKey) return { skipped: true };
  const c = createGeminiClient({ apiKey, ...(model ? { model } : {}) });
  const models = (await c.listModels()).map((m) => m.id);
  try {
    // Summarize the transcript the owned tab really fetched (synthetic line only if that failed;
    // the verdict fails the run in that case anyway).
    const segments = realSegments ?? [{ start: 0, text: 'Self-test transcript line.' }];
    const res = await c.summarize({ videoId, title: 'selftest', source: 'transcript', segments });
    return {
      models: models.length, segmentsSent: segments.length, realTranscript: Boolean(realSegments),
      summarize: { ok: true, model: res.model, summary: res.summary, keypoints: res.keypoints.length, elapsedMs: res.elapsedMs },
    };
  } catch (e) {
    return {
      models: models.length, segmentsSent: realSegments?.length ?? 1, realTranscript: Boolean(realSegments),
      summarize: { ok: false, code: e.code, message: String(e.detail ?? e.message ?? '').slice(0, 200), retryAfterMs: e.retryAfterMs },
    };
  }
});

await time('backgroundPage', async () => {
  const bg = await browser.runtime.getBackgroundPage();
  return { loaded: Boolean(bg && bg.document), url: bg?.location?.pathname };
});

document.body.textContent = JSON.stringify(out, null, 2);
await fetch(report, { method: 'POST', mode: 'no-cors', body: JSON.stringify(out) });
