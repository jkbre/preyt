// YouTube URL helpers shared by background, popup and tests.

export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const YT_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtube-nocookie.com', 'www.youtube-nocookie.com',
]);

/** Context-menu targetUrlPatterns for links that point at a single video. */
export const LINK_PATTERNS = [
  '*://youtube.com/watch*', '*://www.youtube.com/watch*', '*://m.youtube.com/watch*', '*://music.youtube.com/watch*',
  '*://youtube.com/shorts/*', '*://www.youtube.com/shorts/*', '*://m.youtube.com/shorts/*',
  '*://youtube.com/live/*', '*://www.youtube.com/live/*', '*://m.youtube.com/live/*',
  '*://www.youtube.com/embed/*', '*://www.youtube-nocookie.com/embed/*',
  '*://youtu.be/*',
];

/** documentUrlPatterns for "summarize this page" on a watch page. */
export const PAGE_PATTERNS = [
  '*://www.youtube.com/watch*', '*://m.youtube.com/watch*', '*://music.youtube.com/watch*',
  '*://www.youtube.com/shorts/*', '*://m.youtube.com/shorts/*', '*://www.youtube.com/live/*',
];

/**
 * Extract an 11-char video id from any supported YouTube URL, or null.
 * Handles watch?v=, youtu.be/, /shorts/, /live/, /embed/, /v/, attribution_link and
 * Google/YouTube redirect wrappers one level deep.
 */
export function parseVideoId(input, depth = 0) {
  let u;
  try { u = new URL(String(input).trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  const ok = (id) => (id && VIDEO_ID_RE.test(id) ? id : null);

  if (host === 'youtu.be' || host === 'www.youtu.be') {
    return ok(u.pathname.split('/')[1]);
  }
  if (YT_HOSTS.has(host)) {
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'watch') return ok(u.searchParams.get('v'));
    if (['shorts', 'live', 'embed', 'v', 'e'].includes(parts[0])) return ok(parts[1]);
    if (parts[0] === 'attribution_link' && depth < 1) {
      const inner = u.searchParams.get('u');
      return inner ? parseVideoId(new URL(inner, 'https://www.youtube.com').href, depth + 1) : null;
    }
    if (parts[0] === 'redirect' && depth < 1) {
      const q = u.searchParams.get('q');
      return q ? parseVideoId(q, depth + 1) : null;
    }
    return null;
  }
  if ((host === 'www.google.com' || host === 'google.com') && u.pathname === '/url' && depth < 1) {
    const q = u.searchParams.get('url') || u.searchParams.get('q');
    return q ? parseVideoId(q, depth + 1) : null;
  }
  return null;
}

/** Start time from t= / start= (e.g. 90, 90s, 1m30s, 1h2m3s), or null. */
export function parseStartTime(input) {
  let u;
  try { u = new URL(String(input)); } catch { return null; }
  const raw = u.searchParams.get('t') || u.searchParams.get('start') || (u.hash.match(/t=([^&]+)/) || [])[1];
  if (!raw) return null;
  if (/^\d+s?$/.test(raw)) return parseInt(raw, 10);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw);
  if (!m || !(m[1] || m[2] || m[3])) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

export function watchUrl(videoId, seconds = null) {
  if (!VIDEO_ID_RE.test(videoId)) throw new Error('invalid video id');
  const t = Number.isFinite(seconds) && seconds > 0 ? `&t=${Math.floor(seconds)}s` : '';
  return `https://www.youtube.com/watch?v=${videoId}${t}`;
}

export function thumbnailUrl(videoId) {
  return VIDEO_ID_RE.test(videoId) ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : '';
}
