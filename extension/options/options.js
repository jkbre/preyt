import { DEFAULT_MODEL, createGeminiClient } from '../lib/gemini.js';
import { loadSettings, saveSettings } from '../lib/settings.js';

const api = globalThis.browser;
const form = document.getElementById('form');
const result = document.getElementById('test-result');
const saved = document.getElementById('saved');

function fill(s) {
  for (const el of form.elements) {
    if (!el.name || !(el.name in s)) continue;
    if (el.type === 'checkbox') el.checked = Boolean(s[el.name]);
    else el.value = s[el.name];
  }
}

function read() {
  const patch = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    patch[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return patch;
}

/** @param models {{id:string, displayName:string}[]} */
function setModels(models, selected) {
  const sel = form.elements.model;
  const list = models.length ? [...models] : [{ id: DEFAULT_MODEL, displayName: '' }];
  if (!list.some((m) => m.id === selected)) list.unshift({ id: selected, displayName: models.length ? 'not offered to this key' : '' });
  sel.replaceChildren(...list.map((m) => new Option(
    m.displayName && m.displayName !== m.id ? `${m.id} – ${m.displayName}` : m.id + (m.id === DEFAULT_MODEL ? ' (default)' : ''),
    m.id,
  )));
  sel.value = selected;
}

let saveTimer;
form.addEventListener('input', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await saveSettings(api.storage, read());
    saved.textContent = 'Saved.';
    setTimeout(() => { saved.textContent = ''; }, 1200);
  }, 250);
});

document.getElementById('reveal').addEventListener('click', (e) => {
  const t = form.elements.apiKey;
  t.type = t.type === 'password' ? 'text' : 'password';
  e.target.textContent = t.type === 'password' ? 'Show' : 'Hide';
});

document.getElementById('reset-consent').addEventListener('click', async () => {
  await saveSettings(api.storage, { consentGiven: false });
  saved.textContent = 'The disclosure will be shown before the next summary.';
});

async function test() {
  const s = await saveSettings(api.storage, read());
  result.className = 'muted';
  result.textContent = 'Testing…';
  try {
    const models = await createGeminiClient({ apiKey: s.apiKey }).listModels();
    setModels(models, s.model);
    const offered = models.some((m) => m.id === s.model);
    result.className = offered ? 'ok' : 'bad';
    result.textContent = offered
      ? `Key works. ${models.length} text models available; using ${s.model}.`
      : `Key works, but ${s.model} is not offered to this key. Pick another model.`;
  } catch (e) {
    result.className = 'bad';
    result.textContent = e.message;
  }
}
document.getElementById('test').addEventListener('click', test);

loadSettings(api.storage).then((s) => {
  setModels([], s.model);
  fill(s);
  if (s.apiKey) test();
});
