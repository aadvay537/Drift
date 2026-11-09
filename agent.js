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
import { keywordLabel } from './public/labeler.js';

// Report writer, tone checker and chat use a strong model; labelling hundreds of
// short titles uses a fast, cheap one. Both are overridable from the environment.
const MODEL = process.env.DRIFT_MODEL || 'claude-sonnet-5-5';
const LABEL_MODEL = process.env.DRIFT_LABEL_MODEL || 'claude-haiku-5-5';
const hasKey = !!process.env.ANTHROPIC_API_KEY;
const client = hasKey ? new Anthropic() : null;

export const agentMode = hasKey ? 'live' : 'mock';

// ---------------------------------------------------------------------------
// Health. Every live call reports success or failure here, so a wrong model
// name or a bad key shows up in /api/status instead of silently falling back
// to the keyword labeler while the site still claims "live AI".
// ---------------------------------------------------------------------------
const health = { ok: 0, failed: 0, lastError: null, lastErrorAt: null, lastOkAt: null };
function noteOk() { health.ok++; health.lastOkAt = new Date().toISOString(); }
function noteFail(err) {
  health.failed++;
  health.lastError = String(err?.message || err).slice(0, 300);
  health.lastErrorAt = new Date().toISOString();
}
export function getHealth() {
  if (!hasKey) return { state: 'mock' };
  const failing = health.lastErrorAt && (!health.lastOkAt || health.lastErrorAt > health.lastOkAt);
  return { state: failing ? 'failing' : health.ok ? 'healthy' : 'untested', model: MODEL, labelModel: LABEL_MODEL, chatModel: CHAT_MODEL, webSearch: WEB_SEARCH, ...health, cacheSize: labelCache.size };
}

// Label cache: the same video title gets the same label for everyone, so once a
// title is labelled we never pay for it again. In-memory, bounded, titles only.
const labelCache = new Map();
const CACHE_MAX = 50000;
const cacheKey = (title) => String(title).toLowerCase().replace(/\s+/g, ' ').trim();
function cacheGet(title) {
  const k = cacheKey(title);
  const v = labelCache.get(k);
  if (v) { labelCache.delete(k); labelCache.set(k, v); } // refresh recency
  return v;
}
function cacheSet(title, v) {
  labelCache.set(cacheKey(title), v);
  if (labelCache.size > CACHE_MAX) labelCache.delete(labelCache.keys().next().value);
}

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

  // 1. Anything already labelled (by anyone) comes from the cache for free.
  const out = new Map();
  const todo = [];
  for (const it of items) {
    const hit = cacheGet(it.title);
    if (hit) out.set(it.id, { id: it.id, ...hit });
    else todo.push(it);
  }

  // 2. The rest go out in small batches, several at a time (PRD §9: < $0.15 / analysis).
  const batches = chunk(todo, 40);
  await mapLimit(batches, 4, async (batch) => {
    let labels;
    try {
      labels = await labelBatchLive(batch);
      noteOk();
    } catch (err) {
      noteFail(err);
      console.warn('[agent] labeler fell back to keywords:', err.message);
      labels = batch.map(mockLabel);
    }
    labels.forEach((l, i) => {
      out.set(l.id, l);
      if (!l.fallback) cacheSet(batch[i].title, { topic: l.topic, intensity: l.intensity });
    });
  });
  return items.map((it) => out.get(it.id) || mockLabel(it));
}

// Run fn over items with at most `limit` in flight.
async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  });
  await Promise.all(workers);
}

async function labelBatchLive(batch) {
  const list = batch.map((it) => `${it.id}\t${it.title}`).join('\n');
  const msg = await client.messages.create({
    model: LABEL_MODEL,
    max_tokens: 3500, // headroom for 40 JSON objects
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
    if (!o || !TOPICS.includes(o.topic)) return { ...mockLabel(it), fallback: true };
    return { id: it.id, topic: o.topic, intensity: clamp01(Number(o.intensity)) };
  });
}

// Deterministic keyword labeler (shared with the browser's backup engine).
export const mockLabel = keywordLabel;

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
  '- Drift also reads Instagram and TikTok data downloads (JSON format; the whole .zip can be dropped in). Instagram: Settings → Accounts Center → Your information and permissions → Download your information → choose Ads information + Your activity, JSON format. TikTok: Settings and privacy → Account → Download your data → JSON. These downloads have no titles, so Drift shows RHYTHM (how often and when you watch), creator concentration (Instagram), and the interests Instagram has guessed for you — and nothing from those files is sent to the AI, only a short summary.',
  '- In the report, "Ask your data" answers questions about the reader\'s own history (late-night watching, busiest week, top creators, when it changed) on their device. You only see the summary, so for those specifics, point them to that panel.',
  '- Modes: with an API key Drift uses Claude live; without one it runs a deterministic "demo engine" so everything still works end to end. A badge at the top-right shows which mode is active.',
].join('\n');

// Ask Drift: a full general-purpose assistant that lives inside Drift. It can
// search the web, read images people attach, and use the person's own
// (aggregate) report data. The strongest model is used for chat.
const CHAT_MODEL = process.env.DRIFT_CHAT_MODEL || 'claude-opus-5-5';
const WEB_SEARCH = process.env.DRIFT_WEB_SEARCH !== 'off';

const CHAT_SYSTEM =
  "You are Ask Drift, the AI assistant inside Drift (a website that helps people understand how their social media " +
  'feeds change). You are a fully capable general assistant, as capable as a top AI model: answer ANY question the ' +
  'person asks, thoroughly and accurately — general knowledge, current events, news, sport, science, maths (show the ' +
  'working), coding (give working code), writing and editing, homework help (explain, don\'t just give answers), ' +
  'study plans, health and wellbeing information, technology help, recommendations, translations, and of course ' +
  'Drift, social media, algorithms and screen time. Never refuse or deflect a reasonable question because it is ' +
  'off-topic, and never tell people to "steer back" to Drift.\n\n' +
  'TOOLS: You can search the web. Use it whenever the answer depends on anything current or that may have changed — ' +
  'news, prices, scores, weather, app settings and menus, laws, people\'s current roles, product versions, "latest" ' +
  'anything — or when you are not sure. Do not search for things you know well that do not change. When you use search ' +
  'results, say where the information came from in plain words. If people attach images (screenshots, photos, ' +
  'homework), look at them carefully and use what they show.\n\n' +
  'STYLE: Warm, clear and direct. Start with the answer, then the detail. Use Markdown when it helps: short paragraphs, ' +
  '**bold** for key points, "-" bullet lists, "1." numbered steps, ```code blocks``` for code, and simple tables when ' +
  'comparing things. Keep quick questions short; give fuller answers to "how", "why", "explain" and "help me plan". ' +
  'Write for everyone, including older people and non-native English speakers: plain words, no jargon unless asked. ' +
  'If the person writes in another language (for example Hindi or Hinglish), reply in that language.\n\n' +
  'SAFETY: Be honest about uncertainty. For serious medical, legal or financial situations, give useful general ' +
  'information and suggest a professional. If someone seems to be in danger or crisis, respond with care and point ' +
  'them to emergency help (in India: 112; Tele-MANAS mental health helpline 14416).\n\n' +
  "THE PERSON'S OWN DRIFT DATA (Drift's \"mirror, not a filter\" promise): ground every claim about them in the " +
  'report and statistics provided below and never invent numbers; describe patterns, not proof — never claim an ' +
  'algorithm CAUSED their behaviour; never compare them to other people; never diagnose or label them (never call ' +
  'them addicted); no guilt-tripping. When they want to change something, be genuinely helpful: give concrete, ' +
  'specific steps, including exact app settings (search to confirm current menus if unsure). Discussing these topics ' +
  'in general is completely fine — just be balanced and accurate.\n\n' + DRIFT_KB;

// The small, aggregate, non-identifying statistics the browser may share so the
// assistant can answer data questions: weekly totals, topic shares, hour-of-day
// shares, creator concentration as percentages. No titles, names or timestamps.
function contextBlock(drift, report, stats) {
  if (!(drift && report)) {
    return '\n\nThe person has NOT run an analysis yet, so you have no data for them. Answer generally; where it ' +
      'genuinely helps, mention they can try Drift (the "Try it with sample data" button shows a full example).';
  }
  return "\n\nTHE PERSON'S CURRENT REPORT:\n" + JSON.stringify({ drift: driftFacts(drift), report }) +
    (stats ? '\n\nON-DEVICE STATISTICS (aggregates computed in their browser):\n' + JSON.stringify(stats) : '');
}

function chatMessages(history, q, images = []) {
  const userContent = images.length
    ? [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } })), { type: 'text', text: q || 'What is in this image?' }]
    : q;
  return [
    ...history
      .filter((m) => m && typeof m.content === 'string' && m.content.trim())
      .slice(-16)
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content.slice(0, 6000) })),
    { role: 'user', content: userContent },
  ];
}

function nowBlock(now, tz) {
  const d = Number.isFinite(Date.parse(now)) ? new Date(now) : new Date();
  let zone = 'Asia/Kolkata';
  try { if (tz) { new Intl.DateTimeFormat('en', { timeZone: tz }); zone = tz; } } catch { /* bad tz */ }
  const local = d.toLocaleString('en-GB', { timeZone: zone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `\n\nCURRENT DATE AND TIME: ${local} (${zone}); ${d.toISOString()} UTC. Use this for anything about "today", ages, countdowns, or what is recent.`;
}

/**
 * Answer one question, streaming as it is written.
 * @param {object} p  drift/report/stats optional; images optional [{media_type, data(base64)}]
 * @param {(ev:object)=>void} [emit]  receives {t:text} chunks, {s:'searching', q} status, {sources:[...]} at the end
 * @returns {Promise<{answer:string, source:string, sources:Array}>}
 */
export async function chatAboutDrift({ drift, report, stats = null, history = [], question, images = [], now, tz }, emit = () => {}) {
  const onText = (t) => emit({ t });
  const q = String(question || '').trim();
  if (!q && !images.length) { const a = 'Ask me anything — about your feed, your report, or anything else at all.'; onText(a); return { answer: a, source: 'mock', sources: [] }; }
  if (!hasKey) { const a = mockChat(drift, report, q); onText(a); return { answer: a, source: 'mock', sources: [] }; }

  const system = CHAT_SYSTEM + nowBlock(now, tz) + contextBlock(drift, report, stats);
  let text = '';
  const sources = new Map();
  // First try: strongest model + web search. If that fails before any text
  // arrives, retry once with the standard model and no tools.
  for (const attempt of [{ model: CHAT_MODEL, search: WEB_SEARCH }, { model: MODEL, search: false }]) {
  const tools = attempt.search ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] : undefined;
  let messages = chatMessages(history, q, images);
  try {
    // Long searches can pause mid-turn; continue up to a few times.
    for (let round = 0; round < 4; round++) {
      const stream = client.messages.stream({ model: attempt.model, max_tokens: 4096, system, messages, ...(tools ? { tools } : {}) });
      stream.on('text', (t) => { text += t; onText(t); });
      stream.on('streamEvent', (ev) => {
        if (ev.type === 'content_block_start' && ev.content_block?.type === 'server_tool_use') emit({ s: 'searching' });
      });
      const msg = await stream.finalMessage();
      for (const block of msg.content || []) {
        if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
          for (const r of block.content) if (r.url && !sources.has(r.url)) sources.set(r.url, { url: r.url, title: r.title || r.url });
        }
        if (block.type === 'text' && Array.isArray(block.citations)) {
          for (const c of block.citations) if (c.url) sources.set(c.url, { url: c.url, title: c.title || c.url, cited: true });
        }
      }
      if (msg.stop_reason !== 'pause_turn') break;
      messages = [...messages, { role: 'assistant', content: msg.content }];
    }
    noteOk();
    // Prefer sources the answer actually cited; otherwise the top results.
    const all = [...sources.values()];
    const cited = all.filter((x) => x.cited);
    const list = (cited.length ? cited : all).slice(0, 6).map(({ url, title }) => ({ url, title }));
    if (list.length) emit({ sources: list });
    return { answer: text.trim(), source: 'ai', sources: list };
  } catch (err) {
    noteFail(err);
    console.warn(`[agent] chat error (${attempt.model}${attempt.search ? ' + search' : ''}):`, err.message);
    if (text) return { answer: text.trim(), source: 'ai-partial', sources: [] };
  }
  }
  const a = mockChat(drift, report, q);
  onText(a);
  return { answer: a, source: 'mock', sources: [] };
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
  if (/insta|tiktok|tik tok|reels?\b/.test(ql)) {
    return 'Yes — Drift reads Instagram and TikTok data downloads too. Instagram: Settings → Accounts Center → Your information and permissions → Download your information, pick "Ads information" and "Your activity", and choose JSON. TikTok: Settings and privacy → Account → Download your data, choose JSON. Drop the .zip straight in. Those files have no titles, so Drift shows your rhythm and (for Instagram) which creators fill your feed — and nothing from them is sent to the AI.';
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
      noteOk();
      const verdict = await toneCheck(draft);
      if (verdict.pass) return { ...draft, toneChecked: true, source: 'ai' };
      console.warn(`[agent] tone check failed (attempt ${attempt}):`, verdict.reason);
    } catch (err) {
      noteFail(err);
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
