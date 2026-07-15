// normalize.js — turning whatever history file you drop in into clean, dated items.
//
// This is data PREP, not judgment: the published drift rules live in drift.js.
// It exists because real history exports are messy in three specific ways:
//   1. YouTube's on-page date headers are year-less ("Jul 10") or weekday names
//      ("Saturday"). JavaScript parses "Jul 10" as July 10, 2001 — so a naive
//      parse either poisons the file with 2001 dates or collapses everything to
//      "today". Either way a 120-video grab used to read as "not enough data".
//   2. Files saved by an OLD copy of the bookmarklet (a bookmark keeps the
//      script it was dragged with) still contain those bad dates.
//   3. Google Takeout's watch-history.json is a completely different shape.
// Everything here runs in your browser; nothing is sent anywhere.

const MIN_T = new Date('2005-02-01').getTime(); // YouTube did not exist before this
const DAY_MS = 86400000;
const MONTH_IDX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const DAY_IDX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/**
 * Parse the date labels history pages actually show — "Today", "Yesterday",
 * "Saturday", "Jul 10", "Wednesday, July 8", "May 28, 2026", "12/07/2026" —
 * into an ISO string, or null if the label isn't a recognisable date.
 * Year-less dates are anchored to the current year (or the previous one if
 * that would land in the future) — NOT to 2001, which is what new Date() does.
 * @param {string} label   @param {Date} now  injectable for deterministic tests
 */
export function parseFlexibleDate(label, now = new Date()) {
  if (!label) return null;
  const l = String(label).toLowerCase().replace(/\s+/g, ' ').trim();
  const maxT = now.getTime() + DAY_MS;
  const d = new Date(now.getTime());

  if (l.includes('today')) return d.toISOString();
  if (l.includes('yesterday')) { d.setDate(d.getDate() - 1); return d.toISOString(); }

  // Bare weekday ("Saturday") — the page's header for days within the last week.
  // Today would say "Today", so this is the most recent such day BEFORE today.
  const wd = l.match(/^(sun|mon|tue|wed|thu|fri|sat)[a-z]*$/);
  if (wd) {
    const back = (now.getDay() - DAY_IDX[wd[1]] + 7) % 7 || 7;
    d.setDate(d.getDate() - back);
    return d.toISOString();
  }

  // Month + day, either order, year optional ("jul 10" / "10 jul" / "friday, july 11, 2025").
  let m = l.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})\b/);
  if (!m) {
    const m2 = l.match(/\b(\d{1,2})\.? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/);
    if (m2) m = [m2[0], m2[2], m2[1]];
  }
  if (m) {
    const ym = l.match(/\b(20\d{2})\b/);
    // Noon, not midnight, so timezone conversion can't slip it to the wrong day.
    const dt = new Date(ym ? +ym[1] : now.getFullYear(), MONTH_IDX[m[1]], +m[2], 12, 0, 0);
    if (!ym && dt.getTime() > maxT) dt.setFullYear(dt.getFullYear() - 1);
    if (!isNaN(dt.getTime()) && dt.getTime() >= MIN_T && dt.getTime() <= maxT) return dt.toISOString();
    return null;
  }

  // Numeric formats (12/07/2026), last resort — locale-dependent, best effort.
  if (/\b\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}\b/.test(l)) {
    const dt = new Date(l);
    if (!isNaN(dt.getTime()) && dt.getTime() >= MIN_T && dt.getTime() <= maxT) return dt.toISOString();
  }
  return null;
}

// Google Takeout can hold many years of watches; we analyse the most recent
// slice (newest first). Matches the server's own per-analysis labeling cap.
export const TAKEOUT_MAX_ITEMS = 1000;

// The bookmarklet sometimes captures a card's duration overlay ("9:30:00", "2:55")
// or a stray UI marker ("SHORTS SHORTS Now playing") as if it were a video title.
// These aren't real titles — they'd be mislabeled "other" and quietly skew the
// topic mix — so we drop them before anything is analysed. A real title is never
// just a timestamp. Kept deliberately narrow so genuine short titles survive.
const JUNK_TITLE = /^(\d{1,2}:\d{2}(:\d{2})?|shorts shorts now playing|now playing|shorts)$/i;
export function isRealTitle(title) {
  const t = String(title || '').trim();
  return t.length > 0 && !JUNK_TITLE.test(t);
}

/**
 * Keep only items that carry a real title. Used by both file paths so the
 * bookmarklet's duration-overlay noise never reaches the labeler or the rules.
 */
export function cleanItems(items) {
  return (items || []).filter((it) => it && isRealTitle(it.title));
}

/**
 * Accept every history file shape we know and return {source, items, ...}:
 *   - the bookmarklet's own file: { source, items: [...] }
 *   - Google Takeout's watch-history.json: a bare ARRAY of activity records
 *     like { title: "Watched X", titleUrl: "…/watch?v=…", subtitles: [{name}], time: ISO }
 * Returns null when the JSON is neither.
 */
export function normalizeHistoryFile(json) {
  if (json && Array.isArray(json.items)) {
    return { source: json.source || 'youtube', items: json.items };
  }
  if (Array.isArray(json)) {
    const all = [];
    for (const r of json) {
      if (!r || typeof r.title !== 'string' || typeof r.time !== 'string') continue;
      // Only real video views — this skips ads, "Visited …" pages, and removed
      // videos ("Watched a video that has been removed" carries no titleUrl).
      if (!/youtube\.com\/(watch|shorts)|youtu\.be\//.test(r.titleUrl || '')) continue;
      const title = r.title.replace(/^watched\s+/i, '').trim();
      if (!title) continue;
      all.push({
        title,
        channel: (Array.isArray(r.subtitles) && r.subtitles[0] && r.subtitles[0].name) || '',
        durationSec: 0, // Takeout doesn't include durations (engagement drift needs the bookmarklet)
        watchedAt: r.time,
      });
    }
    if (all.length) {
      return { source: 'youtube', items: all.slice(0, TAKEOUT_MAX_ITEMS), takeout: true, totalCount: all.length };
    }
  }
  return null;
}

// A timeline is only credible if at least 15 items — and at least half the
// file — carry plausible dates spanning MIN_REAL_DAYS. That's exactly what
// computeDrift needs, so a file that passes here can never come back
// "insufficient"; anything that fails is rescued below instead of refused.
const MIN_REAL_DAYS = 10;

/**
 * Make any decent-sized history analysable, whatever happened to its dates.
 * Handles both known corruptions: every item stamped "today" (missed headers)
 * and items stamped 2001 (year-less labels through a stale bookmarklet).
 *   - credible timeline → kept untouched; stray junk dates snap to a valid
 *     neighbour so no items are silently dropped by the rules.
 *   - not credible → items are spread evenly, IN ORDER (files are newest-first),
 *     across the last 30 days and the result is flagged estimated so the report
 *     says so and never claims high confidence.
 * @param {{watchedAt:string}[]} items  mutated in place
 * @param {number} nowMs  injectable for deterministic tests
 */
export function ensureUsableTimeline(items, nowMs = Date.now()) {
  const maxT = nowMs + DAY_MS;
  const valid = (t) => Number.isFinite(t) && t >= MIN_T && t <= maxT;
  const times = items.map((it) => new Date(it.watchedAt).getTime());
  const good = times.filter(valid);
  const spanDays = good.length ? (Math.max(...good) - Math.min(...good)) / DAY_MS : 0;
  const credible = good.length >= Math.max(15, items.length * 0.5) && spanDays >= MIN_REAL_DAYS;

  if (credible) {
    let last = good[0];
    items.forEach((it, i) => {
      if (valid(times[i])) last = times[i];
      else it.watchedAt = new Date(last).toISOString();
    });
    return { items, estimated: false };
  }
  if (items.length >= 15) {
    const windowMs = 30 * DAY_MS, n = items.length;
    items.forEach((it, i) => {
      const frac = n > 1 ? i / (n - 1) : 0; // 0 = newest (top of the file)
      it.watchedAt = new Date(nowMs - frac * windowMs).toISOString();
    });
    return { items, estimated: true };
  }
  return { items, estimated: false }; // genuinely tiny file — let the rules refuse honestly
}
