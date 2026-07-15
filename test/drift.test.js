// Minimal check that the drift rules are deterministic and catch escalation —
// plus the normalize layer that makes real-world (messy-dated) files analysable.
import { computeDrift } from '../public/drift.js';
import { parseFlexibleDate, normalizeHistoryFile, ensureUsableTimeline, cleanItems, isRealTitle, TAKEOUT_MAX_ITEMS } from '../public/normalize.js';
import { mockLabel } from '../agent.js';
import { readFileSync } from 'node:fs';

const sample = JSON.parse(readFileSync(new URL('../public/sample-data.json', import.meta.url)));
const labeled = sample.items.map((it, i) => {
  const { topic, intensity } = mockLabel({ id: i, title: it.title });
  return { title: it.title, topic, intensity, durationSec: it.durationSec, watchedAt: it.watchedAt };
});

const a = computeDrift(labeled);
const b = computeDrift(labeled);

let pass = true;
function assert(cond, msg) { if (!cond) { pass = false; console.error('  ✗', msg); } else console.log('  ✓', msg); }

assert(JSON.stringify(a) === JSON.stringify(b), 'same input → identical output (deterministic)');
assert(a.type !== 'insufficient', `classified the sample (got "${a.type}", ${a.percent}%)`);
assert(['escalation', 'engagement', 'narrowing', 'mixed'].includes(a.type), 'returns a known drift type');
assert(a.confidence && ['low', 'medium', 'high'].includes(a.confidence), `has confidence: ${a.confidence}`);
assert(computeDrift([]).type === 'insufficient', 'empty input → insufficient (honest)');

// ---- parseFlexibleDate: the year-less / weekday headers YouTube really shows ----
const NOW = new Date('2026-07-14T18:00:00'); // a Tuesday
const day = (iso) => (iso || '').slice(0, 10);
assert(day(parseFlexibleDate('Today', NOW)) === '2026-07-14', '"Today" → today');
assert(day(parseFlexibleDate('Jul 10', NOW)) === '2026-07-10', '"Jul 10" (year-less) → THIS year, not 2001');
assert(day(parseFlexibleDate('Saturday', NOW)) === '2026-07-11', '"Saturday" → most recent Saturday');
assert(day(parseFlexibleDate('Wednesday, July 8', NOW)) === '2026-07-08', '"Wednesday, July 8" → July 8 this year');
assert(day(parseFlexibleDate('Dec 30', NOW)) === '2025-12-30', 'future year-less date rolls back a year');
assert(day(parseFlexibleDate('May 28, 2026', NOW)) === '2026-05-28', 'explicit year kept');
assert(parseFlexibleDate('2001: A Space Odyssey ‐ full movie', NOW) === null, 'a title is not a date');

// ---- the exact bug from the field: 120 videos, every date collapsed to "today" ----
const collapsed = Array.from({ length: 120 }, (_, i) => ({
  topic: ['gaming', 'music', 'news_politics'][i % 3], intensity: 0.4,
  durationSec: 300, watchedAt: new Date().toISOString(),
}));
const rescued = ensureUsableTimeline(collapsed);
const rescuedDrift = computeDrift(rescued.items);
assert(rescued.estimated === true, 'all-today file is flagged "dates estimated"');
assert(rescuedDrift.type !== 'insufficient', `120 all-today videos never read "not enough data" (got "${rescuedDrift.type}")`);

// ---- stale-bookmarklet corruption: most dates parsed into the year 2001 ----
const poisoned = Array.from({ length: 120 }, (_, i) => ({
  topic: 'gaming', intensity: 0.4, durationSec: 300,
  watchedAt: i < 100 ? '2001-07-10T12:00:00Z' : new Date().toISOString(),
}));
const healed = ensureUsableTimeline(poisoned);
assert(healed.estimated === true, '2001-poisoned file gets rescued, not refused');
assert(computeDrift(healed.items).type !== 'insufficient', '2001-poisoned file still classifies');

// ---- a credible real timeline is left untouched ----
const real = Array.from({ length: 40 }, (_, i) => ({
  topic: 'music', intensity: 0.3, durationSec: 300,
  watchedAt: new Date(Date.now() - i * 86400000).toISOString(),
}));
const before = JSON.stringify(real.map((x) => x.watchedAt));
const kept = ensureUsableTimeline(real);
assert(kept.estimated === false && JSON.stringify(real.map((x) => x.watchedAt)) === before, 'real multi-day timeline untouched');

// ---- junk-title filter: duration overlays the bookmarklet mis-grabs ----
assert(isRealTitle('Rohit Sharma the GOAT') === true, 'a real title survives');
assert(isRealTitle('9:30:00') === false, 'pure duration "9:30:00" is junk');
assert(isRealTitle('2:55') === false, 'pure duration "2:55" is junk');
assert(isRealTitle('SHORTS SHORTS Now playing') === false, 'the "Now playing" UI marker is junk');
assert(isRealTitle('19:04') === false, 'pure duration "19:04" is junk');
assert(isRealTitle('') === false, 'empty title is junk');
assert(isRealTitle('May 22, 2026') === false, 'a grabbed date header is junk');
assert(isRealTitle('Jul 10') === false, 'a year-less date header is junk');
assert(isRealTitle('Today') === false, '"Today" header is junk');
assert(isRealTitle('#shorts') === true, 'hashtag-only titles are real (genuine Shorts titles)');
assert(isRealTitle('May the force be with you') === true, 'titles STARTING with a month word survive');
const mixedBag = cleanItems([
  { title: '9:30:00' }, { title: 'Real video title here' }, { title: '2:55' }, { title: 'Another real one' },
]);
assert(mixedBag.length === 2, `cleanItems drops the durations, keeps real titles (${mixedBag.length}/2)`);

// ---- Google Takeout watch-history.json (the no-scroll path) ----
const takeout = Array.from({ length: 30 }, (_, i) => ({
  header: 'YouTube', title: `Watched Video number ${i}`,
  titleUrl: `https://www.youtube.com/watch?v=id${i}`,
  subtitles: [{ name: `Channel ${i % 5}`, url: 'https://…' }],
  time: new Date(Date.now() - i * 2 * 86400000).toISOString(),
}));
takeout.push({ header: 'YouTube', title: 'Watched a video that has been removed', time: new Date().toISOString() });
takeout.push({ header: 'YouTube', title: 'Visited some page', titleUrl: 'https://www.youtube.com/channel/x', time: new Date().toISOString() });
const nt = normalizeHistoryFile(takeout);
assert(nt && nt.takeout === true && nt.items.length === 30, `Takeout array recognised, junk rows skipped (${nt?.items.length} items)`);
assert(nt.items[0].title === 'Video number 0', '"Watched " prefix stripped from titles');
assert(nt.items[0].channel === 'Channel 0', 'channel name mapped from subtitles');
assert(normalizeHistoryFile({ source: 'youtube', items: [{ title: 'x' }] }).items.length === 1, 'bookmarklet file shape passes through');
assert(normalizeHistoryFile({ nonsense: true }) === null, 'unknown JSON → null (friendly error upstream)');
const huge = Array.from({ length: TAKEOUT_MAX_ITEMS + 500 }, (_, i) => ({
  header: 'YouTube', title: `Watched v${i}`, titleUrl: 'https://www.youtube.com/watch?v=a', time: new Date().toISOString(),
}));
assert(normalizeHistoryFile(huge).items.length === TAKEOUT_MAX_ITEMS, `huge Takeout capped at newest ${TAKEOUT_MAX_ITEMS}`);

console.log(`\ndrift rules + normalize: ${pass ? 'ALL PASS' : 'FAILURES'} — sample classified as "${a.type}" (+${a.percent}% ${a.metric}), ${a.confidence} confidence, ${a.coverageDays}d`);
process.exit(pass ? 0 : 1);
