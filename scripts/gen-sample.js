// Generates public/sample-data.json — a realistic YouTube history that tells an
// "Emotional Escalation" story: calm/varied early weeks drifting toward intense
// news/commentary, with videos getting shorter and sessions more frequent.
// Deterministic (seeded) so the demo is identical every run (PRD §9).
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

// pools: [titles], channel, [durationRangeSec]
const EARLY = [
  { titles: ['One-Pan Garlic Butter Salmon (easy weeknight recipe)', '15-Minute Fried Rice Anyone Can Make', 'How to Bake Sourdough Without a Starter'], ch: 'WeeknightKitchen', dur: [420, 900] },
  { titles: ['Lo-fi beats to study & relax to', 'Acoustic Covers of 2020s Hits (full album)', 'Live Jazz Session — Late Night Set'], ch: 'MellowSounds', dur: [1800, 3600] },
  { titles: ['iPhone camera settings explained for beginners', 'How solid-state batteries actually work', 'I tried coding for 30 days — honest review'], ch: 'PlainTech', dur: [600, 1100] },
  { titles: ['Full Body Mobility Routine (follow along)', 'Beginner 5k Training — Week 1', 'Relaxing Yoga for Better Sleep'], ch: 'MoveDaily', dur: [900, 1500] },
  { titles: ['The History of the Roman Aqueducts, Explained', 'How Bees Make Decisions — a calm science walk', 'Why the Sky Is Blue (tutorial)'], ch: 'SlowScience', dur: [700, 1300] },
];
const MID = [
  { titles: ['The News You Missed This Week', 'Breaking: What the New Policy Actually Means', 'Senate Hearing Highlights'], ch: 'DailyBrief', dur: [400, 800] },
  { titles: ['Creator Reacts to the Weekend Drama', 'The Truth About That Viral Feud', 'Everyone Is Talking About This — My Take'], ch: 'HotTakeDaily', dur: [300, 700] },
  { titles: ['Top Plays of the Night — Highlights', 'Ranked Gameplay: Insane Comeback', 'Boss Fight Speedrun'], ch: 'ClipCentral', dur: [200, 500] },
];
const LATE = [
  { titles: ['SHOCKING: What They Are NOT Telling You', 'This Is Worse Than Anyone Expected', 'The Truth They Tried to Bury — EXPOSED', 'Everything Is Falling Apart and Nobody Cares'], ch: 'OutrageNow', dur: [120, 300] },
  { titles: ['He DESTROYED Them in This Debate', 'You Won\'t Believe What Happened Next', 'Cancelled: The Full Meltdown', 'Called Out LIVE — Brutal'], ch: 'DramaAlert24', dur: [90, 260] },
  { titles: ['CRISIS: Breaking Update Right Now', 'Emergency Broadcast — Panic in the Markets', 'The War Nobody Is Reporting On'], ch: 'RedAlertNews', dur: [100, 280] },
  { titles: ['Why This Election Could Change Everything — Furious Reactions', 'The Attack Everyone Ignored', 'Never Again: The Full Story'], ch: 'FrontlineFeed', dur: [110, 320] },
];

const items = [];
const DAY = 86400000;
// Anchor at "today" per the app's context date so coverage is a clean ~5 weeks.
const end = new Date('2026-07-12T22:00:00Z').getTime();
const start = end - 35 * DAY;

function emit(dayOffset, pools, nBursts, perBurst) {
  const dayStart = start + dayOffset * DAY;
  for (let b = 0; b < nBursts; b++) {
    // Later weeks skew toward late-night bursts.
    const hour = dayOffset > 24 && rnd() < 0.4 ? Math.floor(rnd() * 4) : 9 + Math.floor(rnd() * 13);
    const burstStart = dayStart + hour * 3600000 + Math.floor(rnd() * 1800000);
    const count = perBurst[0] + Math.floor(rnd() * (perBurst[1] - perBurst[0] + 1));
    for (let i = 0; i < count; i++) {
      const p = pick(pools);
      const dur = p.dur[0] + Math.floor(rnd() * (p.dur[1] - p.dur[0]));
      items.push({
        title: pick(p.titles),
        channel: p.ch,
        durationSec: dur,
        watchedAt: new Date(burstStart + i * (dur * 1000 + 60000)).toISOString(),
      });
    }
  }
}

for (let d = 0; d <= 35; d++) {
  if (d < 12) {                 // weeks 1-2: calm, varied, few long sessions
    if (rnd() < 0.7) emit(d, EARLY, 1, [1, 2]);
  } else if (d < 24) {          // weeks 3-4: news/commentary creeps in
    emit(d, [...EARLY, ...MID, ...MID], 1 + (rnd() < 0.5 ? 1 : 0), [2, 3]);
  } else {                      // weeks 5: shorter, hotter, more frequent bursts
    emit(d, [...MID, ...LATE, ...LATE], 2 + (rnd() < 0.6 ? 1 : 0), [3, 5]);
  }
}

const data = {
  source: 'youtube',
  grabbedAt: new Date(end).toISOString(),
  note: 'Sample data — a fictional history for demoing Drift. Not a real person.',
  count: items.length,
  items,
};

mkdirSync(path.join(__dirname, '..', 'public'), { recursive: true });
writeFileSync(path.join(__dirname, '..', 'public', 'sample-data.json'), JSON.stringify(data, null, 2));
console.log(`wrote public/sample-data.json — ${items.length} items over ~35 days`);
