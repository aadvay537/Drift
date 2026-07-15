// app.js — the browser orchestrator (PRD §4). Nothing identifying leaves this file
// except cleaned titles, and only after you approve the "what we send" preview.
import { computeDrift, RULES_VERSION, THRESHOLDS } from './drift.js';
import { normalizeHistoryFile, ensureUsableTimeline, parseFlexibleDate, cleanItems } from './normalize.js';

const $ = (s) => document.querySelector(s);
let pending = null; // { source, items, cleaned } waiting on the send-preview confirm
let lastAnalysis = null; // { drift, report, source } — what the chat panel talks about
let chatHistory = [];    // completed [user, assistant] turns for the current report

// ---------------------------------------------------------------------------
// 0. Status badge + bookmarklet wiring
// ---------------------------------------------------------------------------
fetch('/api/status').then((r) => r.json()).then((s) => {
  const b = $('#modeBadge');
  if (s.mode === 'live') { b.textContent = '● live AI analysis'; b.classList.add('live'); }
  else b.textContent = '● demo engine (no API key)';
}).catch(() => {});

// Build the draggable bookmarklet straight from the readable source, so the button
// and the code you can read are provably the same thing.
fetch('bookmarklet.js').then((r) => r.text()).then((src) => {
  $('#bmSource').textContent = src;
  // NOTE: trailing "code; // comment" must be stripped BEFORE newlines are
  // collapsed — otherwise one such comment swallows the entire rest of the
  // one-line bookmarklet and it silently does nothing. The [^:] guard leaves
  // "https://" untouched. Full-line and block comments are removed too.
  const min = 'javascript:' + encodeURIComponent(
    src.replace(/\/\*[\s\S]*?\*\//g, '')       // block comments
       .replace(/^\s*\/\/.*$/gm, '')            // whole-line comments
       .replace(/([^:])\/\/[^\n]*/g, '$1')      // trailing comments (keep URLs)
       .replace(/\n\s*/g, ' ')                  // collapse whitespace
       .trim()
  );
  const a = $('#bookmarklet');
  a.href = min;
  a.addEventListener('click', (e) => { e.preventDefault(); alert('Drag this button up to your bookmarks bar — don\'t click it here. Then open your history page and click it there.'); });
  $('#copyBm').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(min); $('#copyBm').textContent = 'Copied ✓'; }
    catch { prompt('Copy this bookmarklet script:', min); }
  });
}).catch(() => { $('#bmSource').textContent = '// could not load bookmarklet source'; });

// ---------------------------------------------------------------------------
// 1. Getting a file in: drop, choose, or sample
// ---------------------------------------------------------------------------
const drop = $('#drop');
['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('drag')));
drop.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) readFile(f); });
drop.addEventListener('click', () => $('#fileInput').click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') $('#fileInput').click(); });
$('#chooseFile').addEventListener('click', (e) => { e.stopPropagation(); $('#fileInput').click(); });
$('#fileInput').addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) readFile(f); });
$('#sampleBtn').addEventListener('click', loadSample);
$('#heroSample').addEventListener('click', () => { document.querySelector('#get').scrollIntoView(); loadSample(); });
$('#pasteBtn').addEventListener('click', analyzePaste);

function readFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try { ingest(JSON.parse(reader.result)); }
    catch { showError('That file could not be read as a history file. Drop either the bookmarklet\'s drift-history…json or Google Takeout\'s watch-history.json — or use the paste-in fallback.'); }
  };
  reader.onerror = () => showError('Could not open that file.');
  reader.readAsText(file);
}

function loadSample() {
  fetch('sample-data.json').then((r) => r.json()).then(ingest).catch(() => showError('Could not load sample data.'));
}

// ---------------------------------------------------------------------------
// 1b. Paste-in fallback (PRD §3, §11.1) — messier, loses durations.
// We parse titles + any date headers from the copied page text. Dates go through
// parseFlexibleDate (normalize.js) so "Saturday" and "Jul 10" resolve to REAL
// recent dates, not 2001 or nothing. Items still missing a date are rescued by
// ensureUsableTimeline before the drift rules run — but engagement drift (needs
// real durations + session timing) simply won't fire, and confidence stays lower.
// ---------------------------------------------------------------------------
const DUR_RE = /^\d{1,2}:\d{2}(?::\d{2})?$/;
const NOISE_RE = /^(\d+(\.\d+)?[km]?\s*views?|watched|more actions?|shorts?|now playing|recommended|mix|live|new|cc|hd|\d+\s*(minutes?|hours?|days?|weeks?|months?|years?)\s*ago|•+|\d+)$/i;
const DATE_HDR = /^(today|yesterday|(sun|mon|tue|wed|thu|fri|sat)[a-z]*(,?\s.*\d)?|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(,\s*\d{4})?)$/i;

function parsePastedHistory(text, source) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const items = [];
  let curDate = null;
  let pendingDur = 0;
  for (const line of lines) {
    if (DATE_HDR.test(line)) { curDate = parseFlexibleDate(line); continue; }
    if (DUR_RE.test(line)) { pendingDur = durToSec(line); continue; }
    if (NOISE_RE.test(line) || line.length < 12 || !/[a-z]/i.test(line)) { continue; }
    // Skip lone tokens (usually channel names/handles): real titles have a space or are long.
    if (!/\s/.test(line) && line.length < 25) { continue; }
    // Looks like a real title.
    items.push({ title: line, channel: '', durationSec: pendingDur, watchedAt: curDate });
    pendingDur = 0;
  }
  return { source, grabbedAt: new Date().toISOString(), count: items.length, items, pasted: true };
}

function durToSec(s) { const p = s.split(':').map(Number).reverse(); return (p[0] || 0) + (p[1] || 0) * 60 + (p[2] || 0) * 3600; }

function analyzePaste() {
  const text = $('#pasteArea').value.trim();
  const source = $('#pasteSource').value;
  if (text.length < 40) return showError('Paste a bit more of your history page first — a few dozen lines works best.');
  ingest(parsePastedHistory(text, source));
}

// ---------------------------------------------------------------------------
// 2. Clean in-browser, then show the "what we send" preview (PRD §4.2, §7)
// ---------------------------------------------------------------------------
function ingest(raw) {
  // Accept every shape we know: the bookmarklet's file, a pasted-text parse,
  // the sample file, or Google Takeout's watch-history.json.
  const file = normalizeHistoryFile(raw) || raw;
  // Drop duration-overlay noise ("9:30:00") the bookmarklet sometimes grabs as a title.
  const items = cleanItems(file?.items);
  if (!items.length) {
    return showError('No history items found in that. Drop the bookmarklet\'s drift-history…json or Google Takeout\'s watch-history.json (JSON format — see the no-scroll option above).');
  }
  if (items.length < 15) {
    return showError(`We found only ${items.length} video${items.length === 1 ? '' : 's'} — the drift rules need at least 15 to say anything honest. The easiest fix: use the Google Takeout option (no scrolling, your complete history), or scroll a little further before downloading.`);
  }

  // Cleaning: strip handles/@mentions from titles; drop channel names entirely
  // (they're only used locally, never sent). Titles get a stable id.
  const cleaned = items.map((it, i) => ({
    id: 'v' + i,
    title: scrubTitle(it.title),
  }));

  pending = { source: file.source || 'youtube', items, cleaned, meta: file };
  openSendPreview(pending);
}

function scrubTitle(title) {
  return String(title)
    .replace(/@[\w.\-]+/g, '@creator')            // @handles
    .replace(/\bu\/[\w\-]+/gi, 'u/user')          // reddit users
    .replace(/\br\/([\w\-]+)/gi, 'r/$1')          // keep subreddit topic, it's not PII
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 300);
}

function openSendPreview({ cleaned, meta }) {
  const sample = cleaned.slice(0, 8).map((c) => '• ' + c.title).join('\n');
  const truncated = meta?.takeout && meta.totalCount > cleaned.length
    ? `\n\n(Your Takeout file holds ${meta.totalCount} watches — we analyse the newest ${cleaned.length}.)`
    : '';
  $('#sendPreview').textContent =
    sample + (cleaned.length > 8 ? `\n… and ${cleaned.length - 8} more cleaned titles` : '') + truncated;
  $('#sendStats').innerHTML = `
    <div class="stat"><b>${cleaned.length}</b><span>titles sent (labels only)</span></div>
    <div class="stat"><b>0</b><span>channels / handles sent</span></div>
    <div class="stat"><b>0</b><span>timestamps sent</span></div>`;
  $('#sendModal').classList.remove('hidden');
}

$('#sendCancel').addEventListener('click', () => { $('#sendModal').classList.add('hidden'); pending = null; });
$('#sendConfirm').addEventListener('click', () => { $('#sendModal').classList.add('hidden'); if (pending) analyze(pending); });

// ---------------------------------------------------------------------------
// 3. The pipeline: label (AI) → drift math (browser) → report (AI) → render
// ---------------------------------------------------------------------------
async function analyze({ source, items, cleaned }) {
  showAnalyzing();
  try {
    // 3a. Send ONLY cleaned titles to the labeler.
    step('Reading your content with the AI labeller…');
    const labels = await postJSON('/api/label', { items: cleaned });
    const byId = new Map((labels.labels || []).map((l) => [l.id, l]));

    // 3b. Re-attach labels to the LOCAL items (which keep durations + timestamps).
    const labeled = items.map((it, i) => {
      const l = byId.get('v' + i) || {};
      return {
        title: it.title,
        topic: l.topic || 'other',
        intensity: typeof l.intensity === 'number' ? l.intensity : 0.35,
        durationSec: Number(it.durationSec) || 0,
        watchedAt: it.watchedAt,
      };
    });

    // 3c. Drift type from fixed rules — runs right here in your browser.
    step('Applying the published drift rules (in your browser)…');
    const prepared = ensureUsableTimeline(labeled);
    const drift = computeDrift(prepared.items);
    if (prepared.estimated && drift.type !== 'insufficient') {
      // Timing was reconstructed, not measured — say so and never claim high confidence.
      drift.estimatedDates = true;
      if (drift.confidence === 'high') drift.confidence = 'medium';
    }

    // 3d. Report writer + tone checker. We send only the small drift summary.
    step('Writing your report and tone-checking it…');
    const res = await postJSON('/api/report', { drift });

    renderReport(drift, res.report, source);
  } catch (err) {
    console.error(err);
    showError('Something went wrong during analysis. Please try again — your data never left your browser.');
  }
}

async function postJSON(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ---------------------------------------------------------------------------
// 4. Rendering
// ---------------------------------------------------------------------------
const TYPE_LABEL = { escalation: 'Emotional Escalation', narrowing: 'Narrowing', engagement: 'Engagement Drift', mixed: 'Mixed / unclear', insufficient: 'Not enough data' };

function showAnalyzing() {
  const el = $('#report');
  el.classList.remove('hidden');
  el.innerHTML = `<div class="analyzing"><div class="spinner"></div><h2>Analysing your drift…</h2><p class="steps" id="stepText">Cleaning your file locally…</p></div>`;
  el.scrollIntoView({ behavior: 'smooth' });
}
function step(msg) { const s = $('#stepText'); if (s) s.textContent = msg; }

function renderReport(drift, report, source) {
  const el = $('#report');
  lastAnalysis = { drift, report, source };
  const type = TYPE_LABEL[drift.type] || 'Result';
  const confClass = drift.confidence === 'high' ? 'conf-high' : drift.confidence === 'medium' ? 'conf-medium' : '';
  const isReal = drift.type !== 'insufficient';

  const signalChips = (drift.allSignals || []).map((s) =>
    `<span class="chip">${TYPE_LABEL[s.type] || s.type}: +${s.percent}%</span>`).join('');

  const metricBar = isReal && drift.type !== 'mixed' ? `
    <div class="mini-metric">
      <div class="mini-label"><span>${escapeHtml(drift.metric || 'shift')}</span><span>+${drift.percent}% vs your earlier weeks</span></div>
      <div class="mini-bar"><span style="width:${Math.min(100, drift.percent)}%"></span></div>
    </div>` : '';

  el.innerHTML = `
    <div class="report-card">
      <div class="report-badges">
        <span class="badge type">${escapeHtml(type)}</span>
        ${isReal ? `<span class="badge ${confClass}">${drift.confidence} confidence</span>` : ''}
        <span class="badge">${drift.coverageDays || 0} days of history</span>
        ${drift.estimatedDates ? '<span class="badge">dates estimated</span>' : ''}
        <span class="badge">${escapeHtml(source)}</span>
      </div>
      <h2 class="headline">${escapeHtml(report.headline)}</h2>
      ${metricBar}
      <div class="block"><div class="k">What's driving it</div><p>${escapeHtml(report.driving)}</p></div>
      <div class="block"><div class="k">What changed with it</div><p>${escapeHtml(report.changed)}</p></div>
      ${signalChips ? `<div class="signals">${signalChips}</div>` : ''}
      <div class="block try"><div class="k">One thing to try</div><p>${escapeHtml(report.tryThis)}</p></div>
      <div class="report-foot">
        <button class="btn btn-ghost" onclick="location.reload()">Run another analysis</button>
        <button class="btn btn-ghost" id="askAboutReport" type="button">Ask the assistant about this →</button>
        <span class="badge">${report.toneChecked ? 'tone-checked ✓' : ''}</span>
        <span class="badge">${report.source === 'ai' ? 'AI-written' : report.source === 'fallback' ? 'pre-written fallback' : report.source === 'mock' ? 'demo report' : report.source || ''}</span>
      </div>
      <p class="report-note">Drift shows patterns, not proof — it never claims the algorithm <em>caused</em> anything, and compares you only to your own earlier weeks. Rules v${RULES_VERSION} · thresholds: narrowing &gt;${pctT(THRESHOLDS.narrowing)}, escalation &gt;${pctT(THRESHOLDS.escalation)}, engagement &gt;${pctT(THRESHOLDS.engagementShorter)} shorter &amp; &gt;${pctT(THRESHOLDS.engagementMoreOften)} more often.</p>
    </div>`;
  // The report just changed — refresh the assistant's suggestions if it's open.
  $('#askAboutReport')?.addEventListener('click', () => openChat());
  if (isChatOpen()) renderSuggest();
  el.scrollIntoView({ behavior: 'smooth' });
}

// ---------------------------------------------------------------------------
// 4b. The always-on assistant widget. Available anywhere on the page; answers
// general questions before an analysis, and grounds them in the report after.
// Sends only the (already-shared) drift summary + report + your questions.
// ---------------------------------------------------------------------------
const GENERAL_SUGGEST = ['How does Drift work?', 'What are the drift types?', 'What happens to my data?', 'What is the bookmarklet?'];
const REPORT_SUGGEST = ['What does my result mean?', 'Why might this have happened?', 'Is this reliable?', 'What could I try?'];

function isChatOpen() { return !$('#chatWidget')?.classList.contains('hidden'); }

function openChat() {
  const w = $('#chatWidget'); if (!w) return;
  w.classList.remove('hidden');
  const fab = $('#chatFab');
  fab?.classList.add('open');
  fab?.setAttribute('aria-expanded', 'true');
  renderSuggest();
  setTimeout(() => $('#cwInput')?.focus(), 60);
}

function closeChat() {
  const w = $('#chatWidget'); if (!w) return;
  w.classList.add('hidden');
  const fab = $('#chatFab');
  fab?.classList.remove('open');
  fab?.setAttribute('aria-expanded', 'false');
}

function renderSuggest() {
  const wrap = $('#cwSuggest');
  if (!wrap) return;
  const qs = lastAnalysis ? REPORT_SUGGEST : GENERAL_SUGGEST;
  wrap.innerHTML = '';
  qs.forEach((q) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip chip-btn';
    b.textContent = q;
    b.addEventListener('click', () => sendChat(q));
    wrap.appendChild(b);
  });
}

async function sendChat(question) {
  const q = String(question || '').trim();
  if (!q) return;
  const input = $('#cwInput');
  if (input) input.value = '';
  $('#cwIntro')?.classList.add('gone');
  appendChatMsg('user', q);
  const typing = appendChatMsg('assistant', 'Thinking…', true);
  try {
    const res = await postJSON('/api/chat', {
      drift: lastAnalysis?.drift || null,
      report: lastAnalysis?.report || null,
      history: chatHistory.slice(-8),
      question: q,
    });
    const answer = (res.answer || '').trim() || "I couldn't answer that one — try rephrasing?";
    typing.remove();
    appendChatMsg('assistant', answer);
    chatHistory.push({ role: 'user', content: q }, { role: 'assistant', content: answer });
  } catch (err) {
    console.error(err);
    typing.remove();
    appendChatMsg('assistant', 'Something went wrong reaching the assistant — your data never left your browser. Try again in a moment.');
  }
}

function appendChatMsg(role, text, temp) {
  const log = $('#cwLog');
  if (!log) return { remove() {} };
  const div = document.createElement('div');
  div.className = 'chat-msg ' + role + (temp ? ' typing' : '');
  div.textContent = text; // textContent — no HTML injection from AI or user text
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

// Wire the launcher once, on load.
$('#chatFab')?.addEventListener('click', () => (isChatOpen() ? closeChat() : openChat()));
$('#chatClose')?.addEventListener('click', closeChat);
$('#cwForm')?.addEventListener('submit', (e) => { e.preventDefault(); sendChat($('#cwInput').value); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isChatOpen()) closeChat(); });
renderSuggest();

function showError(msg) {
  const el = $('#report');
  el.classList.remove('hidden');
  el.innerHTML = `<div class="report-card"><h2 class="headline">We hit a snag</h2><p style="color:var(--muted)">${escapeHtml(msg)}</p><div class="report-foot"><button class="btn btn-ghost" onclick="location.reload()">Start over</button></div></div>`;
  el.scrollIntoView({ behavior: 'smooth' });
}

function pctT(x) { return Math.round(x * 100) + '%'; }
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
