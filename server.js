// server.js — Drift's tiny backend (PRD §4, §7)
//
// It does exactly two AI things and nothing else:
//   POST /api/label   — cleaned titles in, {topic,intensity} labels out
//   POST /api/report  — browser-computed drift result in, tone-checked report out
//
// It NEVER receives the raw file, channel names, handles, or any habit data.
// The drift math itself lives in the browser (public/drift.js) so it's auditable.

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { labelItems, writeReport, chatAboutDrift, writePlan, labelScreens, readScreenTime, agentMode, getHealth } from './agent.js';
import { addContribution, deleteContribution, allContributions, storageKind, usageCount, usageAdd } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Render (and most hosts) sit behind a proxy — trust it so req.ip is the real visitor.
app.set('trust proxy', 1);
app.disable('x-powered-by');
// Chat may carry a few attached photos (resized in the browser); everything else is small.
const jsonSmall = express.json({ limit: '1mb' });
const jsonChat = express.json({ limit: '12mb' });
app.use((req, res, next) => (['/api/chat', '/api/vision', '/api/screentime'].includes(req.path) ? jsonChat : jsonSmall)(req, res, next));

// Basic security headers. The page loads its font from Google Fonts only.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' data: blob:; frame-ancestors 'none'");
  next();
});

// CORS: the website itself is served from GitHub Pages (instant, never sleeps)
// and calls this server for the AI parts. Only Drift's own sites may call it.
const ALLOWED_ORIGINS = new Set([
  'https://aadvay537.github.io',
  ...(process.env.DRIFT_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
]);
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Drift-Device');
    res.setHeader('Access-Control-Expose-Headers', 'X-Drift-Remaining, X-Drift-Limit');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------------------
// Rate limits. The AI endpoints spend real money on the site owner's API key,
// so each visitor gets a fair allowance per window. In-memory sliding window,
// no dependencies; fine for a single instance.
// ---------------------------------------------------------------------------
function rateLimit({ windowMs, max, name }) {
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, ts] of hits) { const keep = ts.filter((t) => t > cutoff); keep.length ? hits.set(k, keep) : hits.delete(k); }
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || 'unknown';
    const ts = (hits.get(key) || []).filter((t) => t > now - windowMs);
    if (ts.length >= max) {
      res.setHeader('Retry-After', Math.ceil((ts[0] + windowMs - now) / 1000));
      return res.status(429).json({ error: `Too many ${name} requests — please wait a minute.` });
    }
    ts.push(now);
    hits.set(key, ts);
    next();
  };
}
// ---------------------------------------------------------------------------
// Daily AI allowance: DRIFT_DAILY_LIMIT uses per person per day (default 4),
// resetting at midnight India time. A "person" is their device (a random id
// kept in their browser); a looser cap per network address stops someone
// getting around it by clearing their browser. Asking Ask Drift = 1 use;
// one full report = 1 use (its plan is included).
// ---------------------------------------------------------------------------
const DAILY_LIMIT = Number(process.env.DRIFT_DAILY_LIMIT) || 4;
const DAILY_LIMIT_PER_IP = Number(process.env.DRIFT_DAILY_LIMIT_PER_IP) || 40;
function deviceKey(req) {
  const d = String(req.headers['x-drift-device'] || '').replace(/[^a-z0-9-]/gi, '').slice(0, 64);
  return d.length >= 16 ? 'd:' + d : 'ip:' + (req.ip || 'unknown');
}
async function remainingFor(req) {
  const [mine, net] = await Promise.all([usageCount(deviceKey(req)), usageCount('net:' + (req.ip || 'unknown'))]);
  return Math.max(0, Math.min(DAILY_LIMIT - mine, DAILY_LIMIT_PER_IP - net));
}
function dailyAllowance() {
  return async (req, res, next) => {
    try {
      const left = await remainingFor(req);
      res.setHeader('X-Drift-Limit', DAILY_LIMIT);
      if (left <= 0) {
        res.setHeader('X-Drift-Remaining', 0);
        return res.status(429).json({ error: 'daily_limit', limit: DAILY_LIMIT, message: `You've used today's ${DAILY_LIMIT} AI uses. They reset at midnight.` });
      }
      await Promise.all([usageAdd(deviceKey(req)), usageAdd('net:' + (req.ip || 'unknown'))]);
      res.setHeader('X-Drift-Remaining', left - 1);
      next();
    } catch (err) {
      console.error('[allowance]', err);
      next(); // never block people because the counter itself failed
    }
  };
}
const useAllowance = dailyAllowance();

app.get('/api/usage', async (req, res) => {
  try { res.json({ limit: DAILY_LIMIT, remaining: await remainingFor(req) }); }
  catch { res.json({ limit: DAILY_LIMIT, remaining: null }); }
});

const limitLabel = rateLimit({ windowMs: 10 * 60 * 1000, max: 8, name: 'analysis' });
const limitReport = rateLimit({ windowMs: 10 * 60 * 1000, max: 12, name: 'report' });
const limitChat = rateLimit({ windowMs: 60 * 1000, max: 20, name: 'chat' });
const limitShare = rateLimit({ windowMs: 10 * 60 * 1000, max: 6, name: 'sharing' });
// no-store: the browser must re-fetch app.js/normalize.js/bookmarklet source on
// every load. A cached stale app.js once made a fixed bug look unfixed for a
// whole day — these files are tiny, so freshness beats caching here.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
}));

// Tell the frontend whether a real API key is present (affects a small banner only).
app.get('/api/status', (_req, res) => {
  const h = getHealth();
  res.json({ ok: true, mode: agentMode, health: h.state, version: '4.0.0' });
});

// Detailed AI health for the site owner: model names, last error, cache size.
// No visitor data is ever in here.
app.get('/api/health', (_req, res) => {
  res.json({ mode: agentMode, storage: storageKind, ...getHealth() });
});

// 1. Labeling. Guard: only {id, title} pairs are accepted — anything else is dropped.
app.post('/api/label', limitLabel, useAllowance, async (req, res) => {
  try {
    const raw = Array.isArray(req.body?.items) ? req.body.items : [];
    const items = raw
      .filter((it) => it && typeof it.title === 'string')
      .slice(0, 1000)
      .map((it, i) => ({ id: String(it.id ?? i), title: it.title.slice(0, 300) }));
    if (!items.length) return res.status(400).json({ error: 'no titles provided' });
    const labels = await labelItems(items);
    res.json({ labels, mode: agentMode });
  } catch (err) {
    console.error('[/api/label]', err);
    res.status(500).json({ error: 'labeling failed' });
  }
});

// Shape an incoming drift result into the small, non-identifying summary we allow.
// Shared by /api/report and /api/chat so both accept exactly the same fields.
function shapeDrift(d) {
  return {
    type: d.type,
    metric: String(d.metric || ''),
    percent: Number(d.percent) || 0,
    driftScore: Number.isFinite(Number(d.driftScore)) ? Number(d.driftScore) : null,
    severity: String(d.severity || 'none'),
    startDate: typeof d.startDate === 'string' ? d.startDate.slice(0, 40) : '',
    weeks: Number(d.weeks) || 0,
    coverageDays: Number(d.coverageDays) || 0,
    confidence: String(d.confidence || 'low'),
    topClusters: Array.isArray(d.topClusters) ? d.topClusters.slice(0, 3).map(String) : [],
    habitChanges: Array.isArray(d.habitChanges)
      ? d.habitChanges.slice(0, 3).map((s) => String(s).slice(0, 200))
      : [],
  };
}

// 2. Report. Guard: we accept only the small, non-identifying drift summary.
app.post('/api/report', limitReport, async (req, res) => {
  try {
    const d = req.body?.drift;
    if (!d || typeof d.type !== 'string') {
      return res.status(400).json({ error: 'missing drift result' });
    }
    const report = await writeReport(shapeDrift(d));
    res.json({ report, mode: agentMode });
  } catch (err) {
    console.error('[/api/report]', err);
    res.status(500).json({ error: 'report generation failed' });
  }
});

// 3. Chat. The assistant answers anything; it streams its answer as NDJSON lines:
//   {"t":"…text…"}  repeated, then  {"done":true,"source":"ai"}
// drift + report + stats are OPTIONAL. stats are small aggregates computed in the
// browser (weekly totals, topic shares, hour shares, creator-share percentages) —
// never titles, names or timestamps — and are reshaped here so nothing else gets in.
function shapeStats(st) {
  if (!st || typeof st !== 'object') return null;
  const num = (x) => (Number.isFinite(Number(x)) ? Math.round(Number(x) * 1000) / 1000 : null);
  const str = (x, n = 40) => String(x ?? '').slice(0, n);
  return {
    platform: str(st.platform, 20),
    totalItems: num(st.totalItems),
    weeks: Array.isArray(st.weeks) ? st.weeks.slice(0, 60).map((w) => ({
      week: str(w.week, 20), items: num(w.items), sessions: num(w.sessions), intensity: num(w.intensity), topTopic: str(w.topTopic, 30),
    })) : [],
    topicShift: Array.isArray(st.topicShift) ? st.topicShift.slice(0, 10).map((t) => ({ topic: str(t.topic, 30), earlyShare: num(t.earlyShare), recentShare: num(t.recentShare) })) : [],
    hourShareRecent: Array.isArray(st.hourShareRecent) ? st.hourShareRecent.slice(0, 24).map(num) : [],
    hourShareEarlier: Array.isArray(st.hourShareEarlier) ? st.hourShareEarlier.slice(0, 24).map(num) : [],
    lateNightShare: num(st.lateNightShare),
    top3CreatorShare: st.top3CreatorShare ? { earlier: num(st.top3CreatorShare.earlier), recent: num(st.top3CreatorShare.recent) } : null,
    instagramInterests: Array.isArray(st.instagramInterests) ? st.instagramInterests.slice(0, 30).map((x) => str(x, 40)) : [],
    // Quick check (Screen Time screenshot + a few multiple-choice answers).
    screenTime: st.screenTime && typeof st.screenTime === 'object' ? {
      dailyMinutes: num(st.screenTime.dailyMinutes),
      pickups: num(st.screenTime.pickups),
      apps: Array.isArray(st.screenTime.apps) ? st.screenTime.apps.slice(0, 10).map((a) => ({ name: str(a.name, 30), minutesPerDay: num(a.minutes), social: !!a.social })) : [],
    } : undefined,
    answers: st.answers && typeof st.answers === 'object' ? Object.fromEntries(Object.entries(st.answers).slice(0, 6).map(([k, v]) => [str(k, 20), str(v, 60)])) : undefined,
  };
}

app.post('/api/chat', limitChat, useAllowance, async (req, res) => {
  const b = req.body || {};
  const question = typeof b.question === 'string' ? b.question.slice(0, 8000) : '';
  const IMG_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  const images = Array.isArray(b.images)
    ? b.images.filter((im) => im && IMG_TYPES.has(im.media_type) && typeof im.data === 'string' && im.data.length < 4_000_000).slice(0, 4)
    : [];
  if (!question.trim() && !images.length) return res.status(400).json({ error: 'empty question' });

  const d = b.drift;
  const drift = d && typeof d.type === 'string' ? shapeDrift(d) : null;
  const r = b.report;
  const report = drift && r && typeof r === 'object'
    ? {
        headline: String(r.headline || '').slice(0, 400),
        driving: String(r.driving || '').slice(0, 400),
        changed: String(r.changed || '').slice(0, 800),
        tryThis: String(r.tryThis || '').slice(0, 400),
      }
    : null;
  const stats = drift ? shapeStats(b.stats) : null;
  const history = Array.isArray(b.history)
    ? b.history
        .filter((m) => m && typeof m.content === 'string')
        .slice(-16)
        .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content.slice(0, 6000) }))
    : [];

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  let closed = false;
  res.on('close', () => { closed = true; });
  try {
    const result = await chatAboutDrift({
      drift, report, stats, history, question, images,
      now: typeof b.now === 'string' ? b.now.slice(0, 40) : undefined,
      tz: typeof b.tz === 'string' ? b.tz.slice(0, 60) : undefined,
    }, (ev) => {
      if (!closed) res.write(JSON.stringify(ev) + '\n');
    });
    if (!closed) res.end(JSON.stringify({ done: true, source: result.source }) + '\n');
  } catch (err) {
    console.error('[/api/chat]', err);
    if (!closed) res.end(JSON.stringify({ error: 'chat failed' }) + '\n');
  }
});

// 3c. Instagram / TikTok watch-history screenshots → topic + intensity per
// video. Only sent after the person agrees in the preview. Counts as 1 AI use.
app.post('/api/vision', limitLabel, useAllowance, async (req, res) => {
  try {
    const b = req.body || {};
    const platform = b.platform === 'tiktok' ? 'tiktok' : 'instagram';
    const IMG = new Set(['image/jpeg', 'image/png', 'image/webp']);
    const images = Array.isArray(b.images) ? b.images.filter((im) => im && IMG.has(im.media_type) && typeof im.data === 'string' && im.data.length < 2_500_000).slice(0, 10) : [];
    if (!images.length) return res.status(400).json({ error: 'no screenshots' });
    const videos = await labelScreens({ images, platform });
    if (!videos) return res.status(503).json({ error: 'could not read screenshots' });
    res.json({ videos });
  } catch (err) {
    console.error('[/api/vision]', err);
    res.status(500).json({ error: 'could not read screenshots' });
  }
});

// 3d. Screen Time screenshots → usage per app (ignores limits/settings). 1 AI use.
app.post('/api/screentime', limitLabel, useAllowance, async (req, res) => {
  try {
    const IMG = new Set(['image/jpeg', 'image/png', 'image/webp']);
    const images = Array.isArray(req.body?.images) ? req.body.images.filter((im) => im && IMG.has(im.media_type) && typeof im.data === 'string' && im.data.length < 2_500_000).slice(0, 6) : [];
    if (!images.length) return res.status(400).json({ error: 'no screenshots' });
    const st = await readScreenTime({ images });
    if (!st) return res.status(503).json({ error: 'could not read screenshots' });
    res.json({ screenTime: st });
  } catch (err) {
    console.error('[/api/screentime]', err);
    res.status(500).json({ error: 'could not read screenshots' });
  }
});

// 3b. Personal plan. Same small, non-identifying summary as chat, plus the goal.
app.post('/api/plan', limitReport, async (req, res) => {
  try {
    const b = req.body || {};
    const drift = b.drift && typeof b.drift.type === 'string' ? shapeDrift(b.drift) : null;
    if (!drift) return res.status(400).json({ error: 'missing drift' });
    const goal = ['happy', 'less_topic', 'sleep', 'less_time', 'variety', 'focus'].includes(b.goal) ? b.goal : 'happy';
    const platform = ['youtube', 'instagram', 'tiktok', 'reddit'].includes(b.platform) ? b.platform : 'youtube';
    const plan = await writePlan({ drift, stats: shapeStats(b.stats), goal, platform });
    res.json({ plan });
  } catch (err) {
    console.error('[/api/plan]', err);
    res.json({ plan: null });
  }
});

// 4. Anonymous, opt-in result sharing. The browser only sends this if the
// person said yes (and, for 13–17s, that a parent agreed). Everything is
// reshaped here into a fixed set of numbers and labels; anything else is dropped.
const TYPES = new Set(['escalation', 'narrowing', 'engagement', 'mixed', 'rhythm']);
const PLATFORMS = new Set(['youtube', 'reddit', 'instagram', 'tiktok']);
const ACCURACY = new Set(['yes', 'partly', 'no', 'unsure']);
const AGES = new Set(['18+', '13-17']);
function shapeContribution(b) {
  const n = (x, lo = 0, hi = 1e6) => { const v = Number(x); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v * 1000) / 1000)) : null; };
  if (!b || !TYPES.has(b.type) || !PLATFORMS.has(b.platform) || !AGES.has(b.ageGroup)) return null;
  return {
    v: 1,
    platform: b.platform,
    type: b.type,
    score: n(b.score, 0, 100),
    severity: ['subtle', 'moderate', 'strong', 'flat'].includes(b.severity) ? b.severity : null,
    percent: n(b.percent, 0, 10000),
    confidence: ['low', 'medium', 'high'].includes(b.confidence) ? b.confidence : null,
    coverageDays: n(b.coverageDays, 0, 5000),
    itemCount: n(b.itemCount, 0, 100000),
    estimatedDates: !!b.estimatedDates,
    ageGroup: b.ageGroup,
    accuracy: ACCURACY.has(b.accuracy) ? b.accuracy : null,
    lateNightShare: n(b.lateNightShare, 0, 1),
    top3CreatorShare: b.top3CreatorShare ? { earlier: n(b.top3CreatorShare.earlier, 0, 1), recent: n(b.top3CreatorShare.recent, 0, 1) } : null,
    topicShift: Array.isArray(b.topicShift) ? b.topicShift.slice(0, 10).map((t) => ({ topic: String(t.topic || '').slice(0, 30), earlyShare: n(t.earlyShare, 0, 1), recentShare: n(t.recentShare, 0, 1) })) : [],
    weekly: Array.isArray(b.weekly) ? b.weekly.slice(0, 60).map((w) => ({ items: n(w.items, 0, 100000), sessions: n(w.sessions, 0, 10000), intensity: n(w.intensity, 0, 1) })) : [],
    rules: String(b.rules || '').slice(0, 10),
  };
}

app.post('/api/contribute', limitShare, async (req, res) => {
  try {
    const data = shapeContribution(req.body);
    if (!data) return res.status(400).json({ error: 'not a valid summary' });
    res.json(await addContribution(data));
  } catch (err) {
    console.error('[/api/contribute]', err);
    res.status(500).json({ error: 'could not save' });
  }
});

app.delete('/api/contribute/:id', async (req, res) => {
  try {
    const ok = await deleteContribution(String(req.params.id).slice(0, 64), String(req.body?.token || '').slice(0, 100));
    res.status(ok ? 200 : 404).json({ removed: ok });
  } catch (err) {
    console.error('[/api/contribute DELETE]', err);
    res.status(500).json({ error: 'could not remove' });
  }
});

// Public totals across everyone who chose to share — counts and averages only.
app.get('/api/results', async (_req, res) => {
  try {
    const rows = await allContributions();
    const count = (key) => rows.reduce((o, r) => { const k = r[key] ?? 'unknown'; o[k] = (o[k] || 0) + 1; return o; }, {});
    const cross = (key) => rows.reduce((o, r) => { const k = r[key] ?? 'unknown', a = r.accuracy ?? 'unknown'; (o[k] ||= {})[a] = (o[k][a] || 0) + 1; return o; }, {});
    const avg = (xs) => { const v = xs.filter((x) => typeof x === 'number'); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 1000) / 1000 : null; };
    const topicDelta = {};
    for (const r of rows) for (const t of r.topicShift || []) {
      if (t.earlyShare == null || t.recentShare == null) continue;
      (topicDelta[t.topic] ||= []).push(t.recentShare - t.earlyShare);
    }
    res.json({
      total: rows.length,
      storage: storageKind,
      byPlatform: count('platform'),
      byType: count('type'),
      byAccuracy: count('accuracy'),
      byAge: count('ageGroup'),
      // "Did this feel accurate?" split by app and by drift type, to spot weak spots.
      accuracyByPlatform: cross('platform'),
      accuracyByType: cross('type'),
      averageScore: avg(rows.map((r) => r.score)),
      averageLateNightShare: avg(rows.map((r) => r.lateNightShare)),
      topicGrowth: Object.entries(topicDelta).map(([topic, d]) => ({ topic, people: d.length, avgChange: avg(d) })).sort((a, b) => b.avgChange - a.avgChange).slice(0, 8),
      since: rows[0]?.day || null,
    });
  } catch (err) {
    console.error('[/api/results]', err);
    res.status(500).json({ error: 'could not load results' });
  }
});

app.listen(PORT, () => {
  console.log(`\n  Drift running → http://localhost:${PORT}`);
  console.log(`  AI agent mode: ${agentMode}${agentMode === 'mock' ? '  (set ANTHROPIC_API_KEY for live analysis)' : ''}\n`);
});
