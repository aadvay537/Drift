// agent.js — Drift's AI agent (PRD §4, §5)
//
// Three roles, deliberately separated:
//   1. Labeler      — reads each cleaned title, tags topic + emotional intensity.
//   2. Report writer — turns the (browser-computed) drift result into plain prose.
//   3. Tone checker  — a SECOND pass that refuses scare-words, causal claims, comparisons.
//
// The AI *reads and writes*. It never *judges* your drift type — that is decided by
// fixed math in the browser (see public/drift.js). If the tone check fails twice, we
// serve a pre-written fallback instead. If there is no API key, the whole agent runs
// in a deterministic mock mode so the site still demos end-to-end.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.DRIFT_MODEL || 'claude-sonnet-5';
const hasKey = !!process.env.ANTHROPIC_API_KEY;
const client = hasKey ? new Anthropic() : null;

export const agentMode = hasKey ? 'live' : 'mock';

// ---------------------------------------------------------------------------
// Topic vocabulary — fixed, published, auditable. The labeler must map every
// title to exactly one of these. Keeping it closed makes drift math stable.
// ---------------------------------------------------------------------------
export const TOPICS = [
  'news_politics', 'commentary_drama', 'true_crime', 'gaming',
  'music', 'cooking_food', 'science_tech', 'education_study',
  'fitness_health', 'comedy_entertainment', 'sports', 'diy_crafts',
  'finance_money', 'lifestyle_vlog', 'other',
];

// ---------------------------------------------------------------------------
// 1. LABELER
// ---------------------------------------------------------------------------

/**
 * Label cleaned titles with { topic, intensity }.
 * intensity is 0..1 — how emotionally charged the *content* is, not the viewer.
 * @param {{id:string,title:string}[]} items  cleaned titles only — no channels, no PII
 * @returns {Promise<{id:string,topic:string,intensity:number,skipped?:boolean}[]>}
 */
export async function labelItems(items) {
  if (!items?.length) return [];
  if (!hasKey) return items.map((it) => mockLabel(it));

  // Batch to keep each request small and cheap (PRD §9: < $0.15 / analysis).
  const batches = chunk(items, 40);
  const out = [];
  for (const batch of batches) {
    try {
      out.push(...(await labelBatchLive(batch)));
    } catch (err) {
      // Any failure degrades gracefully to the deterministic labeler.
      console.warn('[agent] labeler fell back to mock:', err.message);
      out.push(...batch.map(mockLabel));
    }
  }
  return out;
}

async function labelBatchLive(batch) {
  const list = batch.map((it) => `${it.id}\t${it.title}`).join('\n');
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 3500, // headroom for a thinking block + 40 JSON objects
    system:
      'You label short video/post titles for a media-literacy tool. ' +
      'For each line "<id>\\t<title>", output one JSON object ' +
      '{"id","topic","intensity"}. ' +
      `topic MUST be one of: ${TOPICS.join(', ')}. ` +
      'intensity is 0.0-1.0 = how emotionally charged / outrage-driven / sensational the CONTENT is ' +
      '(calm explainer 0.1, neutral news 0.4, ragebait or shocking drama 0.9). ' +
      'Judge the content, never the viewer. If a title is too vague, use "other" and intensity 0.3. ' +
      'Output ONLY a JSON array, no prose.',
    messages: [{ role: 'user', content: list }],
  });
  const text = msg.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  const arr = JSON.parse(extractJson(text));
  const byId = new Map(arr.map((o) => [String(o.id), o]));
  return batch.map((it) => {
    const o = byId.get(String(it.id));
    if (!o || !TOPICS.includes(o.topic)) return mockLabel(it);
    return { id: it.id, topic: o.topic, intensity: clamp01(Number(o.intensity)) };
  });
}

// Deterministic keyword labeler — used in mock mode and as the live fallback.
// Same title always yields the same label (PRD §9: "same file, same result").
const TOPIC_KEYWORDS = {
  news_politics: ['news', 'election', 'president', 'senate', 'policy', 'war', 'protest', 'government', 'political', 'breaking'],
  commentary_drama: ['exposed', 'drama', 'reacts', 'response', 'cancelled', 'beef', 'called out', 'the truth about', 'destroyed', 'owns'],
  true_crime: ['murder', 'killer', 'case', 'crime', 'disappearance', 'detective', 'unsolved', 'serial'],
  gaming: ['gameplay', 'speedrun', 'minecraft', 'fortnite', 'boss', 'playthrough', 'gaming', 'noob', 'ranked'],
  music: ['official video', 'lyrics', 'live performance', 'album', 'song', 'remix', 'cover', 'ft.', 'audio'],
  cooking_food: ['recipe', 'cooking', 'bake', 'kitchen', 'meal', 'dinner', 'easy', 'homemade', 'chef'],
  science_tech: ['review', 'iphone', 'unboxing', 'ai', 'coding', 'explained', 'how it works', 'physics', 'space', 'tech'],
  education_study: ['study', 'lecture', 'tutorial', 'learn', 'course', 'math', 'history of', 'how to learn', 'exam'],
  fitness_health: ['workout', 'gym', 'fitness', 'diet', 'abs', 'run', 'yoga', 'health', 'weight'],
  comedy_entertainment: ['funny', 'comedy', 'sketch', 'meme', 'prank', 'try not to laugh', 'stand up'],
  sports: ['highlights', 'match', 'goal', 'nba', 'football', 'soccer', 'game recap', 'tournament'],
  diy_crafts: ['diy', 'craft', 'build', 'woodworking', 'restoration', 'how i made'],
  finance_money: ['stocks', 'crypto', 'invest', 'money', 'passive income', 'millionaire', 'side hustle', 'trading'],
  lifestyle_vlog: ['vlog', 'day in my life', 'morning routine', 'grwm', 'haul', 'apartment tour'],
};
const HIGH_INTENSITY = ['shocking', 'insane', 'destroyed', 'exposed', 'you won\'t believe', 'gone wrong', 'crisis', 'outrage', 'ragebait', 'terrifying', 'worst', 'never again', 'the truth', 'lies', 'cancelled', 'war', 'attack', 'meltdown', 'brutal', 'furious', 'panic', 'emergency'];
const LOW_INTENSITY = ['relaxing', 'calm', 'tutorial', 'explained', 'how to', 'guide', 'lofi', 'asmr', 'study', 'recipe', 'review'];

export function mockLabel(it) {
  const t = (it.title || '').toLowerCase();
  let topic = 'other';
  let best = 0;
  for (const [tp, kws] of Object.entries(TOPIC_KEYWORDS)) {
    const hits = kws.reduce((n, k) => n + (t.includes(k) ? 1 : 0), 0);
    if (hits > best) { best = hits; topic = tp; }
  }
  // Base intensity by topic, nudged by charged words in the title.
  const base = {
    news_politics: 0.55, commentary_drama: 0.7, true_crime: 0.65, finance_money: 0.5,
    gaming: 0.4, sports: 0.45, comedy_entertainment: 0.35, music: 0.3,
    science_tech: 0.3, cooking_food: 0.2, education_study: 0.2, fitness_health: 0.35,
    diy_crafts: 0.25, lifestyle_vlog: 0.3, other: 0.35,
  }[topic];
  let intensity = base;
  for (const w of HIGH_INTENSITY) if (t.includes(w)) intensity += 0.12;
  for (const w of LOW_INTENSITY) if (t.includes(w)) intensity -= 0.1;
  return { id: it.id, topic, intensity: clamp01(intensity) };
}

// ---------------------------------------------------------------------------
// 2 + 3. REPORT WRITER  →  TONE CHECKER  (with fallback)
// ---------------------------------------------------------------------------

/**
 * Write the report from the browser-computed drift result, then tone-check it.
 * @param {object} drift  output of computeDrift() from public/drift.js
 * @returns {Promise<{headline,driving,changed,tryThis,toneChecked:boolean,source:string}>}
 */
export async function writeReport(drift) {
  if (drift.type === 'insufficient') return insufficientReport(drift);
  if (!hasKey) {
    const draft = mockReport(drift);
    return { ...draft, toneChecked: true, source: 'mock' };
  }
  // Up to two attempts; each is tone-checked. Fail twice → pre-written fallback.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const draft = await writeReportLive(drift);
      const verdict = await toneCheck(draft);
      if (verdict.pass) return { ...draft, toneChecked: true, source: 'ai' };
      console.warn(`[agent] tone check failed (attempt ${attempt}):`, verdict.reason);
    } catch (err) {
      console.warn(`[agent] report writer error (attempt ${attempt}):`, err.message);
    }
  }
  return { ...fallbackReport(drift), toneChecked: true, source: 'fallback' };
}

async function writeReportLive(drift) {
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 1600, // headroom for a possible thinking block before the JSON
    system:
      'You write a short, calm, non-judgmental media-literacy report ("a mirror, not a filter"). ' +
      'Rules you MUST obey: no scare words; never claim the algorithm CAUSED anything ' +
      '(show patterns, not proof); never compare the reader to other people; never diagnose; ' +
      'never ask how they feel emotionally; no scores, streaks, or guilt. Compare the reader only to their ' +
      'own earlier weeks. End "changed" with a gentle reflective question about how they want their ' +
      'time or week to look — modelled on "Is this how you want your week to look?". ' +
      'Do NOT phrase it as an emotions check-in (never "how does that feel", "how do you feel about"). ' +
      'Return ONLY JSON: {"headline","driving","changed","tryThis"}. ' +
      'headline: one sentence naming the drift type + the number + rough date. ' +
      'driving: one sentence on the 2-3 topic clusters behind it. ' +
      'changed: 1-3 short sentences on habit changes vs their own earlier weeks, ending in a question. ' +
      'tryThis: one optional, low-pressure suggestion matched to the drift type.',
    messages: [{ role: 'user', content: JSON.stringify(driftFacts(drift)) }],
  });
  const text = msg.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  const o = JSON.parse(extractJson(text));
  return {
    headline: String(o.headline || '').trim(),
    driving: String(o.driving || '').trim(),
    changed: String(o.changed || '').trim(),
    tryThis: String(o.tryThis || '').trim(),
  };
}

const BANNED = ['addict', 'addicted', 'addiction', 'toxic', 'brainwash', 'brainwashed', 'radicaliz', 'manipulat', 'victim', 'damage', 'damaged', 'disorder', 'unhealthy', 'dangerous', 'should stop', 'you need to', 'compared to others', 'worse than', 'caused you', 'the algorithm made you', 'made you'];

async function toneCheck(draft) {
  const blob = `${draft.headline}\n${draft.driving}\n${draft.changed}\n${draft.tryThis}`.toLowerCase();
  const local = BANNED.find((w) => blob.includes(w));
  if (local) return { pass: false, reason: `banned phrase: "${local}"` };
  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 1024, // headroom: claude-sonnet-5 may spend tokens on a thinking block first
      system:
        'You are a tone auditor for a media-literacy report shown to teens. FAIL the text ONLY if it: ' +
        'uses scare words; claims the algorithm CAUSED the user\'s behavior; compares the user to ' +
        'other people; diagnoses; guilt-trips; or asks about the user\'s EMOTIONS ("how do you feel", ' +
        '"does this make you anxious"). ' +
        'IMPORTANT: a gentle reflective question about how the user wants their time or week to look ' +
        '(e.g. "Is this how you want your week to look?") is ENCOURAGED — do NOT fail that. ' +
        'Otherwise PASS. Reply ONLY with JSON: {"pass": true|false, "reason": "..."}.',
      messages: [{ role: 'user', content: blob }],
    });
    const text = msg.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    let v = tryParse(text);
    if (!v) {
      // Regex fallback: the auditor's verdict is a single boolean either way.
      const m = /"?pass"?\s*[:=]\s*(true|false)/i.exec(text);
      if (m) v = { pass: m[1].toLowerCase() === 'true', reason: 'parsed via fallback' };
    }
    if (!v) return { pass: false, reason: 'unparseable auditor reply' };
    return { pass: !!v.pass, reason: v.reason || '' };
  } catch (err) {
    // If the auditor itself errors, be conservative: treat as fail so we fall back.
    return { pass: false, reason: 'auditor error: ' + err.message };
  }
}

// ---------------------------------------------------------------------------
// Pre-written / template reports (no AI) — deterministic and always safe.
// ---------------------------------------------------------------------------

const SUGGESTIONS = {
  narrowing: 'Try adding one video from a topic you used to watch but drifted away from. See if it still lands.',
  escalation: 'Try one day without news or political content. See if your focus changes.',
  engagement: 'Try picking one longer video to watch start-to-finish, instead of several short ones.',
  mixed: 'Pick one thing you watched this week on purpose, and notice how it felt versus the autoplay picks.',
};

function driftFacts(drift) {
  return {
    type: drift.type,
    metric: drift.metric,
    percent: drift.percent,
    startDate: drift.startDate,
    weeks: drift.weeks,
    topClusters: drift.topClusters,
    habitChanges: drift.habitChanges,
    confidence: drift.confidence,
  };
}

function prettyClusters(list = []) {
  const names = {
    news_politics: 'news & politics', commentary_drama: 'commentary & drama',
    true_crime: 'true crime', gaming: 'gaming', music: 'music',
    cooking_food: 'cooking & food', science_tech: 'science & tech',
    education_study: 'study & education', fitness_health: 'fitness & health',
    comedy_entertainment: 'comedy', sports: 'sports', diy_crafts: 'DIY & crafts',
    finance_money: 'finance & money', lifestyle_vlog: 'lifestyle vlogs', other: 'general',
  };
  return list.slice(0, 3).map((c) => names[c] || c);
}

// A richer template used when running without an API key ("mock" mode).
function mockReport(drift) {
  const clusters = prettyClusters(drift.topClusters);
  const when = drift.startDate ? ` starting around ${drift.startDate}` : '';
  const headlines = {
    escalation: `Emotional Escalation: your content became ${drift.percent}% more emotionally intense over ${drift.weeks} weeks${when}.`,
    narrowing: `Narrowing: your topics shrank by about ${drift.percent}% over ${drift.weeks} weeks${when}, clustering into fewer subjects.`,
    engagement: `Engagement Drift: your videos got ${drift.percent}% shorter while you watched in more frequent bursts over ${drift.weeks} weeks${when}.`,
    mixed: `Mixed signal: your watching shifted over ${drift.weeks} weeks, but no single pattern stands out clearly.`,
  };
  const driving = clusters.length
    ? `Most of the shift sits in ${listPhrase(clusters)}.`
    : 'The shift is spread across several topics rather than one.';
  const changed = drift.habitChanges?.length
    ? `${drift.habitChanges.slice(0, 3).join(' ')} Is this how you want your week to look?`
    : 'Your viewing rhythm looks broadly similar to your earlier weeks. Is this how you want your week to look?';
  return {
    headline: headlines[drift.type] || headlines.mixed,
    driving,
    changed,
    tryThis: SUGGESTIONS[drift.type] || SUGGESTIONS.mixed,
  };
}

// The plain pre-written fallback (PRD §4.5: "you get a plain pre-written version").
function fallbackReport(drift) {
  return {
    headline: `Your content shifted toward ${drift.type} over the last ${drift.weeks} weeks.`,
    driving: prettyClusters(drift.topClusters).length
      ? `The change centres on ${listPhrase(prettyClusters(drift.topClusters))}.`
      : 'The change is spread across a few topics.',
    changed: 'Some of your viewing habits moved alongside it, compared with your own earlier weeks. Is this how you want your week to look?',
    tryThis: SUGGESTIONS[drift.type] || SUGGESTIONS.mixed,
  };
}

function insufficientReport(drift) {
  return {
    headline: 'Not enough history yet to call a drift type.',
    driving: `This file covers about ${drift.coverageDays || 0} days. The rules need more to be honest.`,
    changed: 'Scroll further back on your history page and grab it again — a month of depth gives a clearer read.',
    tryThis: 'For now, try the "sample data" button to see what a full report looks like.',
    toneChecked: true,
    source: 'insufficient',
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function chunk(a, n) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }
function clamp01(x) { return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0.35; }
function listPhrase(a) { return a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }
// Robust: strips ```fences```, then returns the first balanced [] or {} block.
function extractJson(text) {
  let t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.search(/[[{]/);
  if (start === -1) return t;
  const open = t[start], close = open === '[' ? ']' : '}';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return t.slice(start, i + 1); }
  }
  return t.slice(start); // unbalanced — let the caller's try/catch handle it
}

function tryParse(text) { try { return JSON.parse(extractJson(text)); } catch { return null; } }
