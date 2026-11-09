// common.js — shared by every page: the AI server connection, the "Ask Drift"
// assistant, safe text formatting, and small helpers.
import { ChatView, chatBoxHTML, loadConvs, currentId, setCurrent, latestReport } from './chat.js';

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


// ---------------------------------------------------------------------------
// The "Ask Drift" bubble in the corner of every page (except the full Ask page).
// It shares the saved conversation with the full page, so you can switch.
// ---------------------------------------------------------------------------
const onAskPage = /ask\.html$/.test(location.pathname);
document.body.insertAdjacentHTML('beforeend', `
  ${onAskPage ? '' : `<button id="chatFab" class="chat-fab" aria-label="Ask Drift anything" aria-expanded="false" type="button">Ask Drift</button>
  <section id="chatWidget" class="chat-widget hidden" role="dialog" aria-label="Ask Drift">
    <header class="cw-head">
      <span class="cw-title"><span class="cw-dot"></span>Ask Drift</span>
      <span class="cw-tools">
        <button id="chatNew" class="cw-btn" type="button" aria-label="Start a new chat" title="New chat"><svg viewBox="0 0 20 20"><path d="M10 4v12M4 10h12"/></svg></button>
        <a id="chatFull" class="cw-btn" href="ask.html" aria-label="Open the full Ask Drift page" title="Full page"><svg viewBox="0 0 20 20"><path d="M12 3h5v5M8 17H3v-5M17 3l-6 6M3 17l6-6"/></svg></a>
        <button id="chatClose" class="cw-btn" type="button" aria-label="Close" title="Close"><svg viewBox="0 0 20 20"><path d="M5 5l10 10M15 5L5 15"/></svg></button>
      </span>
    </header>
    <div class="cw-body" id="cwBody">${chatBoxHTML()}</div>
  </section>`}
  <div id="toast" class="toast" role="status" aria-live="polite"></div>`);

export const HELLO = () => (ctx.analysis || latestReport())
  ? 'Hi! Ask me anything — about your report, your habits, or **anything else at all**. I can search the web, read screenshots and photos, help with homework or code, and more.'
  : 'Hi! I\'m **Ask Drift**. Ask me anything — how feeds and algorithms work, today\'s news, homework, maths, writing, advice, or how to use Drift. I can search the web and read photos and screenshots too.';
const GENERAL_SUGGEST = ['What happened in the news today?', 'How does the Instagram algorithm decide what I see?', 'Help me plan a week with less scrolling', 'How do I download my YouTube history on iPhone?'];
const REPORT_SUGGEST = ['What does my result mean?', 'Make me a plan for next week', 'Which week changed the most?', 'How do I reset my feed?'];

export function fillSuggest(box, view) {
  if (!box) return;
  const qs = (ctx.analysis || latestReport()) ? REPORT_SUGGEST : GENERAL_SUGGEST;
  box.innerHTML = qs.map((q) => `<button type="button">${esc(q)}</button>`).join('');
  box.classList.remove('hidden');
  box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => view.send(b.textContent)));
}

let widgetView = null;
if (!onAskPage) {
  const open = () => {
    $('#chatWidget').classList.remove('hidden'); $('#chatFab').classList.add('open'); $('#chatFab').setAttribute('aria-expanded', 'true');
    if (!widgetView) {
      widgetView = new ChatView({ root: $('#cwBody'), persist: true, getAnalysis: () => ctx.analysis, useReport: () => true });
      const cur = loadConvs().find((c) => c.id === currentId());
      widgetView.start(cur, HELLO());
      if (!cur) fillSuggest($('#cwBody [data-suggest]'), widgetView);
    }
    setTimeout(() => $('#cwBody [data-input]').focus(), 50);
  };
  const close = () => { $('#chatWidget').classList.add('hidden'); $('#chatFab').classList.remove('open'); $('#chatFab').setAttribute('aria-expanded', 'false'); $('#chatFab').focus(); };
  $('#chatFab').addEventListener('click', open);
  $('#chatClose').addEventListener('click', close);
  $('#chatNew').addEventListener('click', () => { setCurrent(null); widgetView?.start(null, HELLO()); fillSuggest($('#cwBody [data-suggest]'), widgetView); $('#cwBody [data-input]').focus(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#chatWidget').classList.contains('hidden')) close(); });
}

let toastT;
export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600);
}

// Mark the current page in the navigation.
const here = location.pathname.split('/').pop() || 'index.html';
document.querySelectorAll('.nav-links a').forEach((a) => { if (a.getAttribute('href') === here) a.setAttribute('aria-current', 'page'); });
