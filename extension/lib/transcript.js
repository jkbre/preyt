// Transcript retrieval strategies, both executed *inside* a YouTube page so the
// request carries the page's own origin:
//  1. page: when the user right-clicked the video page they are watching, ask that tab
//     (read-only: no clicks, no pausing, and only if the page still shows that video).
//  2. tab:  open an inactive tab we own, mute it, run content/tab-transcript.js
//     (in-page get_panel first, then the transcript panel DOM), and always close it.
//
// Why not fetch from the background page? Verified 2026-11-19 in Zen 1.24.3b (Gecko 160):
// YouTube answers /youtubei/v1/get_panel with HTTP 403 when the request carries
// `Origin: moz-extension://…`, which every extension-page POST does. Removing that header
// would need webRequestBlocking over youtube.com, which this add-on avoids on purpose.
import { parsePanelResponse, rowsToSegments } from './innertube.js';
import { VIDEO_ID_RE, watchUrl } from './youtube-url.js';

export class TranscriptError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const SCRIPT_FILE = '/content/tab-transcript.js';

function emptyMeta(videoId) {
  return { videoId, title: '', channel: '', durationSec: null, description: '', chapters: [] };
}

/**
 * Options for the content script, injected as a tiny code snippet before the file.
 * The two executeScript calls are not atomic (the tab may navigate in between), so the
 * content script consumes the options and fails closed when they are missing, echoes the
 * requested videoId back, and interpretTabResult rejects results for any other video.
 */
export function modeSnippet(mode, videoId) {
  if (!['owned', 'current'].includes(mode) || !VIDEO_ID_RE.test(videoId)) throw new Error('bad mode');
  return `window.__preyt = ${JSON.stringify({ mode, videoId })};`;
}

async function inject(tabs, tabId, mode, videoId) {
  await tabs.executeScript(tabId, { code: modeSnippet(mode, videoId), runAt: 'document_idle' });
  const [result] = await tabs.executeScript(tabId, { file: SCRIPT_FILE, runAt: 'document_idle' });
  return result;
}

function waitForTabComplete(tabs, tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer;
    const listener = (id, info, tab) => {
      if (id !== tabId) return;
      if (tab?.url && /^https:\/\/consent\./.test(tab.url)) { cleanup(); reject(new TranscriptError('consent', 'YouTube asked for cookie consent; open YouTube once and answer the consent dialog')); return; }
      if (info.status === 'complete') { cleanup(); resolve(tab); }
    };
    const cleanup = () => { clearTimeout(timer); tabs.onUpdated.removeListener(listener); };
    timer = setTimeout(() => { cleanup(); reject(new TranscriptError('tab_timeout', 'YouTube tab did not finish loading')); }, timeoutMs);
    tabs.onUpdated.addListener(listener);
    // It may already be complete by the time we subscribe.
    tabs.get(tabId).then((t) => { if (t.status === 'complete') { cleanup(); resolve(t); } }, () => {});
  });
}

function raceAbort(promise, signal, timeoutMs, timeoutMsg) {
  let abortListener;
  let timer;
  const aborted = new Promise((_, reject) => {
    abortListener = () => reject(new TranscriptError('cancelled', 'Cancelled'));
    if (signal?.aborted) abortListener();
    signal?.addEventListener('abort', abortListener, { once: true });
  });
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TranscriptError('tab_timeout', timeoutMsg)), timeoutMs);
  });
  return Promise.race([promise, aborted, timeout]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', abortListener);
  });
}

/** Read-only retrieval from the tab the user is already watching. */
export async function fetchTranscriptFromOpenTab(videoId, { tabs, tabId, signal, timeoutMs = 15_000 }) {
  const result = await raceAbort(inject(tabs, tabId, 'current', videoId), signal, timeoutMs, 'The open YouTube tab did not answer');
  return interpretTabResult(videoId, result, 'page');
}

/**
 * Owned-tab strategy. The tab is created inactive, muted immediately and removed in
 * `finally`, also on timeout/cancel. `tabs` is browser.tabs (injectable for tests).
 */
export async function fetchTranscriptViaTab(videoId, { tabs, windowId, timeoutMs = 30_000, signal, onTab } = {}) {
  const tab = await tabs.create({ url: watchUrl(videoId), active: false, ...(windowId !== undefined ? { windowId } : {}) });
  onTab?.(tab.id);
  try {
    await tabs.update(tab.id, { muted: true }).catch(() => {});
    const work = (async () => {
      await waitForTabComplete(tabs, tab.id, timeoutMs);
      return inject(tabs, tab.id, 'owned', videoId);
    })();
    const result = await raceAbort(work, signal, timeoutMs + 15_000, 'Transcript retrieval in the background tab timed out');
    return interpretTabResult(videoId, result, 'tab');
  } finally {
    await tabs.remove(tab.id).catch(() => {});
  }
}

/** Turn the content-script result object into the common transcript shape. */
export function interpretTabResult(videoId, result, prefix = 'tab') {
  if (!result || typeof result !== 'object') throw new TranscriptError('tab_script', 'The YouTube tab script returned nothing');
  if (result.videoId !== videoId) {
    // Options lost (navigation between injections) or a result for another video: use nothing from it.
    const reason = result.reason === 'missing_options' ? 'missing_options' : 'video_mismatch';
    return { status: 'none', method: prefix, meta: emptyMeta(videoId), segments: [], chapters: [], captionKind: 'unknown', reason };
  }
  const meta = { ...emptyMeta(videoId), ...(result.meta && typeof result.meta === 'object' ? result.meta : {}), videoId };
  let segments = [];
  let chapters = [];
  let method = prefix;
  if (typeof result.panelJson === 'string' && result.panelJson) {
    try {
      ({ segments, chapters } = parsePanelResponse(JSON.parse(result.panelJson)));
      method = `${prefix}-api`;
    } catch { /* fall through to DOM rows */ }
  }
  if (!segments.length && Array.isArray(result.rows) && result.rows.length) {
    segments = rowsToSegments(result.rows);
    method = `${prefix}-dom`;
  }
  if (!chapters.length && Array.isArray(result.chapters)) chapters = result.chapters.filter((c) => c && typeof c.title === 'string');
  return {
    status: segments.length ? 'ok' : 'none',
    method,
    meta,
    segments,
    chapters,
    captionKind: ['asr', 'manual'].includes(result.captionKind) ? result.captionKind : 'unknown',
    reason: segments.length ? undefined : String(result.reason || 'not_found'),
  };
}

/**
 * Strategy chain. `fromPage` is only provided when the click came from the video page
 * itself. Problems from each attempt are kept so the UI can explain a failure.
 */
export async function getTranscript(videoId, { fromPage, viaTab, onStage }) {
  const order = fromPage ? ['page', 'tab'] : ['tab'];
  const problems = [];
  let lastNone = null;
  for (const m of order) {
    onStage?.(m);
    try {
      const r = m === 'page' ? await fromPage(videoId) : await viaTab(videoId);
      if (r.status === 'ok') return { ...r, problems };
      lastNone = r;
      problems.push(`${m}: ${r.reason}`);
      if (r.reason === 'no_captions') break; // YouTube lists no captions at all; another tab will not find any either
    } catch (e) {
      if (e?.code === 'cancelled' || e?.name === 'AbortError') throw e;
      problems.push(`${m}: ${e?.code ?? 'error'} ${e?.message ?? e}`);
    }
  }
  return { ...(lastNone ?? { status: 'none', method: order.at(-1), meta: emptyMeta(videoId), segments: [], chapters: [], captionKind: 'unknown', reason: 'failed' }), problems };
}
