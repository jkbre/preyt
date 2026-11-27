// Exit-code policy of the manual Gecko self-test (the browser run itself is manual).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT, geckoVerdict } from './verdict.mjs';

const good = () => ({
  steps: {
    openTab: { ok: true, status: 'ok', method: 'page-api', segments: 12, userTabStillOpen: true },
    tab: { ok: true, status: 'ok', method: 'tab-api', segments: 12, ownedTabStillOpen: false },
    gemini: { ok: true, models: 4, realTranscript: true, summarize: { ok: true, model: 'gemini-3.5-flash-lite', summary: 'A real summary.' } },
    backgroundPage: { ok: true, loaded: true },
  },
});

test('full pass only with a real model-generated summary of the fetched transcript', () => {
  assert.deepEqual(geckoVerdict(good()), { exitCode: EXIT.PASS, outcome: 'model-generated', failures: [] });
  const synthetic = good();
  synthetic.steps.gemini.realTranscript = false;
  assert.equal(geckoVerdict(synthetic).exitCode, EXIT.FAIL);
});

test('no key and quota-limited are distinct from success and from failure', () => {
  const r = good();
  r.steps.gemini.summarize = { ok: false, code: 'rate_limited', retryAfterMs: 1000 };
  assert.deepEqual(geckoVerdict(r), { exitCode: EXIT.NOT_VERIFIED, outcome: 'quota-limited', failures: [] });
  const k = good();
  k.steps.gemini = { ok: true, skipped: true };
  assert.deepEqual(geckoVerdict(k), { exitCode: EXIT.NOT_VERIFIED, outcome: 'no-key', failures: [] });
  assert.notEqual(EXIT.NOT_VERIFIED, 0);
});

test('zero transcript segments fail (nonzero) even when the step itself did not throw', () => {
  for (const step of ['openTab', 'tab']) {
    const r = good();
    Object.assign(r.steps[step], { status: 'none', segments: 0, reason: 'panel_missing' });
    const v = geckoVerdict(r);
    assert.equal(v.exitCode, EXIT.FAIL, step);
    assert.ok(v.failures.some((f) => f.startsWith(`${step}: zero transcript segments`)), v.failures.join('\n'));
  }
  const r = good();
  r.steps.tab.segments = 0;
  assert.equal(geckoVerdict(r).exitCode, EXIT.FAIL);
});

test('unexpected summarize errors, empty summaries and non-Gemini models fail', () => {
  for (const code of ['invalid_api_key', 'unknown_model', 'bad_model_output', 'client_timeout', 'network_error', undefined]) {
    const r = good();
    r.steps.gemini.summarize = { ok: false, code };
    const v = geckoVerdict(r);
    assert.equal(v.exitCode, EXIT.FAIL, String(code));
    assert.match(v.failures.join('\n'), /unexpected summarize error/);
  }
  const empty = good();
  empty.steps.gemini.summarize.summary = '  ';
  assert.equal(geckoVerdict(empty).exitCode, EXIT.FAIL);
  const other = good();
  other.steps.gemini.summarize.model = 'gpt-9';
  assert.equal(geckoVerdict(other).exitCode, EXIT.FAIL);
});

test('not-verified outcomes do not hide other failures', () => {
  const r = good();
  r.steps.gemini.summarize = { ok: false, code: 'rate_limited' };
  r.steps.tab.ownedTabStillOpen = true;
  assert.equal(geckoVerdict(r).exitCode, EXIT.FAIL);
  const r2 = good();
  r2.steps.gemini = { ok: true, skipped: true };
  r2.steps.openTab.segments = 0;
  assert.equal(geckoVerdict(r2).exitCode, EXIT.FAIL);
});

test('missing or thrown steps fail', () => {
  assert.equal(geckoVerdict(null).exitCode, EXIT.FAIL);
  assert.equal(geckoVerdict({ steps: {} }).exitCode, EXIT.FAIL);
  const r = good();
  r.steps.gemini = { ok: false, code: 'invalid_api_key', error: 'x' };
  assert.equal(geckoVerdict(r).exitCode, EXIT.FAIL);
});
