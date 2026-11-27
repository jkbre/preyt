// Transcript strategies (mock tabs) and the real content script in a VM with fake page
// globals.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { fetchTranscriptFromOpenTab, fetchTranscriptViaTab, getTranscript, interpretTabResult, modeSnippet } from '../../extension/lib/transcript.js';
import { VIDEO_ID, YTCFG, initialData, panelResponse, playerResponse } from '../fixtures/youtube.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONTENT = fs.readFileSync(path.join(here, '../../extension/content/tab-transcript.js'), 'utf8');

const response = (body, { status = 200 } = {}) => ({
  ok: status >= 200 && status < 300, status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
});

// ---- content script in a sandbox -------------------------------------------------

function el(props = {}) { return { textContent: '', querySelector: () => null, ...props }; }

/**
 * Runs extension/content/tab-transcript.js with fake YouTube page globals.
 * Returns { result, video, fetches, clicks }.
 */
async function runContent({ mode = 'owned', videoId = VIDEO_ID, data = initialData(), player = playerResponse(), live = null, panelStatus = 200, panel = panelResponse(), withButton = false, url = `https://www.youtube.com/watch?v=${VIDEO_ID}`, snippet = true, onClick = null, playerVideoId = null } = {}) {
  const video = { muted: false, paused: false, pause() { this.paused = true; } };
  const fetches = [];
  const clicks = [];
  let rowsVisible = false;
  const rows = [el({ querySelector: (s) => (s.includes('Timestamp') ? el({ textContent: '0:07' }) : el({ textContent: 'scraped row' })) })];
  const loc = new URL(url);
  const location = { get pathname() { return loc.pathname; }, get search() { return loc.search; } };
  const button = { click() { clicks.push('transcript'); rowsVisible = true; onClick?.(loc); }, getAttribute: () => 'Show transcript' };
  const moviePlayer = playerVideoId ? { getVideoData: () => ({ video_id: playerVideoId }), getPlayerResponse: () => null } : null;
  const flexy = live ? { data: live } : null;
  const document = {
    querySelectorAll: (sel) => {
      if (sel === 'video') return [video];
      if (sel === 'transcript-segment-view-model') return rowsVisible ? rows : [];
      return [];
    },
    querySelector: (sel) => {
      if (sel === 'ytd-watch-flexy') return flexy;
      if (sel.startsWith('ytd-video-description-transcript-section-renderer')) return withButton ? button : null;
      return null;
    },
    getElementById: (id) => (id === 'movie_player' ? moviePlayer : null),
  };
  const ctx = {
    document, location, URLSearchParams, JSON, Date, Promise, String, Number, setTimeout, clearTimeout,
    ytInitialData: data, ytInitialPlayerResponse: player,
    ytcfg: { get: (k) => YTCFG[k] },
    content: { fetch: async (url, init) => { fetches.push({ url, init }); return response(panel, { status: panelStatus }); } },
    fetch: () => { throw new Error('content scripts must use content.fetch (page origin)'); },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  if (snippet) vm.runInContext(modeSnippet(mode, videoId), ctx);
  const result = await vm.runInContext(CONTENT, ctx);
  return { result: JSON.parse(JSON.stringify(result)), video, fetches, clicks, ctx };
}

test('content script (owned): pauses, calls get_panel as the page, returns raw panel JSON + metadata', async () => {
  const { result, video, fetches, clicks } = await runContent();
  assert.equal(video.paused, true);
  assert.equal(video.muted, true);
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, '/youtubei/v1/get_panel?prettyPrint=false');
  assert.equal(fetches[0].init.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(fetches[0].init.body), { context: YTCFG.INNERTUBE_CONTEXT, panelId: 'PAmodern_transcript_view', params: 'c3ludGhldGljLXBhcmFtcw==' });
  assert.deepEqual(clicks, []);
  assert.equal(result.captionKind, 'asr');
  assert.equal(result.meta.channel, 'Test Kitchen');
  const parsed = interpretTabResult(VIDEO_ID, result);
  assert.equal(parsed.method, 'tab-api');
  assert.equal(parsed.segments.length, 5);
});

test('content script (current tab): read-only, and refuses stale SPA data for another video', async () => {
  const ok = await runContent({ mode: 'current' });
  assert.equal(ok.video.paused, false, 'never pauses the user’s video');
  assert.equal(ok.video.muted, false);
  assert.ok(ok.result.panelJson);

  const stale = await runContent({ mode: 'current', data: initialData({ videoId: 'OtherVideo1' }), player: playerResponse({ videoId: 'OtherVideo1' }), withButton: true });
  assert.equal(stale.result.reason, 'stale_page');
  assert.equal(stale.fetches.length, 0, 'no request with another video’s params');
  assert.deepEqual(stale.clicks, [], 'never clicks in the user’s tab');
  assert.equal(stale.result.meta, null, 'no metadata from the wrong video');

  // Live watch-element data for the right video is accepted after SPA navigation.
  const spa = await runContent({ mode: 'current', data: initialData({ videoId: 'OtherVideo1' }), live: initialData() });
  assert.ok(spa.result.panelJson);

  const failing = await runContent({ mode: 'current', panelStatus: 403, withButton: true });
  assert.equal(failing.result.reason, 'panel_http_403');
  assert.deepEqual(failing.clicks, []);
});

test('content script (owned): falls back to opening the transcript panel in the DOM', async () => {
  const { result, clicks } = await runContent({ panelStatus: 403, withButton: true });
  assert.deepEqual(clicks, ['transcript']);
  const parsed = interpretTabResult(VIDEO_ID, result);
  assert.equal(parsed.method, 'tab-dom');
  assert.deepEqual(parsed.segments, [{ start: 7, text: 'scraped row' }]);
});

test('content script reports videos without captions', async () => {
  const { result } = await runContent({ player: playerResponse({ captions: false }), data: initialData({ panel: false }) });
  assert.equal(result.reason, 'no_captions');
  assert.equal(interpretTabResult(VIDEO_ID, result).status, 'none');
});

test('content script fails closed without options (navigation between the two injections)', async () => {
  const r = await runContent({ snippet: false, panelStatus: 403, withButton: true });
  assert.equal(r.result.reason, 'missing_options');
  assert.equal(r.result.videoId, '');
  assert.deepEqual(r.clicks, [], 'never defaults to owned mode and clicks');
  assert.equal(r.fetches.length, 0);
  assert.equal(r.video.paused, false, 'never pauses without options');
  assert.equal(interpretTabResult(VIDEO_ID, r.result).reason, 'missing_options');

  // Options are consumed: a second bare injection into the same document also fails closed.
  const first = await runContent({ mode: 'current' });
  assert.equal(first.ctx.__preyt, undefined);
  const again = await vm.runInContext(CONTENT, first.ctx);
  assert.equal(again.reason, 'missing_options');

  // Garbage options are refused too.
  for (const bad of [{ mode: 'owned' }, { mode: 'owned', videoId: 'x' }, { mode: 'root', videoId: VIDEO_ID }, 'owned']) {
    const ctx = first.ctx;
    ctx.__preyt = bad;
    assert.equal((await vm.runInContext(CONTENT, ctx)).reason, 'missing_options', JSON.stringify(bad));
  }
});

test('content script only acts on the requested video', async () => {
  // Tab already shows another video (URL): nothing fetched, nothing clicked, even when owned.
  const other = await runContent({ url: 'https://www.youtube.com/watch?v=OtherVideo1', panelStatus: 403, withButton: true });
  assert.equal(other.result.reason, 'video_mismatch');
  assert.deepEqual(other.clicks, []);
  assert.equal(other.fetches.length, 0);
  // URL says ours but the player disagrees.
  const playerOther = await runContent({ playerVideoId: 'OtherVideo1', panelStatus: 403, withButton: true });
  assert.equal(playerOther.result.reason, 'video_mismatch');
  assert.deepEqual(playerOther.clicks, []);
  // Shorts URLs count as the same video.
  const shorts = await runContent({ url: `https://www.youtube.com/shorts/${VIDEO_ID}` });
  assert.ok(shorts.result.panelJson);
  // Page navigates to another video after the click: the rows are discarded.
  const moved = await runContent({
    panelStatus: 403, withButton: true,
    onClick: (loc) => { loc.search = '?v=OtherVideo1'; },
  });
  assert.deepEqual(moved.clicks, ['transcript']);
  assert.deepEqual(moved.result.rows, []);
  assert.equal(moved.result.reason, 'video_mismatch');
  assert.equal(interpretTabResult(VIDEO_ID, moved.result).status, 'none');
});

test('interpretTabResult ignores results for another video', () => {
  const foreign = interpretTabResult(VIDEO_ID, { videoId: 'OtherVideo1', rows: [{ ts: '0:01', text: 'a' }], meta: { title: 'Wrong' }, panelJson: JSON.stringify(panelResponse()) });
  assert.equal(foreign.status, 'none');
  assert.equal(foreign.reason, 'video_mismatch');
  assert.equal(foreign.meta.title, '');
  assert.deepEqual(foreign.segments, []);
  assert.equal(interpretTabResult(VIDEO_ID, { rows: [{ ts: '0:01', text: 'a' }] }).reason, 'video_mismatch', 'missing videoId is not trusted');
});

test('modeSnippet only accepts known modes and real video ids', () => {
  assert.equal(modeSnippet('owned', VIDEO_ID), `window.__preyt = {"mode":"owned","videoId":"${VIDEO_ID}"};`);
  assert.throws(() => modeSnippet('owned', 'x"};alert(1);//'));
  assert.throws(() => modeSnippet('evil', VIDEO_ID));
});

// ---- tab orchestration -----------------------------------------------------------

function mockTabs({ complete = true, script = async () => [{ videoId: VIDEO_ID, panelJson: JSON.stringify(panelResponse()) }] } = {}) {
  const log = [];
  const listeners = new Set();
  const tabs = {
    create: async (o) => { log.push(['create', o]); setTimeout(() => complete && listeners.forEach((l) => l(7, { status: 'complete' }, { id: 7 })), 5); return { id: 7 }; },
    update: async (id, o) => { log.push(['update', id, o]); },
    get: async () => ({ id: 7, status: 'loading' }),
    executeScript: async (id, o) => { log.push(['exec', id, o.code ? 'code' : o.file]); return o.code ? [undefined] : script(); },
    remove: async (id) => { log.push(['remove', id]); },
    onUpdated: { addListener: (l) => listeners.add(l), removeListener: (l) => listeners.delete(l) },
  };
  return { tabs, log };
}

test('owned tab: inactive, muted, mode snippet then script, always removed', async () => {
  const { tabs, log } = mockTabs();
  const r = await fetchTranscriptViaTab(VIDEO_ID, { tabs, windowId: 3 });
  assert.equal(r.status, 'ok');
  assert.equal(r.method, 'tab-api');
  assert.deepEqual(log[0], ['create', { url: `https://www.youtube.com/watch?v=${VIDEO_ID}`, active: false, windowId: 3 }]);
  assert.deepEqual(log[1], ['update', 7, { muted: true }]);
  assert.deepEqual(log.filter((l) => l[0] === 'exec').map((l) => l[2]), ['code', '/content/tab-transcript.js']);
  assert.equal(log.at(-1)[0], 'remove');
});

test('owned tab: cleanup also on script failure, load timeout and cancel', async () => {
  const failing = mockTabs({ script: async () => { throw new Error('script blew up'); } });
  await assert.rejects(fetchTranscriptViaTab(VIDEO_ID, { tabs: failing.tabs }), /blew up/);
  assert.equal(failing.log.at(-1)[0], 'remove');

  const stuck = mockTabs({ complete: false });
  await assert.rejects(fetchTranscriptViaTab(VIDEO_ID, { tabs: stuck.tabs, timeoutMs: 50 }), { code: 'tab_timeout' });
  assert.equal(stuck.log.at(-1)[0], 'remove');

  const slow = mockTabs({ script: () => new Promise(() => {}) });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(fetchTranscriptViaTab(VIDEO_ID, { tabs: slow.tabs, signal: ac.signal }), { code: 'cancelled' });
  assert.equal(slow.log.at(-1)[0], 'remove');
});

test('open tab: uses the user’s tab without creating or closing tabs', async () => {
  const { tabs, log } = mockTabs();
  const r = await fetchTranscriptFromOpenTab(VIDEO_ID, { tabs, tabId: 42 });
  assert.equal(r.method, 'page-api');
  assert.ok(!log.some((l) => l[0] === 'create' || l[0] === 'remove' || l[0] === 'update'));
  assert.ok(log.every((l) => l[0] !== 'exec' || l[1] === 42));
});

test('interpretTabResult: DOM rows fallback and empty results', () => {
  const dom = interpretTabResult(VIDEO_ID, { videoId: VIDEO_ID, rows: [{ ts: '0:01', text: 'a' }], meta: { title: 'X' }, captionKind: 'manual' });
  assert.equal(dom.method, 'tab-dom');
  assert.equal(dom.captionKind, 'manual');
  assert.equal(dom.meta.title, 'X');
  const empty = interpretTabResult(VIDEO_ID, { videoId: VIDEO_ID, rows: [], reason: 'no_transcript_button' });
  assert.equal(empty.status, 'none');
  assert.equal(empty.reason, 'no_transcript_button');
  assert.throws(() => interpretTabResult(VIDEO_ID, undefined), { code: 'tab_script' });
});

test('getTranscript strategy chain', async () => {
  const ok = { status: 'ok', method: 'x', meta: {}, segments: [{ start: 0, text: 'a' }], chapters: [] };
  const none = (reason) => ({ status: 'none', method: 'x', meta: {}, segments: [], chapters: [], reason });
  const stages = [];
  let r = await getTranscript(VIDEO_ID, { fromPage: async () => none('stale_page'), viaTab: async () => ok, onStage: (s) => stages.push(s) });
  assert.equal(r.status, 'ok');
  assert.deepEqual(stages, ['page', 'tab']);
  assert.deepEqual(r.problems, ['page: stale_page']);
  r = await getTranscript(VIDEO_ID, { fromPage: async () => { throw Object.assign(new Error('gone'), { code: 'tab_script' }); }, viaTab: async () => ok });
  assert.equal(r.status, 'ok');
  let tabCalled = false;
  r = await getTranscript(VIDEO_ID, { fromPage: async () => none('no_captions'), viaTab: async () => { tabCalled = true; return ok; } });
  assert.equal(r.status, 'none');
  assert.equal(tabCalled, false, 'no captions at all -> do not open a tab');
  stages.length = 0;
  r = await getTranscript(VIDEO_ID, { viaTab: async () => ok, onStage: (s) => stages.push(s) });
  assert.deepEqual(stages, ['tab'], 'link clicks go straight to an owned tab');
  r = await getTranscript(VIDEO_ID, { viaTab: async () => { throw Object.assign(new Error('boom'), { code: 'tab_timeout' }); } });
  assert.equal(r.status, 'none');
  assert.match(r.problems[0], /tab_timeout/);
  await assert.rejects(getTranscript(VIDEO_ID, { viaTab: async () => { throw Object.assign(new Error('x'), { code: 'cancelled' }); } }), { code: 'cancelled' });
});
