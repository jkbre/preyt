// Settings live in storage.local only (never sync: the API key is a secret).
import { API_KEY_RE, DEFAULT_MODEL, MODEL_RE } from './gemini.js';

export const DEFAULT_SETTINGS = Object.freeze({
  apiKey: '',
  model: DEFAULT_MODEL,
  length: 'standard',
  outputLanguage: 'auto',
  useCurrentTab: true, // "Summarize this video" reads the open tab (read-only) before opening a muted helper tab
  displayMode: 'popup', // 'popup' (toolbar panel) | 'window' (small separate window)
  askBeforeSending: false, // ask before every single request (in addition to the first-run disclosure)
  consentGiven: false, // first-run provider disclosure accepted
  showThumbnails: true,
});

const ENUMS = {
  length: ['short', 'standard', 'detailed'],
  displayMode: ['popup', 'window'],
};

export function sanitizeSettings(raw = {}) {
  const s = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (!(k in raw)) continue;
    const v = raw[k];
    if (typeof DEFAULT_SETTINGS[k] === 'boolean') s[k] = Boolean(v);
    else if (ENUMS[k]) s[k] = ENUMS[k].includes(v) ? v : DEFAULT_SETTINGS[k];
    else if (typeof v === 'string') s[k] = v.trim();
  }
  if (s.apiKey && !API_KEY_RE.test(s.apiKey)) s.apiKey = '';
  s.model = s.model.replace(/^models\//, '');
  if (!MODEL_RE.test(s.model)) s.model = DEFAULT_MODEL;
  if (s.outputLanguage !== 'auto' && !/^[\p{L} ()-]{1,40}$/u.test(s.outputLanguage)) s.outputLanguage = 'auto';
  return s;
}

export async function loadSettings(storage) {
  const raw = await storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return sanitizeSettings(raw);
}

export async function saveSettings(storage, patch) {
  const current = await loadSettings(storage);
  const next = sanitizeSettings({ ...current, ...patch });
  await storage.local.set(next);
  return next;
}

/** Leftover keys from the bridge-based 0.1.x versions. */
export const LEGACY_KEYS = ['bridgeUrl', 'token'];

/** True when the user must still approve sending data to the provider. */
export function needsConsent(settings) {
  return settings.askBeforeSending || !settings.consentGiven;
}
