// Injected with tabs.executeScript into a YouTube watch page, after a one-line snippet
// that sets window.__preyt = { mode, videoId }:
//   mode "owned"   – an inactive, muted tab Preyt opened itself: may pause the video and
//                    open the transcript panel as a DOM fallback.
//   mode "current" – the tab the user is watching: strictly read-only (no clicks, no
//                    pausing), and only if the page data belongs to the requested video.
// Fail closed: the options are consumed (deleted) on read, and if they are missing or
// invalid (e.g. the tab navigated between the snippet and this file, or the file was
// injected on its own) the script does nothing and reports "missing_options". The DOM
// fallback only clicks and only accepts rows while the page's active video is the
// requested one.
// The value of the final expression (a Promise) is returned to the background page.
// Parsing happens in the background (lib/innertube.js); this script only gathers raw data.
(async () => {
  'use strict';
  const ID_RE = /^[A-Za-z0-9_-]{11}$/;
  const raw = window.__preyt;
  try { delete window.__preyt; } catch (_) { window.__preyt = undefined; }
  const opts = raw && typeof raw === 'object' && (raw.mode === 'owned' || raw.mode === 'current')
    && typeof raw.videoId === 'string' && ID_RE.test(raw.videoId) ? { mode: raw.mode, videoId: raw.videoId } : null;
  const out = { videoId: opts ? opts.videoId : '', meta: null, panelJson: '', rows: [], chapters: [], captionKind: 'unknown', reason: '' };
  if (!opts) { out.reason = 'missing_options'; return out; }
  const owned = opts.mode === 'owned';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const page = window.wrappedJSObject || window; // Firefox Xray waiver to read page globals
  const pageFetch = (typeof content !== 'undefined' && content.fetch) ? content.fetch.bind(content) : fetch;
  const clone = (o) => { try { return JSON.parse(JSON.stringify(o)); } catch (_) { return null; } };

  const stopPlayback = () => {
    if (!owned) return;
    for (const v of document.querySelectorAll('video')) { try { v.muted = true; v.pause(); } catch (_) { /* ignore */ } }
  };
  stopPlayback();

  // The video the page is showing right now (URL first; the player must not disagree).
  const activeVideoId = () => {
    let id = null;
    try {
      const parts = location.pathname.split('/').filter(Boolean);
      if (parts[0] === 'watch') id = new URLSearchParams(location.search).get('v');
      else if (['shorts', 'live', 'embed'].includes(parts[0])) id = parts[1] || null;
    } catch (_) { id = null; }
    if (!id || !ID_RE.test(id)) return null;
    try {
      const mp = document.getElementById('movie_player');
      const vd = mp && (mp.wrappedJSObject || mp).getVideoData && (mp.wrappedJSObject || mp).getVideoData();
      if (vd && vd.video_id && vd.video_id !== id) return null;
    } catch (_) { /* player not ready: the URL decides */ }
    return id;
  };
  const isRequestedVideo = () => activeVideoId() === opts.videoId;
  if (!isRequestedVideo()) {
    out.reason = 'video_mismatch';
    return out;
  }

  // YouTube is a single-page app: window.ytInitialData describes the first video loaded in
  // the tab. Prefer the live watch element's data and accept only data for our video.
  const idOf = (d) => d && d.currentVideoEndpoint && d.currentVideoEndpoint.watchEndpoint && d.currentVideoEndpoint.watchEndpoint.videoId;
  let data = clone(page.ytInitialData);
  if (idOf(data) !== opts.videoId) {
    const flexy = document.querySelector('ytd-watch-flexy');
    const live = flexy && clone((flexy.wrappedJSObject || flexy).data);
    data = idOf(live) === opts.videoId ? live : null;
  }
  let player = clone(page.ytInitialPlayerResponse);
  if (!player || !player.videoDetails || player.videoDetails.videoId !== opts.videoId) {
    try {
      const mp = document.getElementById('movie_player');
      const live = mp && clone((mp.wrappedJSObject || mp).getPlayerResponse());
      player = live && live.videoDetails && live.videoDetails.videoId === opts.videoId ? live : null;
    } catch (_) { player = null; }
  }

  if (player) {
    const vd = player.videoDetails || {};
    const tracks = (player.captions && player.captions.playerCaptionsTracklistRenderer && player.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
    if (tracks.length && tracks.every((t) => t.kind === 'asr')) out.captionKind = 'asr';
    else if (tracks.length && tracks.every((t) => t.kind !== 'asr')) out.captionKind = 'manual';
    out.meta = {
      title: String(vd.title || ''),
      channel: String(vd.author || ''),
      durationSec: Number(vd.lengthSeconds) || null,
      description: String(vd.shortDescription || '').slice(0, 10000),
    };
    if (!tracks.length) out.reason = 'no_captions';
  }

  if (!data) {
    out.reason = out.reason || 'stale_page';
    if (!owned) return out; // never touch the user's page; the caller falls back to an owned tab
  }

  // 1) In-page get_panel request, sent as the page itself (content.fetch keeps the page origin).
  try {
    const m = data && /"contentSourcePanelIdentifier":\{"surface":"[A-Z_]+","tag":"([^"]*transcript[^"]*)"\},"globalConfiguration":\{"params":"([^"]+)"/.exec(JSON.stringify(data));
    const cfg = page.ytcfg;
    const ctx = cfg && clone(cfg.get('INNERTUBE_CONTEXT'));
    const ver = cfg && cfg.get('INNERTUBE_CLIENT_VERSION');
    const name = cfg && cfg.get('INNERTUBE_CONTEXT_CLIENT_NAME');
    if (m && ctx && ver) {
      const r = await pageFetch('/youtubei/v1/get_panel?prettyPrint=false', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-youtube-client-name': String(name || 1), 'x-youtube-client-version': String(ver) },
        body: JSON.stringify({ context: ctx, panelId: m[1], params: m[2] }),
      });
      if (r.ok) {
        const text = await r.text();
        if (text.includes('transcriptSegment')) { out.panelJson = text; return out; }
        out.reason = out.reason || 'empty_panel';
      } else {
        out.reason = out.reason || `panel_http_${r.status}`;
      }
    } else if (data) {
      out.reason = out.reason || 'panel_missing';
    }
  } catch (_) { out.reason = out.reason || 'panel_error'; }

  if (!owned) return out;

  // 2) DOM fallback (owned tab only): open the transcript panel like a user would.
  //    Background tabs may not render, so this is best effort with a deadline.
  const readRows = () => {
    const modern = [...document.querySelectorAll('transcript-segment-view-model')].map((s) => ({
      ts: (s.querySelector('.ytwTranscriptSegmentViewModelTimestamp') || {}).textContent || '',
      text: (s.querySelector('span[role="text"], .ytAttributedStringHost') || {}).textContent || '',
    }));
    if (modern.length) return modern;
    return [...document.querySelectorAll('ytd-transcript-segment-renderer')].map((s) => ({
      ts: (s.querySelector('.segment-timestamp') || {}).textContent || '',
      text: (s.querySelector('.segment-text, yt-formatted-string') || {}).textContent || '',
    }));
  };
  try {
    const deadline = Date.now() + 12000;
    let button = null;
    while (!button && Date.now() < deadline) {
      button = document.querySelector('ytd-video-description-transcript-section-renderer button')
        || [...document.querySelectorAll('button[aria-label]')].find((b) => /transcri|transkryp|transkript|trascri/i.test(b.getAttribute('aria-label')));
      if (!button) await sleep(300);
    }
    if (button && !isRequestedVideo()) {
      out.reason = 'video_mismatch';
    } else if (button) {
      stopPlayback();
      button.click();
      let rows = [];
      let stableSince = 0;
      while (Date.now() < deadline) {
        await sleep(300);
        const now = readRows();
        if (now.length && now.length === rows.length) {
          if (!stableSince) stableSince = Date.now();
          if (Date.now() - stableSince > 900) break;
        } else stableSince = 0;
        rows = now;
      }
      if (!isRequestedVideo()) {
        // The page moved to another video while the panel loaded: these rows are not ours.
        out.reason = 'video_mismatch';
      } else {
        out.rows = rows.slice(0, 20000).map((r) => ({ ts: r.ts.trim().slice(0, 12), text: r.text.trim().slice(0, 5000) }));
        out.chapters = [...document.querySelectorAll('timeline-chapter-view-model .ytwTimelineChapterViewModelTitle')]
          .map((h) => ({ start: null, title: h.textContent.trim().slice(0, 200) })).filter((c) => c.title);
        if (!out.rows.length) out.reason = out.reason || 'panel_empty';
      }
    } else {
      out.reason = out.reason || 'no_transcript_button';
    }
  } catch (e) {
    out.reason = out.reason || 'dom_error';
  }
  stopPlayback();
  return out;
})();
