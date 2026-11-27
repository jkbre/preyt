// URL parsing, YouTube page/panel parsing, pasted transcripts, settings.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseVideoId, parseStartTime, watchUrl, LINK_PATTERNS } from '../../extension/lib/youtube-url.js';
import { parseClock, parsePanelResponse, rowsToSegments } from '../../extension/lib/innertube.js';
import { formatClock, formatDuration, parsePastedTranscript, summaryToMarkdown } from '../../extension/lib/format.js';
import { DEFAULT_SETTINGS, needsConsent, sanitizeSettings } from '../../extension/lib/settings.js';
import { VIDEO_ID, panelResponse } from '../fixtures/youtube.mjs';

test('parseVideoId: every supported link shape', () => {
  const id = 'dQw4w9WgXcQ';
  const ok = [
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?feature=share&v=${id}&t=42`,
    `http://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}&list=RD`,
    `https://youtu.be/${id}?si=abc`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}?feature=share`,
    `https://www.youtube.com/embed/${id}?start=10`,
    `https://www.youtube-nocookie.com/embed/${id}`,
    `https://www.youtube.com/attribution_link?u=%2Fwatch%3Fv%3D${id}%26feature%3Dshare`,
    `https://www.youtube.com/redirect?q=https%3A%2F%2Fyoutu.be%2F${id}`,
    `https://www.google.com/url?q=https://www.youtube.com/watch%3Fv%3D${id}&sa=D`,
  ];
  for (const u of ok) assert.equal(parseVideoId(u), id, u);
  const bad = [
    'https://www.youtube.com/', 'https://www.youtube.com/@channel', 'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/watch?v=short', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ"><script>',
    'https://evil.example/watch?v=dQw4w9WgXcQ', 'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'javascript:alert(1)', 'not a url', 'ftp://youtu.be/dQw4w9WgXcQ',
  ];
  for (const u of bad) assert.equal(parseVideoId(u), null, u);
});

test('start times, watch URLs and menu patterns', () => {
  assert.equal(parseStartTime('https://youtu.be/x?t=90'), 90);
  assert.equal(parseStartTime('https://youtu.be/x?t=1h2m3s'), 3723);
  assert.equal(parseStartTime('https://youtu.be/x?t=abc'), null);
  assert.equal(watchUrl('dQw4w9WgXcQ', 61.7), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=61s');
  assert.throws(() => watchUrl('bad'));
  assert.ok(LINK_PATTERNS.every((p) => /^\*:\/\/[a-z.-]+\//.test(p)));
});

test('parsePanelResponse: segments in order with numeric times, chapters, dedupe and noise removal', () => {
  const { segments, chapters } = parsePanelResponse(panelResponse());
  assert.deepEqual(segments.map((s) => s.start), [0, 4, 70, 723, 3723]);
  assert.equal(segments[0].text, 'Welcome to the synthetic bread workshop.');
  assert.deepEqual(chapters, [{ start: 0, title: 'Chapter 1: Dough' }, { start: 700, title: 'Chapter 2: Baking' }]);
  const noisy = parsePanelResponse(panelResponse({ segments: [
    { ts: '0:01', sec: 1, text: '[Music]' }, { ts: '0:02', sec: 2, text: 'hi' }, { ts: '0:02', sec: 2, text: 'hi' },
  ], withChapters: false }));
  assert.deepEqual(noisy.segments, [{ start: 2, text: 'hi' }]);
  // Legacy get_transcript shape
  const legacy = parsePanelResponse({ actions: [{ x: { transcriptSegmentRenderer: { startMs: '12500', snippet: { runs: [{ text: 'old ' }, { text: 'style' }] } } } }] });
  assert.deepEqual(legacy.segments, [{ start: 12.5, text: 'old style' }]);
  assert.deepEqual(parsePanelResponse({}).segments, []);
});

test('DOM rows become segments', () => {
  assert.equal(parseClock('1:02:03'), 3723);
  assert.equal(parseClock('x'), null);
  assert.deepEqual(rowsToSegments([{ ts: '0:04', text: ' a  b ' }, { ts: '', text: 'no time' }, { ts: '0:05', text: '' }, null]),
    [{ start: 4, text: 'a b' }, { start: null, text: 'no time' }]);
  assert.deepEqual(rowsToSegments('nope'), []);
});

test('pasted transcripts: YouTube copy format, inline times, SRT, plain text', () => {
  assert.deepEqual(parsePastedTranscript('0:00\nHello there\n0:05\nSecond line\ncontinues'), [
    { start: 0, text: 'Hello there' }, { start: 5, text: 'Second line continues' }]);
  assert.deepEqual(parsePastedTranscript('[1:02:03] late\n12:00 mid'), [{ start: 3723, text: 'late' }, { start: 720, text: 'mid' }]);
  assert.deepEqual(parsePastedTranscript('1\n00:00:01,000 --> 00:00:03,000\nsrt text\n\n2\n00:00:04,000 --> 00:00:05,000\nmore'), [
    { start: 1, text: 'srt text' }, { start: 4, text: 'more' }]);
  const plain = parsePastedTranscript(('word ').repeat(300));
  assert.ok(plain.length >= 3 && plain.every((s) => s.start === null && s.text.length <= 400));
  assert.deepEqual(parsePastedTranscript('   '), []);
});

test('format helpers and markdown export label metadata results', () => {
  assert.equal(formatClock(3723), '1:02:03');
  assert.equal(formatClock(null), '');
  assert.equal(formatDuration(37_643_000), '10 h 28 min');
  assert.equal(formatDuration(90_000), '2 min');
  const md = summaryToMarkdown({ videoId: VIDEO_ID, meta: { title: 'T' }, result: { source: 'metadata', summary: 'S', keypoints: [{ start: 5, text: 'k' }, { start: null, text: 'n' }], model: 'gemini-3.5-flash-lite' } });
  assert.match(md, /Metadata only/);
  assert.match(md, /\[0:05\]\(https:\/\/www\.youtube\.com\/watch\?v=Zx9Demo_v01&t=5s\) k/);
  assert.match(md, /- n/);
});

test('settings sanitisation: key format, Gemini model ids only, legacy bridge keys dropped', () => {
  const s = sanitizeSettings({ bridgeUrl: 'http://127.0.0.1:1', token: 't', apiKey: 'bad key!', model: 'anthropic/x', length: 'huge', displayMode: 'window', outputLanguage: 'Polish', extra: 1 });
  assert.ok(!('bridgeUrl' in s) && !('token' in s));
  assert.equal(s.apiKey, '');
  assert.equal(s.model, DEFAULT_SETTINGS.model);
  assert.equal(DEFAULT_SETTINGS.model, 'gemini-3.5-flash-lite');
  assert.equal(sanitizeSettings({ apiKey: ' test-key-not-real-0123456789abcdef ' }).apiKey, 'test-key-not-real-0123456789abcdef');
  assert.equal(sanitizeSettings({ model: 'models/gemini-3.1-flash-lite' }).model, 'gemini-3.1-flash-lite');
  assert.equal(sanitizeSettings({ model: 'gemini-x:generateContent?key=1' }).model, DEFAULT_SETTINGS.model);
  assert.equal(s.length, 'standard');
  assert.equal(s.displayMode, 'window');
  assert.equal(s.outputLanguage, 'Polish');
  assert.ok(!('extra' in s));
  assert.equal(needsConsent(DEFAULT_SETTINGS), true);
  assert.equal(needsConsent({ ...DEFAULT_SETTINGS, consentGiven: true }), false);
  assert.equal(needsConsent({ ...DEFAULT_SETTINGS, consentGiven: true, askBeforeSending: true }), true);
});
