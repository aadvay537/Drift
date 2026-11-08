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
import { labelItems, writeReport, chatAboutDrift, agentMode, getHealth } from './agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Render (and most hosts) sit behind a proxy — trust it so req.ip is the real visitor.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Basic security headers. The page loads its font from Google Fonts only.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'");
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
const limitLabel = rateLimit({ windowMs: 10 * 60 * 1000, max: 8, name: 'analysis' });
const limitReport = rateLimit({ windowMs: 10 * 60 * 1000, max: 12, name: 'report' });
const limitChat = rateLimit({ windowMs: 60 * 1000, max: 12, name: 'chat' });
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
  res.json({ mode: agentMode, ...getHealth() });
});

// 1. Labeling. Guard: only {id, title} pairs are accepted — anything else is dropped.
app.post('/api/label', limitLabel, async (req, res) => {
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

// 3. Chat. The always-on assistant. drift + report are OPTIONAL — before an
// analysis it answers general questions; after one it also gets that reader's
// summary. Same privacy envelope: only the drift summary + the already-written
// report + the reader's own questions. No raw titles or habit data are accepted.
app.post('/api/chat', limitChat, async (req, res) => {
  try {
    const b = req.body || {};
    const question = typeof b.question === 'string' ? b.question.slice(0, 500) : '';
    if (!question.trim()) return res.status(400).json({ error: 'empty question' });

    const d = b.drift;
    const drift = d && typeof d.type === 'string' ? shapeDrift(d) : null;

    const r = b.report;
    // A report only counts if there's a drift result to anchor it to.
    const report = drift && r && typeof r === 'object'
      ? {
          headline: String(r.headline || '').slice(0, 400),
          driving: String(r.driving || '').slice(0, 400),
          changed: String(r.changed || '').slice(0, 600),
          tryThis: String(r.tryThis || '').slice(0, 400),
        }
      : null;

    const history = Array.isArray(b.history)
      ? b.history
          .filter((m) => m && typeof m.content === 'string')
          .slice(-8)
          .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content.slice(0, 1000) }))
      : [];

    const result = await chatAboutDrift({ drift, report, history, question });
    res.json({ ...result, mode: agentMode });
  } catch (err) {
    console.error('[/api/chat]', err);
    res.status(500).json({ error: 'chat failed' });
  }
});

app.listen(PORT, () => {
  console.log(`\n  Drift running → http://localhost:${PORT}`);
  console.log(`  AI agent mode: ${agentMode}${agentMode === 'mock' ? '  (set ANTHROPIC_API_KEY for live analysis)' : ''}\n`);
});
