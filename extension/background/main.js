// Background page: context menus, popup opening, job controller, popup ports.
import { createGeminiClient } from '../lib/gemini.js';
import { JobController, S } from '../lib/controller.js';
import { DEFAULT_SETTINGS, LEGACY_KEYS, loadSettings, saveSettings, sanitizeSettings } from '../lib/settings.js';
import { fetchTranscriptFromOpenTab, fetchTranscriptViaTab, getTranscript } from '../lib/transcript.js';
import { LINK_PATTERNS, PAGE_PATTERNS, parseVideoId } from '../lib/youtube-url.js';

const api = globalThis.browser;
let cachedSettings = { ...DEFAULT_SETTINGS };

// Upgrade from the bridge-based 0.1.x: drop the bridge URL/token and ask for consent again,
// because data now goes to a different provider (Google) than the one the user agreed to.
async function migrate() {
  const legacy = await api.storage.local.get(LEGACY_KEYS);
  if (Object.keys(legacy).length) {
    await api.storage.local.remove(LEGACY_KEYS);
    await saveSettings(api.storage, { consentGiven: false });
  }
}
migrate().catch(() => {}).then(() => loadSettings(api.storage)).then((s) => { cachedSettings = s; });
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const patch = {};
  for (const [k, v] of Object.entries(changes)) patch[k] = v.newValue;
  cachedSettings = sanitizeSettings({ ...cachedSettings, ...patch });
});

const ownedTabs = new Set();

const controller = new JobController({
  getSettings: () => loadSettings(api.storage),
  saveSettings: (patch) => saveSettings(api.storage, patch),
  getTranscript: (videoId, { signal, settings, onStage, origin }) => getTranscript(videoId, {
    onStage,
    fromPage: settings.useCurrentTab && origin?.kind === 'page' && origin.tabId !== undefined
      ? (id) => fetchTranscriptFromOpenTab(id, { tabs: api.tabs, tabId: origin.tabId, signal })
      : undefined,
    viaTab: (id) => fetchTranscriptViaTab(id, {
      tabs: api.tabs,
      windowId: origin?.windowId,
      signal,
      onTab: (tabId) => ownedTabs.add(tabId),
    }),
  }),
  createSummarizer: (s) => createGeminiClient({ apiKey: s.apiKey, model: s.model }),
  openUrl: async (url, tabId) => {
    if (tabId !== undefined) {
      try { await api.tabs.update(tabId, { url, active: true }); return; } catch { /* tab gone */ }
    }
    await api.tabs.create({ url, active: true });
  },
});

api.tabs.onRemoved.addListener((tabId) => ownedTabs.delete(tabId));

// Toolbar badge mirrors the current job so a closed popup still shows progress.
controller.subscribe((snap) => {
  const st = snap.current?.status;
  const text = st === S.TRANSCRIPT || st === S.SUMMARIZING ? '…' : st === S.ERROR ? '!' : '';
  api.browserAction.setBadgeText({ text }).catch(() => {});
  api.browserAction.setBadgeBackgroundColor({ color: st === S.ERROR ? '#d70022' : '#0061e0' }).catch(() => {});
});

// ---- popup window fallback ------------------------------------------------
let popupWindowId = null;
async function showWindow() {
  if (popupWindowId !== null) {
    try { await api.windows.update(popupWindowId, { focused: true }); return; } catch { popupWindowId = null; }
  }
  const w = await api.windows.create({ url: api.runtime.getURL('popup/summary.html?window=1'), type: 'popup', width: 420, height: 620 });
  popupWindowId = w.id;
}
api.windows.onRemoved.addListener((id) => { if (id === popupWindowId) popupWindowId = null; });

/** Must be called synchronously inside the user-action handler (openPopup requirement). */
function showUi() {
  if (cachedSettings.displayMode === 'window') { showWindow().catch(() => {}); return; }
  try {
    api.browserAction.openPopup().catch(() => showWindow().catch(() => {}));
  } catch {
    showWindow().catch(() => {});
  }
}

// ---- context menus -----------------------------------------------------------
async function createMenus() {
  await api.menus.removeAll();
  api.menus.create({
    id: 'preyt-link',
    title: 'Summarize YouTube video',
    contexts: ['link'],
    targetUrlPatterns: LINK_PATTERNS,
  });
  api.menus.create({
    id: 'preyt-page',
    title: 'Summarize this video',
    contexts: ['page', 'video', 'frame'],
    documentUrlPatterns: PAGE_PATTERNS,
  });
}
createMenus();

api.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'preyt-link' && info.menuItemId !== 'preyt-page') return;
  const url = info.menuItemId === 'preyt-link' ? info.linkUrl : (info.pageUrl || tab?.url);
  const videoId = parseVideoId(url);
  showUi(); // first, while the click still counts as a user action
  if (!videoId) return;
  controller.request({
    videoId,
    origin: { kind: info.menuItemId === 'preyt-page' ? 'page' : 'link', tabId: tab?.id, windowId: tab?.windowId },
  }).catch((e) => console.error('[preyt] request failed', e));
});

// ---- popup ports ---------------------------------------------------------------
api.runtime.onConnect.addListener((port) => {
  if (port.name !== 'preyt-popup' || port.sender?.id !== api.runtime.id) return;
  const send = (snap) => { try { port.postMessage({ type: 'state', snapshot: snap, settings: publicSettings() }); } catch { /* closed */ } };
  const unsubscribe = controller.subscribe(send);
  send(controller.snapshot());
  port.onMessage.addListener(async (msg) => {
    if (msg?.type === 'openOptions') { api.runtime.openOptionsPage(); return; }
    if (msg?.type === 'summarizeUrl') {
      const id = parseVideoId(msg.url);
      // The toolbar popup offers this only for the active YouTube tab, so treat it like a page click.
      const tabId = Number.isInteger(msg.tabId) ? msg.tabId : undefined;
      if (id) await controller.request({ videoId: id, origin: { kind: tabId === undefined ? 'link' : 'page', tabId, windowId: msg.windowId } });
      return;
    }
    await controller.handle(msg);
  });
  port.onDisconnect.addListener(unsubscribe);
});

function publicSettings() {
  const { apiKey, ...rest } = cachedSettings;
  return { ...rest, hasApiKey: Boolean(apiKey) };
}

// Owned tabs must never outlive the extension session.
api.runtime.onSuspend?.addListener(() => { for (const id of ownedTabs) api.tabs.remove(id).catch(() => {}); });
