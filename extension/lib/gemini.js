// Gemini API client (generateContent + models.list). The API key is sent only in the
// x-goog-api-key header to the fixed Google endpoint below, never in a URL.
import { SummaryError, RESPONSE_SCHEMA, SYSTEM_PROMPT, buildPrompt, normalizeRequest, parseModelOutput } from './prompt.js';

export { SummaryError };

export const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
export const MODEL_RE = /^gemini-[a-z0-9][a-z0-9.-]{0,62}$/;
export const API_KEY_RE = /^[A-Za-z0-9_.-]{20,200}$/;
// ~100k tokens: keeps long videos well inside free-tier per-minute token limits.
export const TRANSCRIPT_BUDGET_CHARS = 400_000;
// Model families that cannot produce a text summary.
const NON_TEXT_RE = /(embedding|tts|image|live|transcribe|translate|audio|aqa|robotics)/;

const MESSAGES = {
  invalid_api_key: 'Google rejected the API key. Check it in Options (create one at aistudio.google.com/apikey).',
  permission_denied: 'This API key is not allowed to use the Gemini API. Check the key’s API restrictions in Google AI Studio.',
  unknown_model: 'Gemini does not offer this model to your key. Pick another model in Options.',
  rate_limited: 'Gemini’s rate limit or your daily free quota is reached.',
  provider_unavailable: 'Gemini is temporarily overloaded or unavailable.',
};

/** Parse "37s" / "1.5s" style protobuf durations into ms. */
function retryDelayMs(details) {
  for (const d of Array.isArray(details) ? details : []) {
    if (typeof d?.['@type'] === 'string' && d['@type'].endsWith('RetryInfo') && typeof d.retryDelay === 'string') {
      const m = /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay);
      if (m) return Math.round(Number(m[1]) * 1000);
    }
  }
  return undefined;
}

export function mapApiError(status, data) {
  const err = data?.error ?? {};
  const apiMessage = typeof err.message === 'string' ? err.message.slice(0, 300) : '';
  const reasons = (Array.isArray(err.details) ? err.details : []).map((d) => d?.reason).filter(Boolean);
  let code;
  if (reasons.includes('API_KEY_INVALID') || status === 401) code = 'invalid_api_key';
  else if (status === 403) code = 'permission_denied';
  else if (status === 404) code = 'unknown_model';
  else if (status === 429) code = 'rate_limited';
  else if (status >= 500) code = 'provider_unavailable';
  else code = `http_${status}`;
  const message = MESSAGES[code] ?? (apiMessage || `Gemini returned HTTP ${status}`);
  return new SummaryError(code, message, { status, detail: apiMessage || undefined, retryAfterMs: retryDelayMs(err.details) });
}

/**
 * @param {{apiKey:string, model?:string, fetchFn?:typeof fetch, sleep?:(ms:number)=>Promise<void>, now?:()=>number}} opts
 */
export function createGeminiClient({ apiKey, model = DEFAULT_MODEL, fetchFn = (...a) => fetch(...a), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() }) {
  async function call(path, { method = 'GET', body, signal, timeoutMs = 20_000 } = {}) {
    if (!apiKey) throw new SummaryError('no_api_key', 'No Gemini API key set. Open Options and paste your key.');
    if (!API_KEY_RE.test(apiKey)) throw new SummaryError('invalid_api_key', MESSAGES.invalid_api_key);
    // An already-aborted signal never fires 'abort' again: refuse before any request is made.
    if (signal?.aborted) throw new SummaryError('cancelled', 'Cancelled');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new SummaryError('client_timeout', 'Gemini did not respond in time')), timeoutMs);
    const onAbort = () => ac.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    let res;
    try {
      res = await fetchFn(API_BASE + path, {
        method,
        signal: ac.signal,
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: {
          'x-goog-api-key': apiKey,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      if (signal?.aborted) throw new SummaryError('cancelled', 'Cancelled');
      if (ac.signal.aborted) throw new SummaryError('client_timeout', 'Gemini did not respond in time.');
      throw new SummaryError('network_error', 'Cannot reach the Gemini API. Check your internet connection.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) throw mapApiError(res.status, data);
    if (!data || typeof data !== 'object') throw new SummaryError('bad_response', 'Gemini returned an unreadable response.');
    return data;
  }

  /** Text-capable Gemini models this key may call, sorted by id. */
  async function listModels({ signal } = {}) {
    const out = [];
    let pageToken = '';
    for (let page = 0; page < 5; page++) {
      const q = new URLSearchParams({ pageSize: '1000', ...(pageToken ? { pageToken } : {}) });
      const data = await call(`/models?${q}`, { signal, timeoutMs: 10_000 });
      for (const m of Array.isArray(data.models) ? data.models : []) {
        const id = typeof m?.name === 'string' ? m.name.replace(/^models\//, '') : '';
        if (!MODEL_RE.test(id) || NON_TEXT_RE.test(id)) continue;
        if (!Array.isArray(m.supportedGenerationMethods) || !m.supportedGenerationMethods.includes('generateContent')) continue;
        out.push({ id, displayName: typeof m.displayName === 'string' ? m.displayName.slice(0, 80) : id, inputTokenLimit: Number(m.inputTokenLimit) || null });
      }
      pageToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
      if (!pageToken) break;
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  async function summarize(payload, { signal } = {}) {
    if (!MODEL_RE.test(model)) throw new SummaryError('unknown_model', MESSAGES.unknown_model);
    const req = normalizeRequest(payload);
    const prompt = buildPrompt(req, { budgetChars: TRANSCRIPT_BUDGET_CHARS });
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: prompt.text }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: RESPONSE_SCHEMA,
        temperature: 0.3,
        maxOutputTokens: 4096,
      },
    };
    const started = now();
    let data;
    for (let attempt = 1; ; attempt++) {
      try {
        data = await call(`/models/${model}:generateContent`, { method: 'POST', body, signal, timeoutMs: 120_000 });
        break;
      } catch (e) {
        // One quiet retry for transient 5xx overloads; everything else surfaces immediately.
        if (attempt >= 2 || e.code !== 'provider_unavailable' || signal?.aborted) throw e;
        await sleep(1500);
        if (signal?.aborted) throw new SummaryError('cancelled', 'Cancelled');
      }
    }

    if (data.promptFeedback?.blockReason) {
      throw new SummaryError('blocked', `Gemini refused this request (${String(data.promptFeedback.blockReason).slice(0, 60)}).`);
    }
    const cand = Array.isArray(data.candidates) ? data.candidates[0] : null;
    const text = (cand?.content?.parts ?? []).filter((p) => p && !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
    if (['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION'].includes(cand?.finishReason) && !text) {
      throw new SummaryError('blocked', `Gemini stopped the answer (${cand.finishReason}).`);
    }
    const hasTimes = req.source === 'metadata' ? req.chapters.some((c) => c.start !== null) : req.segments.some((s) => s.start !== null);
    const lastStart = req.segments.reduce((m, s) => (s.start !== null && s.start > m ? s.start : m), 0);
    const parsed = parseModelOutput(text, { maxTime: req.durationSec ?? (lastStart || null), allowTimes: hasTimes });
    if (!parsed) {
      throw new SummaryError('bad_model_output', cand?.finishReason === 'MAX_TOKENS'
        ? 'Gemini’s answer was cut off before it was complete. Try the “Short” length.'
        : 'Gemini returned an answer Preyt could not read. Try again.');
    }
    return {
      source: req.source,
      summary: parsed.summary,
      keypoints: parsed.keypoints,
      model: typeof data.modelVersion === 'string' && MODEL_RE.test(data.modelVersion) ? data.modelVersion : model,
      truncated: prompt.truncated,
      coverage: prompt.coverage,
      elapsedMs: now() - started,
    };
  }

  return { listModels, summarize };
}
