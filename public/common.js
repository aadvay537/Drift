// common.js — shared by every page: the AI server connection, the "Ask Drift"
// assistant, safe text formatting, and small helpers.
import { askLocal, topicName } from './insights.js';

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const pct = (x) => Math.round(x * 100);
export const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;


// Whatever page you're on can register an analysis so the assistant can use it.
export const ctx = { analysis: null };

// ---------------------------------------------------------------------------
// The AI server. The page itself is served from GitHub Pages (instant); the AI
// lives on Render, which sleeps when idle. We start waking it the moment you
// arrive, so it's usually ready by the time you've found your history file.
// ---------------------------------------------------------------------------
export const API = /github\.io$/.test(location.hostname) || location.protocol === 'file:' ? 'https://drift-aatp.onrender.com' : '';
export const server = { up: false, live: false, waiters: [] };

function setBadge(kind, text) {
  const b = $('#modeBadge');
  if (!b) return;
  b.className = 'mode ' + kind;
  b.textContent = text;
}
async function wakeServer() {
  setBadge('waking', 'Waking the AI…');
  const t0 = Date.now();
  while (Date.now() - t0 < 6 * 60 * 1000) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch(API + '/api/status', { signal: ctl.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (r.ok) {
        const st = await r.json();
        server.up = true;
        server.live = st.mode === 'live' && st.health !== 'failing';
        if (server.live) setBadge('live', 'Live AI');
        else if (st.mode === 'live') setBadge('degraded', 'AI unavailable — using backup');
        else setBadge('', 'Demo engine');
        server.waiters.splice(0).forEach((fn) => fn(true));
        return;
      }
    } catch { /* still asleep — keep trying */ }
    await new Promise((res) => setTimeout(res, 4000));
  }
  setBadge('degraded', 'AI offline — using backup');
  server.waiters.splice(0).forEach((fn) => fn(false));
}
// Resolve true once the server answers, or false after `ms`.
export function waitForServer(ms) {
  if (server.up) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok) => { clearTimeout(t); resolve(ok); };
    const t = setTimeout(() => { server.waiters.splice(server.waiters.indexOf(done) >>> 0, 1); resolve(false); }, ms);
    server.waiters.push(done);
  });
}
wakeServer();

// Nav goes solid once you leave the hero.
const nav = $('#nav');
if (nav && document.querySelector('.hero')) addEventListener('scroll', () => nav.classList.toggle('scrolled', scrollY > 40), { passive: true });

export async function postJSON(url, body) {
  const r = await fetch(API + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) { const e = new Error(await r.text()); e.status = r.status; throw e; }
  return r.json();
}


// The assistant widget is the same on every page, so it's added here.
document.body.insertAdjacentHTML('beforeend', `
  <button id="chatFab" class="chat-fab" aria-label="Ask Drift a question" aria-expanded="false" type="button">Ask Drift</button>
  <section id="chatWidget" class="chat-widget hidden" role="dialog" aria-label="Drift assistant">
    <header class="cw-head">
      <span class="cw-title"><span class="cw-dot"></span>Ask Drift</span>
      <span class="cw-tools">
        <button id="chatNew" class="cw-btn" type="button" aria-label="Start a new chat" title="New chat"><svg viewBox="0 0 20 20"><path d="M10 4v12M4 10h12"/></svg></button>
        <button id="chatExpand" class="cw-btn" type="button" aria-label="Make bigger" title="Bigger"><svg viewBox="0 0 20 20"><path d="M12 3h5v5M8 17H3v-5M17 3l-6 6M3 17l6-6"/></svg></button>
        <button id="chatClose" class="cw-btn" type="button" aria-label="Close" title="Close"><svg viewBox="0 0 20 20"><path d="M5 5l10 10M15 5L5 15"/></svg></button>
      </span>
    </header>
    <div class="cw-log" id="cwLog" aria-live="polite"></div>
    <div class="cw-suggest" id="cwSuggest"></div>
    <form class="cw-form" id="cwForm" autocomplete="off">
      <textarea id="cwInput" rows="1" placeholder="Type any question…" aria-label="Your question" maxlength="2000"></textarea>
      <button class="cw-send" type="submit" aria-label="Send"><svg viewBox="0 0 20 20"><path d="M4 10h11M10 4l6 6-6 6"/></svg></button>
    </form>
  </section>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>`);
// Each chat box keeps its own conversation, so follow-up questions make sense.
export const chats = { '#askLog': [], '#cwLog': [] };

export async function ask(question, logSel, { fromChip = false } = {}) {
  const q = String(question || '').trim();
  if (!q) return;
  addMsg(logSel, 'user', q);
  const a = ctx.analysis;
  // Suggested questions about your own history are answered right here, on
  // this device (they can quote your titles, which never leave the browser).
  if (a && fromChip) {
    const local = askLocal(q, { items: a.items, weeks: a.weeks, drift: a.drift });
    if (local) { addMsg(logSel, 'assistant', local, 'Answered on your device'); chats[logSel].push({ role: 'user', content: q }, { role: 'assistant', content: local }); return; }
  }
  const bubble = addMsg(logSel, 'assistant', '', null, true);
  bubble.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
  setBusy(logSel, true);
  let text = '';
  try {
    if (!server.up) {
      bubble.innerHTML = '<span class="dots"><i></i><i></i><i></i></span> <span class="wake-note">Waking the AI — first visit takes up to a minute</span>';
      if (!(await waitForServer(150000))) { const e = new Error('asleep'); e.status = 503; throw e; }
      bubble.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
    }
    const r = await fetch(API + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drift: a?.drift || null, report: a?.report || null, stats: a ? chatStats(a) : null, history: chats[logSel].slice(-12), question: q }),
    });
    if (!r.ok) { const e = new Error('http'); e.status = r.status; throw e; }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', source = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.t) { text += m.t; bubble.classList.remove('typing'); bubble.innerHTML = md(text); scrollLog(logSel); }
        if (m.done) source = m.source;
        if (m.error) throw new Error(m.error);
      }
    }
    if (!text) throw new Error('empty');
    if (a && source === 'ai') appendSrc(bubble, 'Answered by the assistant, using your summary — no titles or names');
    chats[logSel].push({ role: 'user', content: q }, { role: 'assistant', content: text });
  } catch (err) {
    bubble.classList.remove('typing');
    if (!text) bubble.textContent = err.status === 503 ? 'The AI server is still starting up. Try again in a minute.' : err.status === 429 ? 'That\'s a lot of questions in a minute. Wait a moment and ask again.' : 'The assistant couldn\'t be reached just now. Check your connection and try again.';
  } finally { setBusy(logSel, false); }
}

// What the assistant may see about your data: small aggregates only —
// weekly totals, topic shares, hour-of-day shares, creator share percentages.
function chatStats(a) {
  const { items, weeks, file, extras } = a;
  const top = (t) => Object.entries(t || {}).sort((x, y) => y[1] - x[1])[0]?.[0] || '';
  const night = items.filter((x) => new Date(x.watchedAt).getHours() < 5).length;
  return {
    platform: file.platform || 'youtube',
    totalItems: items.length,
    weeks: weeks.map((w) => ({ week: w.label, items: w.count, sessions: w.sessions, intensity: w.intensity == null || !file.hasTitles ? null : +w.intensity.toFixed(2), topTopic: file.hasTitles ? topicName(top(w.topics)) : '' })),
    topicShift: (extras.shift || []).map((t) => ({ topic: topicName(t.topic), earlyShare: +t.early.toFixed(3), recentShare: +t.late.toFixed(3) })),
    hourShareRecent: extras.hours ? extras.hours.late.map((x) => +x.toFixed(3)) : [],
    hourShareEarlier: extras.hours ? extras.hours.early.map((x) => +x.toFixed(3)) : [],
    lateNightShare: items.length ? +(night / items.length).toFixed(3) : 0,
    top3CreatorShare: extras.creators ? { earlier: +extras.creators.earlyTop3.toFixed(3), recent: +extras.creators.lateTop3.toFixed(3) } : null,
    instagramInterests: extras.igTopics || [],
  };
}

function setBusy(logSel, busy) {
  const form = logSel === '#cwLog' ? $('#cwForm') : $('#askForm');
  form?.querySelector('button[type=submit]')?.toggleAttribute('disabled', busy);
}
function scrollLog(logSel) { const l = $(logSel); if (l) l.scrollTop = l.scrollHeight; }
function appendSrc(el, text) { const s = document.createElement('span'); s.className = 'src'; s.textContent = text; el.appendChild(s); }

export function addMsg(logSel, role, text, src, temp) {
  const log = $(logSel);
  if (!log) return { remove() {}, classList: { remove() {} } };
  const d = document.createElement('div');
  d.className = `msg ${role}${temp ? ' typing' : ''}`;
  if (role === 'assistant') d.innerHTML = md(text); else d.textContent = text;
  if (src) appendSrc(d, src);
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}

// Tiny, safe Markdown: escape everything first, then allow bold, italics,
// inline code, http(s) links, bullet and numbered lists, and paragraphs.
export function md(src) {
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Two levels of lists: indented bullets under a numbered or bulleted item nest inside it.
  let html = '', top = null, sub = false, liOpen = false;
  const closeSub = () => { if (sub) { html += '</ul>'; sub = false; } };
  const closeLi = () => { closeSub(); if (liOpen) { html += '</li>'; liOpen = false; } };
  const closeTop = () => { closeLi(); if (top) { html += `</${top}>`; top = null; } };
  for (const raw of String(src).split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const m = line.match(/^(\s*)([-*•]|\d+[.)])\s+(.*)/);
    if (m) {
      const indented = m[1].length >= 2;
      const tag = /\d/.test(m[2]) ? 'ol' : 'ul';
      if (indented && liOpen) {
        if (!sub) { html += '<ul>'; sub = true; }
        html += `<li>${inline(m[3])}</li>`;
        continue;
      }
      if (top !== tag) { closeTop(); html += `<${tag}>`; top = tag; } else closeLi();
      html += `<li>${inline(m[3])}`; liOpen = true;
      continue;
    }
    if (!line.trim()) { closeSub(); continue; }
    if (top && /^\s{2,}\S/.test(line) && liOpen) { html += ' ' + inline(line.trim()); continue; }
    closeTop();
    html += `<p>${inline(line.replace(/^#+\s*/, ''))}</p>`;
  }
  closeTop();
  return html;
}


// Floating assistant: ask anything, anywhere on the page.
const GENERAL_SUGGEST = ['How does Drift work?', 'How do YouTube recommendations actually work?', 'How do I get my Instagram data?', 'Help me plan a week with less scrolling'];
export function renderSuggest() {
  const qs = ctx.analysis ? ['What does my result mean?', 'Which week changed the most?', 'Help me plan next week', 'Is this reliable?'] : GENERAL_SUGGEST;
  const box = $('#cwSuggest');
  box.innerHTML = qs.map((q) => `<button type="button">${esc(q)}</button>`).join('');
  $$('#cwSuggest button').forEach((b) => b.addEventListener('click', () => { box.classList.add('hidden'); ask(b.textContent, '#cwLog'); }));
}
const openChat = () => { $('#chatWidget').classList.remove('hidden'); $('#chatFab').classList.add('open'); $('#chatFab').setAttribute('aria-expanded', 'true'); setTimeout(() => $('#cwInput').focus(), 50); };
const closeChat = () => { $('#chatWidget').classList.add('hidden'); $('#chatFab').classList.remove('open'); $('#chatFab').setAttribute('aria-expanded', 'false'); $('#chatFab').focus(); };
$('#chatFab').addEventListener('click', openChat);
$('#chatClose').addEventListener('click', closeChat);
$('#chatExpand').addEventListener('click', () => { const w = $('#chatWidget'); w.classList.toggle('big'); $('#chatExpand').setAttribute('aria-label', w.classList.contains('big') ? 'Make smaller' : 'Make bigger'); });
$('#chatNew').addEventListener('click', () => { chats['#cwLog'] = []; $('#cwLog').innerHTML = ''; addMsg('#cwLog', 'assistant', CHAT_HELLO()); $('#cwSuggest').classList.remove('hidden'); renderSuggest(); $('#cwInput').focus(); });
const CHAT_HELLO = () => ctx.analysis
  ? 'Ask me anything — about your result, your habits, or anything else on your mind.'
  : 'Hi! Ask me anything — how Drift works, how feeds and algorithms work, or anything else. I\'ll answer properly.';
const cwInput = $('#cwInput');
const sendCw = () => { const v = cwInput.value; if (!v.trim()) return; cwInput.value = ''; cwInput.style.height = ''; $('#cwSuggest').classList.add('hidden'); ask(v, '#cwLog'); };
$('#cwForm').addEventListener('submit', (e) => { e.preventDefault(); sendCw(); });
cwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCw(); } });
cwInput.addEventListener('input', () => { cwInput.style.height = 'auto'; cwInput.style.height = Math.min(140, cwInput.scrollHeight) + 'px'; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#chatWidget').classList.contains('hidden')) closeChat(); });
addMsg('#cwLog', 'assistant', CHAT_HELLO());
renderSuggest();

let toastT;
export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600);
}

// Mark the current page in the navigation.
const here = location.pathname.split('/').pop() || 'index.html';
document.querySelectorAll('.nav-links a').forEach((a) => { if (a.getAttribute('href') === here) a.setAttribute('aria-current', 'page'); });
