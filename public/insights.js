// insights.js — extra, descriptive views of YOUR data, computed in your browser.
//
// These never decide your drift type (that's the published rules in drift.js).
// They power the timeline chart, the creator view, the habit clock, and the
// "Ask your data" tools that answer questions without sending anything anywhere.

const DAY = 86400000;
const WEEK = 7 * DAY;
const SESSION_GAP_MS = 30 * 60 * 1000;

export const TOPIC_NAMES = {
  news_politics: 'News & politics', commentary_drama: 'Commentary & drama',
  true_crime: 'True crime', gaming: 'Gaming', music: 'Music',
  cooking_food: 'Cooking & food', science_tech: 'Science & tech',
  education_study: 'Study & learning', fitness_health: 'Fitness & health',
  comedy_entertainment: 'Comedy', sports: 'Sports', diy_crafts: 'DIY & crafts',
  finance_money: 'Money & finance', lifestyle_vlog: 'Lifestyle vlogs', other: 'Everything else',
};
export const topicName = (t) => TOPIC_NAMES[t] || t;

function valid(items) {
  return (items || [])
    .map((it) => ({ ...it, t: new Date(it.watchedAt).getTime() }))
    .filter((it) => Number.isFinite(it.t))
    .sort((a, b) => a.t - b.t);
}

/**
 * Week-by-week view: count, average intensity, sessions, and topic mix.
 * @returns {{start:number, label:string, count:number, intensity:number, sessions:number, topics:Object<string,number>}[]}
 */
export function weeklyTimeline(items) {
  const xs = valid(items);
  if (!xs.length) return [];
  const first = xs[0].t;
  const weeks = [];
  for (const it of xs) {
    const w = Math.floor((it.t - first) / WEEK);
    (weeks[w] ||= { items: [] }).items.push(it);
  }
  const out = [];
  for (let w = 0; w < weeks.length; w++) {
    const its = weeks[w]?.items || [];
    const start = first + w * WEEK;
    const topics = {};
    for (const it of its) topics[it.topic || 'other'] = (topics[it.topic || 'other'] || 0) + 1;
    out.push({
      start,
      label: new Date(start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      count: its.length,
      intensity: its.length ? its.reduce((s, x) => s + (Number(x.intensity) || 0), 0) / its.length : null,
      sessions: countSessions(its),
      topics,
    });
  }
  return out;
}

function countSessions(its) {
  if (!its.length) return 0;
  let n = 1;
  for (let i = 1; i < its.length; i++) if (its[i].t - its[i - 1].t > SESSION_GAP_MS) n++;
  return n;
}

/** Which week saw the biggest jump in emotional intensity vs the weeks before it. */
export function turningPoint(weeks) {
  let best = null;
  for (let i = 2; i < weeks.length; i++) {
    const before = weeks.slice(0, i).filter((w) => w.count && w.intensity != null);
    const after = weeks.slice(i).filter((w) => w.count && w.intensity != null);
    if (before.length < 1 || after.length < 1) continue;
    const b = avg(before.map((w) => w.intensity));
    const a = avg(after.map((w) => w.intensity));
    const jump = a - b;
    if (!best || jump > best.jump) best = { index: i, label: weeks[i].label, jump };
  }
  return best && best.jump > 0.03 ? best : null;
}

/** How concentrated your viewing is in a few creators — early half vs late half. */
export function creatorConcentration(items) {
  const xs = valid(items).filter((x) => x.channel);
  if (xs.length < 15) return null;
  const mid = xs[0].t + (xs[xs.length - 1].t - xs[0].t) / 2;
  const share = (arr) => {
    const c = {};
    for (const x of arr) c[x.channel] = (c[x.channel] || 0) + 1;
    const top = Object.entries(c).sort((a, b) => b[1] - a[1]);
    return { top3: top.slice(0, 3).reduce((s, [, n]) => s + n, 0) / (arr.length || 1), distinct: top.length, top };
  };
  const early = share(xs.filter((x) => x.t <= mid));
  const late = share(xs.filter((x) => x.t > mid));
  return {
    earlyTop3: early.top3, lateTop3: late.top3,
    earlyDistinct: early.distinct, lateDistinct: late.distinct,
    lateTop: late.top.slice(0, 5).map(([name, n]) => ({ name, n })),
  };
}

/** 24-hour habit clock: share of watching in each hour, early vs late. */
export function hourProfile(items) {
  const xs = valid(items);
  if (!xs.length) return null;
  const mid = xs[0].t + (xs[xs.length - 1].t - xs[0].t) / 2;
  const mk = () => new Array(24).fill(0);
  const e = mk(), l = mk();
  let ne = 0, nl = 0;
  for (const x of xs) {
    const h = new Date(x.t).getHours();
    if (x.t <= mid) { e[h]++; ne++; } else { l[h]++; nl++; }
  }
  return { early: e.map((c) => c / (ne || 1)), late: l.map((c) => c / (nl || 1)) };
}

/** Topic share in your earlier vs later weeks, for the "what moved" bars. */
export function topicShift(items) {
  const xs = valid(items);
  if (!xs.length) return [];
  const mid = xs[0].t + (xs[xs.length - 1].t - xs[0].t) / 2;
  const e = {}, l = {};
  let ne = 0, nl = 0;
  for (const x of xs) {
    const k = x.topic || 'other';
    if (x.t <= mid) { e[k] = (e[k] || 0) + 1; ne++; } else { l[k] = (l[k] || 0) + 1; nl++; }
  }
  const keys = new Set([...Object.keys(e), ...Object.keys(l)]);
  return [...keys]
    .map((k) => ({ topic: k, early: (e[k] || 0) / (ne || 1), late: (l[k] || 0) / (nl || 1) }))
    .sort((a, b) => Math.max(b.early, b.late) - Math.max(a.early, a.late))
    .slice(0, 7);
}

// ---------------------------------------------------------------------------
// "Ask your data" — tools that answer on your device. Each tool matches a kind
// of question and returns an answer built only from your local data. If none
// match, the question goes to the AI assistant with the small summary only.
// ---------------------------------------------------------------------------
export function askLocal(question, ctx) {
  const q = question.toLowerCase();
  const { items, weeks, drift } = ctx;
  if (!items?.length) return null;
  const xs = valid(items);

  if (/late|night|midnight|after dark|\b(1|2|3|4)\s?am\b/.test(q)) {
    const night = xs.filter((x) => { const h = new Date(x.t).getHours(); return h < 5; });
    if (!night.length) return 'None of your history falls between midnight and 5am.';
    const pct = Math.round((night.length / xs.length) * 100);
    const tops = topTopics(night, 2).map(topicName);
    return `${night.length} of your ${xs.length} watches (${pct}%) happened between midnight and 5am` +
      (tops.length ? `, mostly ${tops.join(' and ').toLowerCase()}.` : '.') +
      ` Here are a few: ${night.slice(-3).map((x) => `"${x.title}"`).join(', ')}.`;
  }
  if (/creator|channel|who do i|which (account|people)/.test(q)) {
    const cc = creatorConcentration(items);
    if (!cc) return 'This file doesn\'t include creator names, so I can\'t break it down by creator.';
    return `In your recent weeks, your top 3 creators made up ${Math.round(cc.lateTop3 * 100)}% of what you watched (earlier it was ${Math.round(cc.earlyTop3 * 100)}%). Most-watched lately: ${cc.lateTop.slice(0, 3).map((c) => `${c.name} (${c.n})`).join(', ')}.`;
  }
  if (/(when|which week).*(change|start|shift|jump)|turning point|started/.test(q)) {
    const tp = turningPoint(weeks);
    return tp
      ? `The clearest shift starts in the week of ${tp.label}: the average emotional intensity of what you watched after that point was ${Math.round(tp.jump * 100)} points higher than before.`
      : 'There isn\'t one clear turning point — the change, if any, was gradual across your weeks.';
  }
  if (/busiest|most (watched|active)|biggest week|peak/.test(q)) {
    const w = [...weeks].sort((a, b) => b.count - a.count)[0];
    return w ? `Your busiest week started ${w.label}, with ${w.count} watches across ${w.sessions} sessions.` : null;
  }
  if (/top topic|most (common|watched) topic|what do i watch|what topics/.test(q)) {
    const tops = topTopics(xs, 3);
    return `Across everything, your top topics are ${tops.map((t) => topicName(t).toLowerCase()).join(', ')}.` +
      (drift?.topClusters?.length ? ` The ones growing most recently: ${drift.topClusters.map((t) => topicName(t).toLowerCase()).join(', ')}.` : '');
  }
  if (/how many|total|count/.test(q)) {
    const sessions = countSessions(xs);
    const days = Math.max(1, Math.round((xs[xs.length - 1].t - xs[0].t) / DAY));
    return `${xs.length} watches over ${days} days, in ${sessions} separate sessions — about ${(sessions / days).toFixed(1)} sessions a day.`;
  }
  if (/intense|calm|calmest|most charged/.test(q)) {
    const sorted = [...xs].sort((a, b) => (b.intensity || 0) - (a.intensity || 0));
    const hi = sorted.slice(0, 3).map((x) => `"${x.title}"`).join(', ');
    const lo = sorted.slice(-3).map((x) => `"${x.title}"`).join(', ');
    return `Most emotionally charged: ${hi}. Calmest: ${lo}.`;
  }
  return null;
}

function topTopics(xs, n) {
  const c = {};
  for (const x of xs) if (x.topic && x.topic !== 'other') c[x.topic] = (c[x.topic] || 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
}
function avg(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
