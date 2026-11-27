// Pure parsers for YouTube's "modern transcript" panel and scraped transcript rows.
// Verified against live responses on 2026-11-19 (PAmodern_transcript_view via
// /youtubei/v1/get_panel, requested from inside the page by content/tab-transcript.js).
// The legacy /youtubei/v1/get_transcript endpoint returned HTTP 400 "Precondition check
// failed" from every client tested, so only its response shape is still accepted.

/** Depth-first walk in document order; visitor may return true to skip children. */
export function walk(node, visit) {
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== 'object') continue;
    if (visit(n) === true) continue;
    const vals = Array.isArray(n) ? n : Object.values(n);
    for (let i = vals.length - 1; i >= 0; i--) if (vals[i] && typeof vals[i] === 'object') stack.push(vals[i]);
  }
}

/** "1:02:03" | "12:34" | "0:04" -> seconds, else null. */
export function parseClock(s) {
  const m = /^\s*(?:(\d{1,2}):)?(\d{1,3}):(\d{2})\s*$/.exec(String(s ?? ''));
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

const textOf = (t) => {
  if (!t) return '';
  if (typeof t === 'string') return t;
  if (typeof t.simpleText === 'string') return t.simpleText;
  if (typeof t.content === 'string') return t.content;
  if (Array.isArray(t.runs)) return t.runs.map((r) => r.text ?? '').join('');
  return '';
};

/**
 * Parse a get_panel (modern) or get_transcript (legacy) response.
 * @returns {{segments:{start:number|null,text:string}[], chapters:{start:number,title:string}[]}}
 */
export function parsePanelResponse(json) {
  const segments = [];
  const chapters = [];
  walk(json, (n) => {
    // A section's chapter header is serialised after its rows, so read it up front.
    const sectionHeader = n.itemSectionRenderer?.header?.macroMarkersPanelItemViewModel;
    if (sectionHeader?.item?.timelineChapterViewModel) {
      const startSec = sectionHeader.onTap?.innertubeCommand?.watchEndpoint?.startTimeSeconds;
      const firstRow = (n.itemSectionRenderer.contents ?? []).map((c) => c.macroMarkersPanelItemViewModel).find((m) => m?.item?.timelineItemViewModel);
      const firstStart = firstRow ? (firstRow.onTap?.innertubeCommand?.watchEndpoint?.startTimeSeconds ?? parseClock(firstRow.item.timelineItemViewModel.timestamp)) : null;
      chapters.push({
        start: Number.isFinite(startSec) ? startSec : (chapters.length === 0 ? 0 : (firstStart ?? 0)),
        title: textOf(sectionHeader.item.timelineChapterViewModel.title).trim(),
      });
    }
    const item = n.macroMarkersPanelItemViewModel;
    if (item) {
      const startSec = item.onTap?.innertubeCommand?.watchEndpoint?.startTimeSeconds;
      const tl = item.item?.timelineItemViewModel;
      const ch = item.item?.timelineChapterViewModel;
      if (tl) {
        const text = (tl.contentItems ?? [])
          .map((c) => c.transcriptSegmentViewModel?.simpleText ?? textOf(c.transcriptSegmentViewModel?.text))
          .filter(Boolean).join(' ').trim();
        const start = Number.isFinite(startSec) ? startSec : parseClock(tl.timestamp);
        if (text) segments.push({ start, text });
      } else if (ch && !chapters.some((c) => c.title === textOf(ch.title).trim())) {
        // Chapter outside a section header (not seen in live data, kept for robustness).
        chapters.push({ start: Number.isFinite(startSec) ? startSec : (segments.at(-1)?.start ?? 0), title: textOf(ch.title).trim() });
      }
      return true;
    }
    const legacy = n.transcriptSegmentRenderer;
    if (legacy) {
      const text = textOf(legacy.snippet).trim();
      const ms = Number(legacy.startMs);
      if (text) segments.push({ start: Number.isFinite(ms) ? Math.floor(ms / 100) / 10 : null, text });
      return true;
    }
    return false;
  });
  return { segments: cleanSegments(segments), chapters: chapters.filter((c) => c.title) };
}

/** Rows scraped from the DOM ({ts:"0:04", text}) -> segments. */
export function rowsToSegments(rows) {
  if (!Array.isArray(rows)) return [];
  return cleanSegments(rows.map((r) => ({ start: parseClock(r?.ts), text: String(r?.text ?? '') })));
}

function cleanSegments(segs) {
  const out = [];
  for (const s of segs) {
    const text = s.text.replace(/\s+/g, ' ').replace(/^\[(music|music playing|applause|laughter)\]$/i, '').trim();
    if (!text) continue;
    const prev = out.at(-1);
    if (prev && prev.text === text && prev.start === s.start) continue;
    out.push({ start: s.start, text });
  }
  return out;
}
