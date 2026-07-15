// drift.js — the fixed, published drift rules (PRD §4.4).
//
// This is PLAIN MATH, not AI. It runs entirely in your browser. Given the same file
// it always returns the same answer, and anyone can read exactly how it decides.
//
// Thresholds (published, versioned):
//   Narrowing   : distinct topics shrink  > 15% (late weeks vs early weeks)
//   Escalation  : avg emotional intensity  > 10% higher
//   Engagement  : avg video length  > 20% shorter  AND  sessions/week  > 25% more frequent
//
// If none of these clear their threshold → "Mixed / unclear" (honest, PRD §11.4).
// If there isn't enough data → "insufficient" (PRD §11.6) — we refuse to classify.

export const RULES_VERSION = '3.1';
export const THRESHOLDS = { narrowing: 0.15, escalation: 0.10, engagementShorter: 0.20, engagementMoreOften: 0.25 };
const MIN_ITEMS = 15;      // fewer than this and we won't classify
const MIN_DAYS = 10;       // less coverage than this and we won't classify
const SESSION_GAP_MS = 30 * 60 * 1000; // >30 min gap = a new watch session

/**
 * @param {{title,topic,intensity,durationSec,watchedAt}[]} items  cleaned + labeled
 * @returns {object} drift result consumed by agent.writeReport()
 */
export function computeDrift(items) {
  // Reject implausible timestamps outright: nothing before YouTube existed and
  // nothing in the future. A single garbage date (a mis-parsed title, a stray
  // year) would otherwise inflate coverageDays into the thousands and make every
  // derived percentage nonsense ("9162 days of history", "1433% more sessions").
  const MIN_T = new Date('2005-02-01').getTime();
  const MAX_T = Date.now() + 2 * 86400000;
  const clean = (items || [])
    .filter((it) => {
      if (!it || !it.watchedAt) return false;
      const t = new Date(it.watchedAt).getTime();
      return Number.isFinite(t) && t >= MIN_T && t <= MAX_T;
    })
    .map((it) => ({
      topic: it.topic || 'other',
      intensity: num(it.intensity, 0.35),
      durationSec: num(it.durationSec, 0),
      t: new Date(it.watchedAt).getTime(),
    }))
    .sort((a, b) => a.t - b.t);

  const coverageDays = clean.length
    ? Math.round((clean[clean.length - 1].t - clean[0].t) / 86400000)
    : 0;

  if (clean.length < MIN_ITEMS || coverageDays < MIN_DAYS) {
    return { type: 'insufficient', confidence: 'none', coverageDays, itemCount: clean.length, weeks: 0, percent: 0, driftScore: null, severity: 'none', topClusters: [], habitChanges: [], metric: '', startDate: '' };
  }

  // Split the timeline in half: "early" baseline vs "late" recent.
  const mid = clean[0].t + (clean[clean.length - 1].t - clean[0].t) / 2;
  const early = clean.filter((x) => x.t <= mid);
  const late = clean.filter((x) => x.t > mid);
  const safeEarly = early.length ? early : clean.slice(0, Math.ceil(clean.length / 2));
  const safeLate = late.length ? late : clean.slice(Math.ceil(clean.length / 2));

  const eTopics = distinctTopics(safeEarly);
  const lTopics = distinctTopics(safeLate);
  const eInt = avg(safeEarly.map((x) => x.intensity));
  const lInt = avg(safeLate.map((x) => x.intensity));
  const eDur = avg(safeEarly.filter((x) => x.durationSec > 0).map((x) => x.durationSec));
  const lDur = avg(safeLate.filter((x) => x.durationSec > 0).map((x) => x.durationSec));
  const eSess = sessionsPerWeek(safeEarly);
  const lSess = sessionsPerWeek(safeLate);

  // Signed changes (positive = "more" in the drift direction).
  const narrowingChange = eTopics ? (eTopics - lTopics) / eTopics : 0;   // topics shrinking
  const escalationChange = eInt ? (lInt - eInt) / eInt : 0;              // intensity rising
  const shorterChange = eDur ? (eDur - lDur) / eDur : 0;                 // videos shorter
  const moreOftenChange = eSess ? (lSess - eSess) / eSess : 0;           // sessions more frequent

  // ---- Drift Score: ONE number, 0-100, for "how much did my recent weeks move
  // from my own earlier weeks?" It is a MAGNITUDE, never a verdict of good/bad —
  // narrowing or escalation aren't "bad", they're just measurable. Each of the
  // three dimensions is normalized to its OWN published threshold so they're
  // comparable, then the strongest one sets the score on a saturating curve:
  //   at the threshold (mag 1) → 50   ·   2× → 67   ·   3× → 75   ·   extreme → 100.
  // A small bump is added when several dimensions drift at once (a broader shift
  // than any single signal shows). Everything here is auditable arithmetic.
  const mags = [
    Math.max(0, narrowingChange) / THRESHOLDS.narrowing,
    Math.max(0, escalationChange) / THRESHOLDS.escalation,
    Math.min(Math.max(0, shorterChange) / THRESHOLDS.engagementShorter,
             Math.max(0, moreOftenChange) / THRESHOLDS.engagementMoreOften),
  ];
  const topMag = Math.max(0, ...mags);
  const firing = mags.filter((m) => m >= 1).length;
  let driftScore = Math.round(100 * topMag / (topMag + 1));
  if (firing >= 2) driftScore = Math.min(100, driftScore + 5 * (firing - 1));
  const severity = severityFor(driftScore);

  const candidates = [];
  if (narrowingChange > THRESHOLDS.narrowing) {
    candidates.push({ type: 'narrowing', metric: 'distinct topics', percent: pct(narrowingChange), score: narrowingChange / THRESHOLDS.narrowing });
  }
  if (escalationChange > THRESHOLDS.escalation) {
    candidates.push({ type: 'escalation', metric: 'emotional intensity', percent: pct(escalationChange), score: escalationChange / THRESHOLDS.escalation });
  }
  if (shorterChange > THRESHOLDS.engagementShorter && moreOftenChange > THRESHOLDS.engagementMoreOften) {
    candidates.push({ type: 'engagement', metric: 'video length', percent: pct(shorterChange), score: Math.min(shorterChange / THRESHOLDS.engagementShorter, moreOftenChange / THRESHOLDS.engagementMoreOften) });
  }

  const weeks = Math.max(1, Math.round(coverageDays / 7));
  const startDate = fmtDate(safeLate[0].t);
  const topClusters = dominantShiftTopics(safeEarly, safeLate);
  const habitChanges = describeHabits({ eDur, lDur, eSess, lSess, late: safeLate });

  if (!candidates.length) {
    return { type: 'mixed', confidence: confidenceFor(clean.length, coverageDays, 0), coverageDays, itemCount: clean.length, weeks, percent: 0, driftScore, severity, metric: '', startDate, topClusters, habitChanges };
  }

  candidates.sort((a, b) => b.score - a.score);
  const win = candidates[0];
  return {
    type: win.type,
    metric: win.metric,
    percent: win.percent,
    driftScore,
    severity,
    startDate,
    weeks,
    coverageDays,
    itemCount: clean.length,
    confidence: confidenceFor(clean.length, coverageDays, win.score),
    topClusters,
    habitChanges,
    allSignals: candidates.map((c) => ({ type: c.type, percent: c.percent })),
  };
}

// Score → plain-language band. Deliberately about STRENGTH of the shift, not
// good/bad: Drift compares you only to your own earlier weeks.
export function severityFor(score) {
  if (score == null) return 'none';
  if (score >= 67) return 'strong';
  if (score >= 34) return 'moderate';
  if (score > 0) return 'subtle';
  return 'flat';
}

// --- pieces -----------------------------------------------------------------

function distinctTopics(items) {
  // Count topics that make up at least 8% of viewing — ignores one-off noise.
  const counts = tally(items.map((x) => x.topic));
  const n = items.length;
  return Object.values(counts).filter((c) => c / n >= 0.08).length;
}

function dominantShiftTopics(early, late) {
  const e = share(tally(early.map((x) => x.topic)), early.length);
  const l = share(tally(late.map((x) => x.topic)), late.length);
  const topics = new Set([...Object.keys(e), ...Object.keys(l)]);
  return [...topics]
    .map((tp) => ({ tp, gain: (l[tp] || 0) - (e[tp] || 0), lateShare: l[tp] || 0 }))
    .sort((a, b) => (b.gain - a.gain) || (b.lateShare - a.lateShare))
    .filter((x) => (x.lateShare || 0) > 0.05)
    .slice(0, 3)
    .map((x) => x.tp);
}

function sessionsPerWeek(items) {
  if (!items.length) return 0;
  const ts = items.map((x) => x.t).sort((a, b) => a - b);
  let sessions = 1;
  for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] > SESSION_GAP_MS) sessions++;
  const days = Math.max(1, (ts[ts.length - 1] - ts[0]) / 86400000);
  return sessions / (days / 7);
}

function describeHabits({ eDur, lDur, eSess, lSess, late }) {
  const out = [];
  if (eDur > 0 && lDur > 0) {
    const d = (eDur - lDur) / eDur;
    if (d > 0.12) out.push(`Your videos got about ${pct(d)}% shorter than your earlier weeks.`);
    else if (d < -0.12) out.push(`Your videos got about ${pct(-d)}% longer than your earlier weeks.`);
  }
  if (eSess > 0 && lSess > 0) {
    const s = (lSess - eSess) / eSess;
    if (s > 0.15) out.push(`You opened ${pct(s)}% more separate watch sessions per week.`);
    else if (s < -0.15) out.push(`You opened ${pct(-s)}% fewer separate watch sessions per week.`);
  }
  const lateNight = late.filter((x) => { const h = new Date(x.t).getHours(); return h >= 0 && h < 5; }).length;
  if (late.length && lateNight / late.length > 0.18) {
    out.push(`More of your recent watching happened after midnight.`);
  }
  return out;
}

function confidenceFor(itemCount, coverageDays, score) {
  let s = 0;
  if (itemCount >= 60) s += 2; else if (itemCount >= 30) s += 1;
  if (coverageDays >= 28) s += 2; else if (coverageDays >= 18) s += 1;
  if (score >= 2) s += 1;
  return s >= 4 ? 'high' : s >= 2 ? 'medium' : 'low';
}

// --- utils ------------------------------------------------------------------
function num(x, d) { const n = Number(x); return Number.isFinite(n) ? n : d; }
function avg(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function tally(a) { const o = {}; for (const x of a) o[x] = (o[x] || 0) + 1; return o; }
function share(counts, n) { const o = {}; for (const k in counts) o[k] = counts[k] / (n || 1); return o; }
function pct(x) { return Math.round(x * 100); }
function fmtDate(t) { return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
