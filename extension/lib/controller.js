// Background job controller: owns every summary job and its state machine.
// Popups are thin views that receive snapshots and send user intents.
//
//   request ──► needs-consent ──(allow)──► fetching-transcript ──► summarizing ──► done
//                    │(deny)                     │ none                │ error
//                    ▼                           ▼                     ▼
//                cancelled                 no-transcript ───────►  error (retryable)
//                                     (user picks: metadata-only / paste)
import { SummaryError } from './prompt.js';
import { needsConsent } from './settings.js';
import { parsePastedTranscript } from './format.js';
import { VIDEO_ID_RE, watchUrl } from './youtube-url.js';

export const S = Object.freeze({
  CONSENT: 'needs-consent',
  TRANSCRIPT: 'fetching-transcript',
  SUMMARIZING: 'summarizing',
  DONE: 'done',
  NO_TRANSCRIPT: 'no-transcript',
  ERROR: 'error',
  CANCELLED: 'cancelled',
});

const ACTIVE = new Set([S.TRANSCRIPT, S.SUMMARIZING]);
const MAX_JOBS = 20;

export class JobController {
  /**
   * @param deps.getSettings   () => Promise<settings>
   * @param deps.saveSettings  (patch) => Promise<settings>
   * @param deps.getTranscript (videoId, {signal, settings, onStage, origin}) => Promise<transcript>
   * @param deps.createSummarizer (settings) => { summarize(payload, {signal}) }
   * @param deps.openUrl       (url, originTabId|undefined) => void
   */
  constructor({ getSettings, saveSettings, getTranscript, createSummarizer, openUrl = () => {}, now = () => Date.now() }) {
    Object.assign(this, { getSettings, saveSettings, getTranscript, createSummarizer, openUrl, now });
    this.jobs = new Map();
    this.currentId = null;
    this.listeners = new Set();
    this.seq = 0;
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  #emit() {
    const snap = this.snapshot();
    for (const fn of this.listeners) { try { fn(snap); } catch { /* a closed popup port */ } }
  }

  /** Popup-safe view of a job: no transcript text, no abort controllers. */
  static publicJob(job) {
    if (!job) return null;
    const { _segments, _abort, _pending, _gen, ...rest } = job;
    return structuredClone(rest);
  }

  snapshot() {
    const recent = [...this.jobs.values()].reverse().slice(0, 8)
      .map((j) => ({ id: j.id, videoId: j.videoId, title: j.meta.title, status: j.status }));
    return { current: JobController.publicJob(this.jobs.get(this.currentId)), recent };
  }

  get(jobId) { return this.jobs.get(jobId); }

  /** Entry point for context-menu clicks. */
  async request({ videoId, origin = {} }) {
    if (!VIDEO_ID_RE.test(videoId)) throw new Error('invalid video id');
    // Re-show a finished or running job for the same video instead of paying for a new one.
    const existing = [...this.jobs.values()].reverse().find((j) => j.videoId === videoId && (j.status === S.DONE || ACTIVE.has(j.status) || j.status === S.CONSENT));
    if (existing) {
      existing.origin = origin;
      this.currentId = existing.id;
      this.#emit();
      return existing;
    }
    const job = {
      id: `job-${++this.seq}-${this.now().toString(36)}`,
      videoId,
      url: watchUrl(videoId),
      origin,
      status: S.CONSENT,
      stage: '',
      meta: { title: '', channel: '', durationSec: null },
      transcript: null,
      result: null,
      error: null,
      createdAt: this.now(),
      updatedAt: this.now(),
      _pending: { kind: 'transcript' },
    };
    this.jobs.set(job.id, job);
    while (this.jobs.size > MAX_JOBS) {
      const oldest = this.jobs.keys().next().value;
      this.jobs.get(oldest)?._abort?.abort();
      this.jobs.delete(oldest);
    }
    this.currentId = job.id;
    const gen = this.#bump(job);
    const settings = await this.getSettings();
    if (job._gen !== gen || job.status === S.CANCELLED) return job; // cancelled while settings loaded
    if (needsConsent(settings)) {
      this.#set(job, { status: S.CONSENT });
      return job;
    }
    this.#start(job, job._pending);
    return job;
  }

  /** Popup intents. Returns the new snapshot. */
  async handle(msg) {
    const job = this.jobs.get(msg?.jobId);
    switch (msg?.type) {
      case 'select':
        if (job) { this.currentId = job.id; this.#emit(); }
        break;
      case 'consent':
        if (!job || job.status !== S.CONSENT) break;
        if (!msg.allow) { this.#set(job, { status: S.CANCELLED, stage: '' }); break; }
        if (msg.remember) {
          const gen = this.#bump(job);
          await this.saveSettings({ consentGiven: true, askBeforeSending: false });
          if (job._gen !== gen || job.status !== S.CONSENT) break; // cancelled meanwhile
        }
        this.#start(job, job._pending ?? { kind: 'transcript' });
        break;
      case 'retry':
        if (!job || ACTIVE.has(job.status)) break;
        await this.#gate(job, job._pending ?? { kind: 'transcript' });
        break;
      case 'metadata':
        if (!job || job.status !== S.NO_TRANSCRIPT) break;
        await this.#gate(job, { kind: 'metadata' });
        break;
      case 'paste': {
        if (!job || ACTIVE.has(job.status)) break;
        const segments = parsePastedTranscript(msg.text);
        if (!segments.length) { this.#set(job, { status: S.ERROR, error: { code: 'empty_paste', message: 'The pasted text is empty.', retryable: false } }); break; }
        job._segments = segments;
        await this.#gate(job, { kind: 'pasted' });
        break;
      }
      case 'cancel':
        if (!job) break;
        this.#bump(job); // invalidates a start that is still waiting for settings
        job._abort?.abort();
        if (ACTIVE.has(job.status) || job.status === S.CONSENT) this.#set(job, { status: S.CANCELLED, stage: '' });
        break;
      case 'openAt':
        if (!job) break;
        this.openUrl(watchUrl(job.videoId, Number(msg.seconds)), job.origin?.kind === 'page' ? job.origin.tabId : undefined);
        break;
      default:
        break;
    }
    return this.snapshot();
  }

  /** Generation counter: any await before starting work re-checks it to honour a cancel. */
  #bump(job) {
    job._gen = (job._gen ?? 0) + 1;
    return job._gen;
  }

  async #gate(job, pending) {
    job._pending = pending;
    const gen = this.#bump(job);
    const settings = await this.getSettings();
    if (job._gen !== gen) return; // cancelled (or superseded) while settings loaded
    if (needsConsent(settings)) this.#set(job, { status: S.CONSENT, error: null });
    else this.#start(job, pending);
  }

  #set(job, patch) {
    Object.assign(job, patch, { updatedAt: this.now() });
    this.#emit();
  }

  #start(job, pending) {
    job._pending = pending;
    job._abort?.abort();
    const ac = new AbortController();
    job._abort = ac;
    this.#run(job, pending, ac.signal).catch((e) => {
      if (job._abort !== ac) return; // superseded
      if (ac.signal.aborted) { if (ACTIVE.has(job.status)) this.#set(job, { status: S.CANCELLED, stage: '' }); return; }
      this.#set(job, { status: S.ERROR, stage: '', error: toJobError(e) });
    });
  }

  async #run(job, pending, signal) {
    const cancelled = () => new SummaryError('cancelled', 'Cancelled');
    const settings = await this.getSettings();
    if (signal.aborted) throw cancelled(); // cancel arrived while settings loaded
    job.error = null;
    job.result = null;
    job.startedAt = this.now();
    job.source = pending.kind; // 'transcript' | 'pasted' | 'metadata'
    let segments;
    let source;
    if (pending.kind === 'transcript') {
      this.#set(job, { status: S.TRANSCRIPT, stage: '' });
      const tr = await this.getTranscript(job.videoId, {
        signal, settings, origin: job.origin,
        onStage: (stage) => { if (!signal.aborted) this.#set(job, { stage }); },
      });
      if (signal.aborted) return;
      job.meta = { ...job.meta, ...tr.meta };
      job.transcript = {
        method: tr.method, segments: tr.segments.length, captionKind: tr.captionKind,
        chapters: tr.chapters ?? [], problems: tr.problems ?? [], reason: tr.reason ?? null,
      };
      if (tr.status !== 'ok') {
        this.#set(job, { status: S.NO_TRANSCRIPT, stage: '' });
        return;
      }
      segments = tr.segments;
      source = 'transcript';
      job._segments = segments;
    } else if (pending.kind === 'pasted') {
      segments = job._segments;
      source = 'pasted';
    } else {
      source = 'metadata';
    }

    this.#set(job, { status: S.SUMMARIZING, stage: settings.model });
    const payload = {
      videoId: job.videoId,
      title: job.meta.title || undefined,
      channel: job.meta.channel || undefined,
      durationSec: job.meta.durationSec ?? undefined,
      source,
      captionKind: job.transcript?.captionKind ?? 'unknown',
      chapters: (job.transcript?.chapters ?? job.meta.chapters ?? []).slice(0, 300),
      options: { length: settings.length, outputLanguage: settings.outputLanguage },
    };
    if (source === 'metadata') payload.description = (job.meta.description || '').slice(0, 10_000);
    else payload.segments = segments;

    const summarizer = this.createSummarizer(settings);
    if (signal.aborted) throw cancelled();
    const res = await summarizer.summarize(payload, { signal });
    if (signal.aborted) return;
    this.#set(job, {
      status: S.DONE,
      stage: '',
      result: {
        source: res.source,
        summary: res.summary,
        keypoints: Array.isArray(res.keypoints) ? res.keypoints : [],
        model: res.model,
        truncated: Boolean(res.truncated),
        coverage: res.coverage ?? 1,
        elapsedMs: res.elapsedMs ?? null,
      },
    });
  }
}

const NEEDS_OPTIONS = ['no_api_key', 'invalid_api_key', 'permission_denied', 'unknown_model'];
const NOT_RETRYABLE = [...NEEDS_OPTIONS, 'blocked', 'bad_request', 'empty_transcript'];

export function toJobError(e) {
  if (e instanceof SummaryError) {
    return {
      code: e.code,
      message: e.message,
      detail: e.detail,
      retryAfterMs: e.retryAfterMs,
      retryable: !NOT_RETRYABLE.includes(e.code),
      needsOptions: NEEDS_OPTIONS.includes(e.code),
    };
  }
  return { code: e?.code ?? 'error', message: String(e?.message ?? e).slice(0, 300), retryable: true };
}
