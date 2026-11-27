// Popup / small-window view. Renders background snapshots; never builds HTML from data.
import { summaryToMarkdown } from '../lib/format.js';
import { viewModel } from '../lib/view-model.js';
import { parseVideoId } from '../lib/youtube-url.js';

const api = globalThis.browser;
const isWindow = new URLSearchParams(location.search).has('window');
if (isWindow) document.body.classList.add('window');

const $ = (id) => document.getElementById(id);
const view = $('view');
let snapshot = null;
let settings = {};
let pasteOpen = false;
let tick = null;

function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

const port = api.runtime.connect({ name: 'preyt-popup' });
const send = (msg) => port.postMessage(msg);
port.onMessage.addListener((msg) => {
  if (msg?.type !== 'state') return;
  snapshot = msg.snapshot;
  settings = msg.settings ?? {};
  render();
});

$('options').addEventListener('click', () => { send({ type: 'openOptions' }); if (!isWindow) window.close(); });

function renderHeader(vm) {
  const h = vm.header;
  $('video').hidden = !h;
  if (!h) return;
  $('video-title').textContent = h.title;
  $('video-title').href = h.url;
  $('video-sub').textContent = [h.channel, h.duration].filter(Boolean).join(' · ');
  const img = $('thumb');
  if (h.thumbnail) { if (img.getAttribute('src') !== h.thumbnail) img.src = h.thumbnail; img.hidden = false; } else img.hidden = true;
}

function renderBar(vm) {
  const job = snapshot?.current;
  $('bar-meta').textContent = vm.state === 'done' ? vm.result.footer : '';
  $('copy').hidden = vm.state !== 'done';
  $('regenerate').hidden = !(vm.state === 'done' || vm.state === 'cancelled');
  $('copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(summaryToMarkdown(job));
      $('copy').textContent = 'Copied';
      setTimeout(() => { $('copy').textContent = 'Copy'; }, 1200);
    } catch { $('copy').textContent = 'Copy failed'; }
  };
  $('regenerate').onclick = () => send({ type: 'retry', jobId: vm.jobId });
}

const STATES = {
  empty(vm) {
    const out = [
      el('h2', { text: 'Summarize a YouTube video' }),
      el('p', { class: 'muted', text: 'Right-click a YouTube link, or anywhere on a video page, and choose “Summarize YouTube video”.' }),
    ];
    const here = el('div', { class: 'row', hidden: true });
    out.push(here);
    api.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      const id = tab?.url ? parseVideoId(tab.url) : null;
      if (!id) return;
      here.hidden = false;
      here.append(el('button', { class: 'primary', onclick: () => send({ type: 'summarizeUrl', url: tab.url, tabId: tab.id, windowId: tab.windowId }) }, 'Summarize this video'));
    }).catch(() => {});
    if (!settings.hasApiKey) {
      out.push(el('div', { class: 'notice' }, el('strong', { text: 'Setup needed' }), 'Add your Gemini API key in Options first.',
        el('div', { class: 'row' }, el('button', { onclick: () => { send({ type: 'openOptions' }); if (!isWindow) window.close(); } }, 'Open Options'))));
    }
    if (vm.recent?.length) {
      out.push(el('h2', { text: 'Recent' }), el('ul', { class: 'recent' }, vm.recent.map((r) => el('li', {}, el('button', { onclick: () => send({ type: 'select', jobId: r.id }) }, r.title || r.videoId)))));
    }
    return out;
  },

  consent(vm) {
    const remember = el('input', { type: 'checkbox', id: 'remember', checked: vm.consent.rememberDefault });
    return [
      el('div', { class: 'consent' },
        el('h2', { text: 'Send this video to an AI provider?' }),
        el('p', { class: 'small', text: vm.consent.intro }),
        el('ul', { class: 'small' }, vm.consent.items.map((t) => el('li', { text: t }))),
        el('label', { class: 'check', for: 'remember' }, remember, 'Don’t ask again (change in Options)')),
      el('div', { class: 'row' },
        el('button', { onclick: () => send({ type: 'consent', jobId: vm.jobId, allow: false }) }, 'Cancel'),
        el('button', { class: 'primary', onclick: () => send({ type: 'consent', jobId: vm.jobId, allow: true, remember: remember.checked }) }, 'Send & summarize')),
    ];
  },

  loading(vm) {
    const elapsed = el('span', { class: 'elapsed muted small' });
    const upd = () => { elapsed.textContent = `${Math.max(0, Math.round((Date.now() - vm.startedAt) / 1000))} s`; };
    upd();
    tick = setInterval(upd, 1000);
    return [
      el('div', { class: 'loading' }, el('div', { class: 'spinner', role: 'progressbar', 'aria-label': 'Working' }), el('div', {}, vm.loading.label, ' ', elapsed)),
      el('ol', { class: 'steps' }, vm.loading.steps.map((s) => el('li', { class: s.state }, s.label, s.detail ? ` (${s.detail})` : ''))),
      el('div', { class: 'row' }, el('button', { onclick: () => send({ type: 'cancel', jobId: vm.jobId }) }, 'Cancel')),
    ];
  },

  done(vm) {
    const r = vm.result;
    const out = [];
    if (r.badge?.warning) out.push(el('div', { class: 'notice', role: 'note' }, el('strong', { text: r.badge.label }), r.badge.warning));
    else if (r.badge) out.push(el('div', { class: `badge ${r.badge.kind}`, text: r.badge.label }));
    out.push(el('h2', { text: r.badge?.kind === 'metadata' ? 'What the video appears to cover' : 'Summary' }), el('p', { class: 'summary', text: r.summary }));
    if (r.keypoints.length) {
      out.push(el('h2', { text: r.badge?.kind === 'metadata' ? 'Topics / chapters' : 'Key points' }),
        el('ol', { class: 'points' }, r.keypoints.map((k) => el('li', {},
          k.seconds !== null
            ? el('button', { class: 'chip', title: `Open at ${k.time}`, onclick: () => { send({ type: 'openAt', jobId: vm.jobId, seconds: k.seconds }); if (!isWindow) window.close(); } }, k.time)
            : el('span', { class: 'dot', 'aria-hidden': 'true', text: '•' }),
          el('span', { text: k.text })))));
    }
    return out;
  },

  'no-transcript'(vm) {
    const nt = vm.noTranscript;
    const area = el('textarea', { placeholder: 'Paste a transcript here (YouTube “Show transcript” text, SRT/VTT, or plain text)…', 'aria-label': 'Transcript' });
    const pasteBox = el('div', { class: 'stack', hidden: !pasteOpen },
      area,
      el('div', { class: 'row' }, el('button', { class: 'primary', onclick: () => send({ type: 'paste', jobId: vm.jobId, text: area.value }) }, 'Summarize pasted text')));
    return [
      el('h2', { text: 'No transcript available' }),
      el('p', { class: 'muted', text: nt.message }),
      nt.details.length ? el('details', {}, el('summary', { text: 'Details' }), el('code', { text: nt.details.join(' · ') })) : null,
      el('div', { class: 'stack' },
        el('button', { class: 'wide', onclick: () => { pasteOpen = !pasteOpen; pasteBox.hidden = !pasteOpen; if (pasteOpen) area.focus(); } },
          'Paste a transcript…', el('span', { class: 'hint', text: 'Gives a real summary with your text.' })),
        pasteBox,
        nt.canMetadata ? el('button', { class: 'wide', onclick: () => send({ type: 'metadata', jobId: vm.jobId }) },
          nt.metadataLabel, el('span', { class: 'hint', text: nt.metadataHint })) : null),
    ];
  },

  error(vm) {
    const e = vm.error;
    return [
      el('div', { class: 'error-title', role: 'alert', text: e.title }),
      el('p', { text: e.message }),
      el('div', { class: 'row' },
        e.needsOptions ? el('button', { onclick: () => { send({ type: 'openOptions' }); if (!isWindow) window.close(); } }, 'Open Options') : null,
        e.retryable ? el('button', { class: 'primary', onclick: () => send({ type: 'retry', jobId: vm.jobId }) }, 'Try again') : null),
    ];
  },

  cancelled(vm) {
    return [el('p', { class: 'muted', text: 'Cancelled. Nothing more will be sent.' }),
      el('div', { class: 'row' }, el('button', { class: 'primary', onclick: () => send({ type: 'retry', jobId: vm.jobId }) }, 'Start again'))];
  },
};

function render() {
  clearInterval(tick);
  const vm = viewModel(snapshot, settings);
  if (vm.state !== 'no-transcript') pasteOpen = false;
  renderHeader(vm);
  renderBar(vm);
  view.replaceChildren(...(STATES[vm.state] ?? STATES.empty)(vm).filter(Boolean));
  document.title = vm.header ? `Preyt – ${vm.header.title}` : 'Preyt';
}
