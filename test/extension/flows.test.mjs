// UI message flows: background controller state machine + popup view model.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SummaryError, createGeminiClient } from '../../extension/lib/gemini.js';
import { JobController, S } from '../../extension/lib/controller.js';
import { DEFAULT_SETTINGS } from '../../extension/lib/settings.js';
import { viewModel } from '../../extension/lib/view-model.js';

const VID = 'Zx9Demo_v01';
const META = { title: 'Synthetic Bread', channel: 'Test Kitchen', durationSec: 300, description: 'We bake.', chapters: [] };
const okTranscript = { status: 'ok', method: 'tab-api', meta: META, segments: [{ start: 0, text: 'a' }, { start: 60, text: 'b' }], chapters: [{ start: 0, title: 'Intro' }], captionKind: 'asr', problems: [] };
const noTranscript = { status: 'none', method: 'tab', meta: META, segments: [], chapters: [], captionKind: 'unknown', reason: 'no_captions', problems: ['tab: no_captions'] };
const summary = (source) => ({ source, summary: 'S.', keypoints: [{ start: 60, text: 'k' }], model: 'gemini-3.5-flash-lite', truncated: false, coverage: 1, elapsedMs: 4200 });
const KEY = 'test-key-not-real-0123456789abcdef';

function harness({ settings = {}, transcript = okTranscript, provider } = {}) {
  let s = { ...DEFAULT_SETTINGS, apiKey: KEY, ...settings };
  const payloads = [];
  const opened = [];
  const snaps = [];
  const c = new JobController({
    getSettings: async () => s,
    saveSettings: async (p) => { s = { ...s, ...p }; return s; },
    getTranscript: async (id, { onStage }) => { onStage('tab'); return typeof transcript === 'function' ? transcript() : transcript; },
    createSummarizer: () => ({ summarize: async (p, o) => { payloads.push(p); return provider ? provider(p, o) : summary(p.source); } }),
    openUrl: (url, tabId) => opened.push([url, tabId]),
  });
  c.subscribe((snap) => snaps.push(snap));
  const settle = () => new Promise((r) => setTimeout(r, 10));
  return { c, payloads, opened, snaps, settle, settings: () => s };
}

test('first use: consent is required before anything is sent; remembered consent skips it next time', async () => {
  const h = harness({ settings: { consentGiven: false } });
  const job = await h.c.request({ videoId: VID, origin: { kind: 'page', tabId: 9 } });
  assert.equal(job.status, S.CONSENT);
  assert.equal(h.payloads.length, 0);
  const vm = viewModel(h.c.snapshot(), h.settings());
  assert.equal(vm.state, 'consent');
  assert.ok(vm.consent.items.some((t) => /Gemini API \(generativelanguage\.googleapis\.com\)/.test(t)));
  assert.ok(vm.consent.items.some((t) => /free-tier key, Google may use/.test(t)));
  assert.ok(vm.consent.items.some((t) => /gemini-3\.5-flash-lite/.test(t)));

  await h.c.handle({ type: 'consent', jobId: job.id, allow: true, remember: true });
  await h.settle();
  assert.equal(h.c.get(job.id).status, S.DONE);
  assert.equal(h.settings().consentGiven, true);
  // Observed sequence of states
  const states = h.snaps.map((x) => x.current?.status).filter((v, i, a) => v !== a[i - 1]);
  assert.deepEqual(states, [S.CONSENT, S.TRANSCRIPT, S.SUMMARIZING, S.DONE]);

  const second = await h.c.request({ videoId: 'abcdefghijk' });
  await h.settle();
  assert.equal(h.c.get(second.id).status, S.DONE, 'no second prompt');
});

test('declining consent cancels and sends nothing', async () => {
  const h = harness({ settings: { consentGiven: false } });
  const job = await h.c.request({ videoId: VID });
  await h.c.handle({ type: 'consent', jobId: job.id, allow: false });
  assert.equal(h.c.get(job.id).status, S.CANCELLED);
  assert.equal(h.payloads.length, 0);
  assert.equal(viewModel(h.c.snapshot()).state, 'cancelled');
});

test('happy path payload and done view: transcript badge, clickable timestamps, open at time', async () => {
  const h = harness({ settings: { consentGiven: true } });
  const job = await h.c.request({ videoId: VID, origin: { kind: 'page', tabId: 9 } });
  await h.settle();
  const p = h.payloads[0];
  assert.equal(p.source, 'transcript');
  assert.equal(p.segments.length, 2);
  assert.equal(p.captionKind, 'asr');
  assert.deepEqual(p.chapters, [{ start: 0, title: 'Intro' }]);
  assert.equal(p.description, undefined, 'description is not sent in transcript mode');
  const vm = viewModel(h.c.snapshot(), h.settings());
  assert.equal(vm.state, 'done');
  assert.equal(vm.result.badge.kind, 'transcript');
  assert.match(vm.result.badge.label, /auto-generated captions/);
  assert.equal(vm.result.badge.warning, null);
  assert.deepEqual(vm.result.keypoints, [{ seconds: 60, time: '1:00', text: 'k' }]);
  assert.match(vm.result.footer, /gemini-3\.5-flash-lite · 4\.2 s · via Gemini API/);
  await h.c.handle({ type: 'openAt', jobId: job.id, seconds: 60 });
  assert.deepEqual(h.opened[0], [`https://www.youtube.com/watch?v=${VID}&t=60s`, 9]);
  // Same video again re-shows the finished job instead of paying for another request.
  await h.c.request({ videoId: VID });
  assert.equal(h.payloads.length, 1);
  // Popup snapshots never carry the transcript text.
  assert.ok(!JSON.stringify(h.c.snapshot()).includes('"segments":['));
});

test('no transcript: never auto-falls back; metadata is opt-in and clearly labelled', async () => {
  const h = harness({ settings: { consentGiven: true }, transcript: noTranscript });
  const job = await h.c.request({ videoId: VID });
  await h.settle();
  assert.equal(h.c.get(job.id).status, S.NO_TRANSCRIPT);
  assert.equal(h.payloads.length, 0, 'nothing sent without an explicit choice');
  let vm = viewModel(h.c.snapshot());
  assert.equal(vm.state, 'no-transcript');
  assert.match(vm.noTranscript.message, /no captions/);
  assert.equal(vm.noTranscript.canMetadata, true);
  assert.match(vm.noTranscript.metadataHint, /not a video summary/);

  await h.c.handle({ type: 'metadata', jobId: job.id });
  await h.settle();
  assert.equal(h.payloads[0].source, 'metadata');
  assert.equal(h.payloads[0].description, 'We bake.');
  assert.equal(h.payloads[0].segments, undefined);
  vm = viewModel(h.c.snapshot());
  assert.equal(vm.state, 'done');
  assert.equal(vm.result.badge.kind, 'metadata');
  assert.match(vm.result.badge.warning, /not a summary of what is said/);
});

test('no transcript: pasted transcript gives a real (pasted-labelled) summary; empty paste errors', async () => {
  const h = harness({ settings: { consentGiven: true }, transcript: noTranscript });
  const job = await h.c.request({ videoId: VID });
  await h.settle();
  await h.c.handle({ type: 'paste', jobId: job.id, text: '   ' });
  assert.equal(h.c.get(job.id).status, S.ERROR);
  await h.c.handle({ type: 'paste', jobId: job.id, text: '0:00\nHello\n1:00\nWorld' });
  await h.settle();
  assert.equal(h.payloads[0].source, 'pasted');
  assert.deepEqual(h.payloads[0].segments, [{ start: 0, text: 'Hello' }, { start: 60, text: 'World' }]);
  assert.equal(viewModel(h.c.snapshot()).result.badge.kind, 'pasted');
});

test('ask-every-time setting re-prompts for metadata/paste/retry too', async () => {
  const h = harness({ settings: { consentGiven: true, askBeforeSending: true }, transcript: noTranscript });
  const job = await h.c.request({ videoId: VID });
  assert.equal(job.status, S.CONSENT);
  await h.c.handle({ type: 'consent', jobId: job.id, allow: true, remember: false });
  await h.settle();
  assert.equal(h.c.get(job.id).status, S.NO_TRANSCRIPT);
  await h.c.handle({ type: 'metadata', jobId: job.id });
  assert.equal(h.c.get(job.id).status, S.CONSENT);
  assert.equal(h.payloads.length, 0);
});

test('provider failures surface as actionable errors and retry works', async () => {
  let fail = true;
  const h = harness({
    settings: { consentGiven: true },
    provider: (p) => { if (fail) throw new SummaryError('rate_limited', 'Gemini’s rate limit or your daily free quota is reached.', { retryAfterMs: 37_000 }); return summary(p.source); },
  });
  const job = await h.c.request({ videoId: VID });
  await h.settle();
  let vm = viewModel(h.c.snapshot());
  assert.equal(vm.state, 'error');
  assert.equal(vm.error.title, 'Gemini limit reached');
  assert.match(vm.error.message, /Try again in about 1 min/);
  assert.match(vm.error.message, /pick a different model in Options/);
  assert.equal(vm.error.retryable, true);
  assert.equal(vm.error.needsOptions, false);
  fail = false;
  await h.c.handle({ type: 'retry', jobId: job.id });
  await h.settle();
  assert.equal(h.c.get(job.id).status, S.DONE);

  const hNoWait = harness({ settings: { consentGiven: true }, provider: () => { throw new SummaryError('rate_limited', 'limit'); } });
  await hNoWait.c.request({ videoId: VID });
  await hNoWait.settle();
  assert.match(viewModel(hNoWait.c.snapshot()).error.message, /Wait a minute, then press Try again/);

  const hZero = harness({ settings: { consentGiven: true }, provider: () => { throw new SummaryError('rate_limited', 'limit', { detail: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0' }); } });
  await hZero.c.request({ videoId: VID });
  await hZero.settle();
  assert.match(viewModel(hZero.c.snapshot()).error.message, /no free quota for this model/);

  const h2 = harness({ settings: { consentGiven: true }, provider: () => { throw new SummaryError('invalid_api_key', 'bad key'); } });
  await h2.c.request({ videoId: VID });
  await h2.settle();
  vm = viewModel(h2.c.snapshot());
  assert.equal(vm.error.needsOptions, true);
  assert.equal(vm.error.retryable, false);

  assert.equal(vm.error.title, 'API key rejected');

  const h3 = harness({ settings: { consentGiven: true }, provider: () => { throw new SummaryError('network_error', 'Cannot reach the Gemini API.'); } });
  await h3.c.request({ videoId: VID });
  await h3.settle();
  assert.equal(viewModel(h3.c.snapshot()).error.title, 'Cannot reach Gemini');

  const h4 = harness({ settings: { consentGiven: true }, transcript: () => { throw new Error('YouTube exploded'); } });
  await h4.c.request({ videoId: VID });
  await h4.settle();
  assert.match(viewModel(h4.c.snapshot()).error.message, /YouTube exploded/);
});

test('cancel during summarizing aborts the request and ignores the late answer', async () => {
  let release;
  const h = harness({
    settings: { consentGiven: true },
    provider: (p, { signal }) => new Promise((resolve, reject) => {
      release = () => resolve(summary(p.source));
      signal.addEventListener('abort', () => reject(new SummaryError('cancelled', 'Cancelled')));
    }),
  });
  const job = await h.c.request({ videoId: VID });
  await h.settle();
  assert.equal(h.c.get(job.id).status, S.SUMMARIZING);
  assert.equal(viewModel(h.c.snapshot()).state, 'loading');
  await h.c.handle({ type: 'cancel', jobId: job.id });
  await h.settle();
  assert.equal(h.c.get(job.id).status, S.CANCELLED);
  release?.();
  await h.settle();
  assert.equal(h.c.get(job.id).status, S.CANCELLED);
});

function deferredSettingsHarness(settings = {}) {
  let s = { ...DEFAULT_SETTINGS, apiKey: KEY, consentGiven: true, ...settings };
  const waiting = [];
  let hold = false;
  const fetches = [];
  const c = new JobController({
    getSettings: () => (hold ? new Promise((r) => waiting.push(() => r(s))) : Promise.resolve(s)),
    saveSettings: async (p) => { s = { ...s, ...p }; return s; },
    getTranscript: async () => okTranscript,
    // Real Gemini client with a recording fetch: proves no HTTP request is made.
    createSummarizer: (st) => createGeminiClient({ apiKey: st.apiKey, model: st.model, fetchFn: async (u, init) => { fetches.push({ u, aborted: init.signal.aborted }); return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"summary":"S.","keypoints":[]}' }] } }] }) }; } }),
  });
  return {
    c, fetches,
    holdSettings: (v) => { hold = v; },
    releaseSettings: () => { while (waiting.length) waiting.shift()(); },
    settle: () => new Promise((r) => setTimeout(r, 10)),
  };
}

test('cancel while settings are loading never sends a request', async () => {
  // 1) Cancel while request() waits for settings.
  const h = deferredSettingsHarness();
  h.holdSettings(true);
  const pending = h.c.request({ videoId: VID });
  const jobId = h.c.snapshot().current.id;
  await h.c.handle({ type: 'cancel', jobId });
  h.holdSettings(false);
  h.releaseSettings();
  const job = await pending;
  await h.settle();
  assert.equal(h.c.get(job.id).status, S.CANCELLED);
  assert.equal(h.fetches.length, 0);

  // 2) Cancel while the run itself waits for settings (consent given in the popup).
  const h2 = deferredSettingsHarness({ consentGiven: false });
  const j2 = await h2.c.request({ videoId: VID });
  assert.equal(j2.status, S.CONSENT);
  h2.holdSettings(true);
  await h2.c.handle({ type: 'consent', jobId: j2.id, allow: true });
  await h2.c.handle({ type: 'cancel', jobId: j2.id });
  h2.holdSettings(false);
  h2.releaseSettings();
  await h2.settle();
  assert.equal(h2.c.get(j2.id).status, S.CANCELLED);
  assert.equal(h2.fetches.length, 0);

  // 3) Metadata-only run (no transcript step) cancelled while its settings load.
  const h3 = deferredSettingsHarness();
  const j3 = await h3.c.request({ videoId: 'abcdefghijk' });
  await h3.settle();
  assert.equal(h3.c.get(j3.id).status, S.DONE);
  assert.equal(h3.fetches.length, 1, 'control: an uncancelled run does fetch');
  h3.c.get(j3.id).status = S.NO_TRANSCRIPT;
  h3.holdSettings(true);
  const gate = h3.c.handle({ type: 'metadata', jobId: j3.id });
  await h3.c.handle({ type: 'cancel', jobId: j3.id });
  h3.holdSettings(false);
  h3.releaseSettings();
  await gate;
  await h3.settle();
  assert.equal(h3.fetches.length, 1, 'no second request after cancel');
});

test('view model: loading steps, empty state with recent list, thumbnails toggle, invalid ids rejected', async () => {
  assert.equal(viewModel(null).state, 'empty');
  const h = harness({ settings: { consentGiven: true } });
  await h.c.request({ videoId: VID });
  await h.settle();
  await h.c.request({ videoId: 'abcdefghijk' });
  await h.settle();
  const vm = viewModel(h.c.snapshot(), { showThumbnails: false });
  assert.equal(vm.header.thumbnail, '');
  assert.equal(vm.recent.length, 1);
  const loading = viewModel({ current: { id: 'j', videoId: VID, url: 'u', status: S.TRANSCRIPT, stage: 'tab', meta: {} } });
  assert.match(loading.loading.label, /muted background tab/);
  assert.deepEqual(loading.loading.steps.map((s) => s.state), ['active', 'pending']);
  await assert.rejects(h.c.request({ videoId: '"><img>' }));
});

test('loading view labels the first step by source and times from the actual start', async () => {
  let release;
  const h = harness({ settings: { consentGiven: true }, transcript: noTranscript, provider: (p) => new Promise((r) => { release = () => r(summary(p.source)); }) });
  const job = await h.c.request({ videoId: VID });
  await h.settle();
  await h.c.handle({ type: 'metadata', jobId: job.id });
  await h.settle();
  const vm = viewModel(h.c.snapshot());
  assert.equal(vm.state, 'loading');
  assert.deepEqual(vm.loading.steps.map((s) => s.label), ['Title & description', 'Summary']);
  assert.ok(vm.startedAt >= h.c.get(job.id).createdAt);
  release();
  await h.settle();
});
