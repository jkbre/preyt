// Pure verdict for the Gecko self-test report (unit-tested in test/gecko/verdict.test.mjs).
//
// Exit codes of run-gecko-selftest.mjs:
//   0  everything passed, including a real model-generated summary
//   3  everything else passed, but the summary was NOT verified: no API key was given,
//      or Gemini returned HTTP 429 (rate_limited)
//   1  anything else (no transcript, tab left open, unexpected Gemini/summarize error, ...)
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, NOT_VERIFIED: 3 });

const MODEL_RE = /^gemini-[a-z0-9][a-z0-9.-]{0,62}$/;

function transcriptStep(name, s, failures) {
  if (!s) { failures.push(`${name}: step missing`); return; }
  if (!s.ok) { failures.push(`${name}: threw ${s.code ?? ''} ${s.error ?? ''}`.trim()); return; }
  if (s.status !== 'ok') failures.push(`${name}: transcript status ${s.status} (${s.reason ?? 'no reason'})`);
  if (!(Number(s.segments) > 0)) failures.push(`${name}: zero transcript segments`);
}

/** @returns {{ exitCode: number, outcome: 'model-generated'|'quota-limited'|'no-key'|'failed', failures: string[] }} */
export function geckoVerdict(report) {
  const failures = [];
  const steps = report?.steps;
  if (!steps || typeof steps !== 'object') return { exitCode: EXIT.FAIL, outcome: 'failed', failures: ['report has no steps'] };

  transcriptStep('openTab', steps.openTab, failures);
  if (steps.openTab?.ok && steps.openTab.userTabStillOpen !== true) failures.push('openTab: the user tab was closed by the read-only path');
  transcriptStep('tab', steps.tab, failures);
  if (steps.tab?.ok && steps.tab.ownedTabStillOpen !== false) failures.push('tab: the owned background tab was not closed');
  if (steps.backgroundPage && steps.backgroundPage.loaded !== true) failures.push('backgroundPage: not loaded');

  let summary = 'failed';
  const g = steps.gemini;
  if (!g?.ok) failures.push(`gemini: ${g ? `threw ${g.code ?? ''} ${g.error ?? ''}`.trim() : 'step missing'}`);
  else if (g.skipped) summary = 'no-key';
  else if (g.summarize?.ok === true) {
    const okText = typeof g.summarize.summary === 'string' && g.summarize.summary.trim().length > 0;
    const okModel = MODEL_RE.test(String(g.summarize.model ?? ''));
    if (!okText) failures.push('gemini: summarize returned an empty summary');
    if (!okModel) failures.push(`gemini: unexpected model ${g.summarize.model}`);
    if (g.realTranscript !== true) failures.push('gemini: summarized a synthetic line, not the fetched transcript');
    if (okText && okModel) summary = 'model-generated';
  } else if (g.summarize?.code === 'rate_limited') {
    summary = 'quota-limited';
  } else {
    failures.push(`gemini: unexpected summarize error ${g.summarize?.code ?? 'unknown'}${g.summarize?.message ? `: ${g.summarize.message}` : ''}`);
  }

  if (failures.length) return { exitCode: EXIT.FAIL, outcome: 'failed', failures };
  if (summary !== 'model-generated') return { exitCode: EXIT.NOT_VERIFIED, outcome: summary, failures };
  return { exitCode: EXIT.PASS, outcome: 'model-generated', failures };
}
