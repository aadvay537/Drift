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
// 4. CHAT  — an always-on assistant that answers the reader's questions.
//
// Works with OR without a report: before an analysis it answers general
// questions about how Drift works, privacy, the drift types, the bookmarklet,
// etc.; after one it can also ground answers in that reader's own result.
// It only ever receives the (already-shared) drift summary + report + the
// reader's own questions — nothing new about the reader is sent. Same calm,
// non-judgmental tone rules as the report writer, enforced with the same BANNED
// list. No key (or any failure) → a deterministic, still-helpful mock answer.
// ---------------------------------------------------------------------------

// Published, auditable facts the assistant may rely on — so it clears real
// doubts instead of guessing. Kept in sync with the site copy and drift.js.
const DRIFT_KB = [
  'ABOUT DRIFT — use these facts and never contradict them:',
  '- Drift is a media-literacy tool, "a mirror, not a filter". You grab your own YouTube or Reddit history with one click and, in about two minutes, see what kind of algorithmic influence your feed has been under. It never blocks, ranks, filters, lectures, or gives scores/streaks.',
  '- The pipeline has 5 steps: (1) your history file is parsed IN YOUR BROWSER and never uploaded; (2) it is cleaned locally — channel names and @handles are stripped; (3) only the cleaned TITLES are sent to an AI labeller that tags each one\'s topic and how emotionally charged it is (0-1), then the titles are deleted; (4) fixed, published MATH in your browser decides your drift type — not the AI; (5) an AI writes a short report and a SECOND AI tone-checks it (if that fails twice you get a plain pre-written version).',
  '- Three drift types, with published thresholds, comparing the LATER half of your timeline to your OWN earlier half: NARROWING = your distinct topics shrink more than 15%; ESCALATION = your average emotional intensity rises more than 10%; ENGAGEMENT DRIFT = your videos get more than 20% shorter AND your watch sessions get more than 25% more frequent. If none clear their line → "mixed / unclear". If there is not enough history → "insufficient" (it refuses to guess).',
  '- The DRIFT SCORE is one number from 0-100: how far the reader\'s recent weeks moved from their OWN earlier weeks, blended across the three dimensions (each normalized to its own threshold; the strongest sets the score on a saturating curve where crossing a threshold is about 50 and an extreme shift approaches 100, with a small bump when several dimensions move at once). Bands: subtle (under 34), moderate (34-66), strong (67+). It is a MAGNITUDE, never a verdict of good or bad — a high score just means a bigger shift away from your earlier self, and even a "mixed" result has a score.',
  '- It compares you only to your OWN earlier weeks, never to other people. The same file always gives the same answer (rules v3.1 — anyone can read exactly how it decides).',
  '- Privacy: your raw file, channel names, handles, and every timestamp stay in your browser. Only cleaned titles and a tiny, non-identifying drift summary are ever sent; the AI service deletes them and never trains on them. Your habit patterns (when and how long you watch) are computed entirely on your device. Before anything is sent, you see exactly what will be sent.',
  '- The EASIEST way to get your history is Google Takeout (takeout.google.com) — no scrolling at all: click "Deselect all", tick only "YouTube and YouTube Music", click "All YouTube data included" and keep only "history", click "Multiple formats" and set History to JSON, then export. Google emails a zip in minutes; inside it, Takeout → YouTube and YouTube Music → history → watch-history.json is the file to drop into Drift. It covers the complete history with exact dates, but has no video durations, so engagement drift can\'t be detected from it (narrowing and escalation work fully).',
  '- The bookmarklet is a bookmark that runs a tiny script: drag it to your bookmarks bar once, open your history page, click it, and scroll gently while its counter shows items and days collected — it saves one small file you drop back on the site. It talks to no server and only reads the page you click it on. It does capture video durations, so it\'s the only path that can detect engagement drift. If it was installed a while ago it should be dragged up again to replace the old copy — a saved bookmark keeps the old script. On mobile you can paste the script into a bookmark, or use the paste-in fallback (which also loses durations).',
  '- Modes: with an API key Drift uses Claude live; without one it runs a deterministic "demo engine" so everything still works end to end. A badge at the top-right shows which mode is active.',
].join('\n');

const CHAT_SYSTEM =
  "You are Drift's assistant — a calm, friendly guide for a media-literacy tool. Help the reader understand Drift " +
  'and (if they have run one) their own result, and answer general questions about how recommendation feeds and media ' +
  'literacy work. Actually resolve the doubt: be specific and use the facts below; if they ask "how", walk through the ' +
  'relevant step plainly. Tone rules you MUST obey (a mirror, not a filter): no scare words; never claim the algorithm ' +
  'CAUSED anyone\'s behaviour (patterns, not proof); never compare the reader to other people; never diagnose; no guilt, ' +
  'scores, or streaks; never ask how they feel emotionally. Keep answers warm, plain, and fairly short — usually 2-5 ' +
  'sentences, a little more only when the question truly needs it. Never invent numbers. If a report is provided, ground ' +
  "any claim about THEIR data in it; if something isn't in the data (why it happened, what happens next, who they are), " +
  'say plainly that Drift only shows patterns in what they already watched. If a question is unrelated to Drift or media ' +
  'literacy, answer briefly and gently steer back.\n\n' + DRIFT_KB;

/**
 * Answer one question. Both drift and report are OPTIONAL — when absent the
 * assistant answers generally (the reader hasn't analysed anything yet).
 * @param {object} p
 * @param {object|null} p.drift    the (already-shared) drift summary, or null
 * @param {object|null} p.report   the written report {headline,driving,changed,tryThis}, or null
 * @param {{role:string,content:string}[]} p.history  prior completed turns (user/assistant pairs)
 * @param {string} p.question the new question
 * @returns {Promise<{answer:string, source:string}>}
 */
export async function chatAboutDrift({ drift, report, history = [], question }) {
  const q = String(question || '').trim();
  if (!q) return { answer: 'Ask me anything about Drift or your report.', source: hasKey ? 'live' : 'mock' };
  if (!hasKey) return { answer: mockChat(drift, report, q), source: 'mock' };

  try {
    const context = drift && report
      ? "\n\nTHE READER'S CURRENT REPORT (ground any claim about their data in this, and nothing else):\n" +
        JSON.stringify({ drift: driftFacts(drift), report }, null, 0)
      : '\n\nThe reader has NOT run an analysis yet, so you have no report for them — answer generally, and where it helps, ' +
        'invite them to try it (the "Try with sample data" button shows a full example in seconds).';
    const messages = [
      ...history
        .filter((m) => m && typeof m.content === 'string' && m.content.trim())
        .slice(-8)
        .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content.slice(0, 1000) })),
      { role: 'user', content: q },
    ];
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 900, // headroom for a thinking block + a few-sentence answer
      system: CHAT_SYSTEM + context,
      messages,
    });
    const text = msg.content.map((c) => (c.type === 'text' ? c.text : '')).join('').trim();
    const lower = text.toLowerCase();
    // Reuse the report's tone guard: a scare/causal/comparison phrase → safe fallback.
    if (!text || BANNED.some((w) => lower.includes(w))) {
      return { answer: mockChat(drift, report, q), source: 'fallback' };
    }
    return { answer: text, source: 'ai' };
  } catch (err) {
    console.warn('[agent] chat fell back to mock:', err.message);
    return { answer: mockChat(drift, report, q), source: 'mock' };
  }
}

// Deterministic assistant — used with no API key and as the live fallback.
// Answers general questions about Drift, then report-specific ones if a report
// exists. Matched with word-ish regexes so common substrings don't misfire.
function mockChat(drift, report, q) {
  const ql = q.toLowerCase();

  // ---- General questions (answerable with or without a report) ----
  if (/priv|\bdata\b|\bsent\b|\bsend\b|safe|secure|leak|track|stored?|upload/.test(ql)) {
    return 'Your raw history file, channel names, handles, and every timestamp stay in your browser — they are never uploaded. Only cleaned-up titles and a tiny drift summary reach the AI, which deletes them and never trains on them. Everything about when and how long you watch is worked out on your own device, and you see exactly what will be sent before it goes.';
  }
  // Bookmarklet / getting-started is checked BEFORE the generic "how it works"
  // so "what is the bookmarklet and how do I use it?" lands here.
  if (/takeout|watch-history|no.?scroll|whole history|full history|complete history/.test(ql)) {
    return 'Google Takeout is the easiest route — no scrolling: at takeout.google.com click "Deselect all", tick only YouTube, keep only "history" under "All YouTube data included", set the format to JSON under "Multiple formats", and export. Google emails you a small zip in a few minutes; drop its watch-history.json file into Drift. You get your complete history with exact dates — only video durations are missing, so engagement drift can\'t be measured that way.';
  }
  if (/bookmarklet|grab my history|get started|getting started|how (do i|to|can i) (get|grab|start|use)|get my report|install/.test(ql)) {
    return 'Two ways. Easiest: Google Takeout (takeout.google.com) — export only your YouTube history as JSON and drop the watch-history.json file here; no scrolling needed. Or use the bookmarklet: drag it to your bookmarks bar once, open your YouTube history page, click it, and scroll gently while the counter shows items and days collected — then download and drop the file here. The bookmarklet also captures video durations, which Takeout doesn\'t.';
  }
  if (/how (does|do|is|are|it)|how it works|pipeline|\bsteps?\b|what is drift|what'?s drift|what does (it|drift) do/.test(ql)) {
    return 'Drift reads your own watch history in five steps: your file is parsed in your browser (never uploaded), cleaned so channels and handles are stripped, then only the titles go to an AI that tags each one\'s topic and emotional intensity. Fixed, published math in your browser then decides your "drift type", and finally one AI writes a short report while a second one tone-checks it. The AI reads and writes — it never judges you; the judgment comes from plain, auditable rules.';
  }
  if (!report && /\btypes?\b|narrowing|escalation|engagement|\bmixed\b|insufficient|categor|kind of drift|what can it find|what does it (look|check) for/.test(ql)) {
    return 'Drift looks for three patterns by comparing your recent weeks to your own earlier weeks: NARROWING (your range of topics shrinks by more than 15%), ESCALATION (your average emotional intensity rises more than 10%), and ENGAGEMENT DRIFT (your videos get over 20% shorter AND you open over 25% more watch sessions). If nothing crosses the line it says "mixed", and if there isn\'t enough history it honestly says so instead of guessing.';
  }
  if (!report && /accur|confiden|trust|reliab|\bwrong\b|\bsure\b|is it real|legit|biased?/.test(ql)) {
    return 'Drift is honest by design: it uses fixed, published thresholds, compares you only to your own earlier weeks, and refuses to classify when there isn\'t enough history. It shows patterns, not proof — a mirror to reflect on, not a verdict. The more history you grab (about a month is plenty), the clearer the read.';
  }
  if (/\bdemo\b|\bmock\b|\blive\b|api key|\bclaude\b|which model|ai model/.test(ql)) {
    return 'When an API key is set, Drift uses Claude live to label your titles and write your report. Without one it runs a built-in "demo engine" that does everything deterministically, so the site works end to end either way. The badge at the top-right tells you which mode you\'re in.';
  }

  // ---- Report-specific questions (only once they've analysed something) ----
  if (report) {
    const typeName = {
      escalation: 'emotional escalation', narrowing: 'narrowing',
      engagement: 'engagement drift', mixed: 'a mixed, unclear signal',
      insufficient: 'not enough history to call a type yet',
    }[drift?.type] || 'your result';
    if (/\bwhy\b|cause|because|reason/.test(ql)) {
      return `Drift can only show the pattern in what you already watched — it can't know why it happened or prove the feed caused it. What it can point to is this: ${report.driving}`;
    }
    if (/\btry\b|should i|change|suggest|advice|\bfix\b|what.*\bdo\b|what.*\bnext\b/.test(ql)) {
      return `Nothing here needs fixing — it's a mirror, not a verdict. If you're curious, one low-pressure idea: ${report.tryThis}`;
    }
    if (/confiden|accur|\bsure\b|trust|reliab|\bwrong\b/.test(ql)) {
      return `This is a ${drift?.confidence || 'low'}-confidence read, based on about ${drift?.coverageDays || 0} days of history. More history would sharpen it — Drift only compares you to your own earlier weeks, never to anyone else.`;
    }
    if (/mean|\btype\b|\bkind\b|result|explain|meaning|what is this/.test(ql)) {
      return `Your report came out as ${typeName}. ${report.headline} In plain terms, Drift lines your recent weeks up against your own earlier weeks and names the pattern it sees — it doesn't rank you or claim the feed caused it.`;
    }
    return `Here's what your report shows: ${report.driving} ${report.changed} You can ask me what the drift type means, why it might have shown up, whether it's reliable, or what happened to your data.`;
  }

  // ---- General fallback (no report yet) ----
  return 'I\'m the Drift assistant — ask me how Drift works, what the drift types mean, what happens to your data, or how to grab your history. Or hit "Try with sample data" to see a full report in seconds, and I can walk you through it.';
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
      'You are given a driftScore (0-100) and a severity band (subtle/moderate/strong): this is HOW FAR ' +
      'their recent weeks moved from their own earlier weeks — a magnitude of change, never good or bad. ' +
      'You may weave the score or band into the headline naturally, but never grade it as good/bad/healthy. ' +
      'The `weeks` field is how many weeks the WHOLE analysed history spans, and `startDate` is the ' +
      'date that history BEGINS. They go together: "over the last N weeks" or "over ~N weeks since <startDate>" ' +
      'are both fine, but NEVER pair the week count with any other date — do not invent a different start. ' +
      'Return ONLY JSON: {"headline","driving","changed","tryThis"}. ' +
      'headline: one sentence naming the drift type + the number + the startDate (if used, it must match weeks). ' +
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
    driftScore: drift.driftScore,
    severity: drift.severity,
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
    driving: `This file only held ${drift.itemCount || 0} usable videos across about ${drift.coverageDays || 0} days. The rules need at least 15 to be honest.`,
    changed: 'The easiest fix is Google Takeout (the no-scroll option on the site): it exports your complete history in a few minutes, no scrolling needed.',
    tryThis: 'Or try the "sample data" button to see what a full report looks like.',
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
