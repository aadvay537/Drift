// chat.js — Ask Drift, the assistant. One engine used by the full page
// (ask.html), the corner bubble on every page, and the panel in the report.
//
// - Streams answers as they're written, shows "Searching the web…", and lists sources.
// - Photos can be attached (resized in the browser first).
// - Voice input where the browser supports it.
// - Conversations are saved on this device only (localStorage), never on a server.
// - Uses your latest Drift report if you have one — summary numbers only,
//   never your history, titles or names.

import { askLocal, topicName } from './insights.js';

const API = /github\.io$/.test(location.hostname) || location.protocol === 'file:' ? 'https://drift-aatp.onrender.com' : '';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------------------
// Daily AI allowance: a random, anonymous id for this browser (not linked to
// anything about you), sent so the server can count today's AI uses.
// ---------------------------------------------------------------------------
export function deviceId() {
  try {
    let id = localStorage.getItem('drift.device');
    if (!id) { id = (crypto.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2))).replace(/[^a-z0-9-]/gi, ''); localStorage.setItem('drift.device', id); }
    return id;
  } catch { return ''; }
}
export const apiHeaders = () => ({ 'Content-Type': 'application/json', 'X-Drift-Device': deviceId() });
const usageListeners = new Set();
export function onUsage(fn) { usageListeners.add(fn); }
export function noteUsage(res) {
  const left = res?.headers?.get?.('X-Drift-Remaining');
  const limit = res?.headers?.get?.('X-Drift-Limit');
  if (left != null) usageListeners.forEach((fn) => fn(+left, +(limit || 4)));
}
export async function fetchUsage() {
  try { const r = await fetch(API + '/api/usage', { headers: apiHeaders(), cache: 'no-store' }); const j = await r.json(); if (j.remaining != null) usageListeners.forEach((fn) => fn(j.remaining, j.limit)); return j; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Saved conversations (this device only)
// ---------------------------------------------------------------------------
const CONV_KEY = 'drift.chats.v1';
const CUR_KEY = 'drift.chats.current';
const REPORT_KEY = 'drift.lastReport.v1';

export function loadConvs() { try { return JSON.parse(localStorage.getItem(CONV_KEY) || '[]'); } catch { return []; } }
function saveConvs(list) { try { localStorage.setItem(CONV_KEY, JSON.stringify(list.slice(0, 40))); } catch { /* full or private mode */ } }
export function deleteConv(id) { saveConvs(loadConvs().filter((c) => c.id !== id)); if (currentId() === id) setCurrent(null); }
export function clearConvs() { try { localStorage.removeItem(CONV_KEY); localStorage.removeItem(CUR_KEY); } catch { /* ignore */ } }
export function currentId() { try { return localStorage.getItem(CUR_KEY); } catch { return null; } }
export function setCurrent(id) { try { id ? localStorage.setItem(CUR_KEY, id) : localStorage.removeItem(CUR_KEY); } catch { /* ignore */ } }
function upsertConv(conv) {
  const list = loadConvs().filter((c) => c.id !== conv.id);
  list.unshift({ ...conv, updated: Date.now() });
  saveConvs(list);
}

// ---------------------------------------------------------------------------
// Your latest report, as a small summary the assistant may use.
// ---------------------------------------------------------------------------
export function saveLatestReport(a) {
  try {
    localStorage.setItem(REPORT_KEY, JSON.stringify({ at: Date.now(), platform: a.file.platform || 'youtube', sample: !!a.file.sample, drift: a.drift, report: a.report, stats: chatStats(a) }));
  } catch { /* ignore */ }
}
// Save any report-like context (e.g. the Screen Time quick check) for Ask Drift.
export function saveLatestContext(ctx) {
  try { localStorage.setItem(REPORT_KEY, JSON.stringify({ at: Date.now(), ...ctx })); } catch { /* ignore */ }
}
export function latestReport() { try { return JSON.parse(localStorage.getItem(REPORT_KEY) || 'null'); } catch { return null; } }
export function forgetLatestReport() { try { localStorage.removeItem(REPORT_KEY); } catch { /* ignore */ } }

// What the assistant may see about your data: small aggregates only.
export function chatStats(a) {
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

// ---------------------------------------------------------------------------
// Safe Markdown → HTML: paragraphs, headings, bold/italic, inline code, code
// blocks, links (http/https only), bullet and numbered lists (two levels), tables.
// Everything is escaped first, so nothing from an answer can run as code.
// ---------------------------------------------------------------------------
export function md(src) {
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  const lines = String(src).split('\n');
  let html = '', top = null, sub = false, liOpen = false;
  const closeSub = () => { if (sub) { html += '</ul>'; sub = false; } };
  const closeLi = () => { closeSub(); if (liOpen) { html += '</li>'; liOpen = false; } };
  const closeTop = () => { closeLi(); if (top) { html += `</${top}>`; top = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');
    // fenced code block
    if (/^\s*```/.test(line)) {
      closeTop();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      html += `<div class="code"><button class="copy-code" type="button">Copy</button><pre><code>${esc(buf.join('\n'))}</code></pre></div>`;
      continue;
    }
    // table: header row + separator row
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      closeTop();
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      i--;
      html += `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      continue;
    }
    const h = line.match(/^#{1,4}\s+(.*)/);
    if (h) { closeTop(); html += `<p class="h">${inline(h[1])}</p>`; continue; }
    const m = line.match(/^(\s*)([-*•]|\d+[.)])\s+(.*)/);
    if (m) {
      const indented = m[1].length >= 2;
      const tag = /\d/.test(m[2]) ? 'ol' : 'ul';
      if (indented && liOpen) { if (!sub) { html += '<ul>'; sub = true; } html += `<li>${inline(m[3])}</li>`; continue; }
      if (top !== tag) { closeTop(); html += `<${tag}>`; top = tag; } else closeLi();
      html += `<li>${inline(m[3])}`; liOpen = true;
      continue;
    }
    if (!line.trim()) { closeSub(); continue; }
    if (top && /^\s{2,}\S/.test(line) && liOpen) { html += ' ' + inline(line.trim()); continue; }
    closeTop();
    html += `<p>${inline(line)}</p>`;
  }
  closeTop();
  return html;
}

// ---------------------------------------------------------------------------
// Photos: resize in the browser so they're small enough to send.
// ---------------------------------------------------------------------------
export async function prepImage(file, max = 1568) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL('image/jpeg', 0.85);
    return { media_type: 'image/jpeg', data: dataUrl.split(',')[1], preview: c.width > 200 ? shrink(c) : dataUrl };
  } finally { URL.revokeObjectURL(url); }
}
function shrink(c) {
  const s = document.createElement('canvas');
  const k = 160 / Math.max(c.width, c.height);
  s.width = Math.round(c.width * k); s.height = Math.round(c.height * k);
  s.getContext('2d').drawImage(c, 0, 0, s.width, s.height);
  return s.toDataURL('image/jpeg', 0.7);
}

// ---------------------------------------------------------------------------
// The chat view
// ---------------------------------------------------------------------------
const ICON = {
  copy: '<svg viewBox="0 0 20 20"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/></svg>',
  retry: '<svg viewBox="0 0 20 20"><path d="M4 10a6 6 0 1 0 2-4.5M4 3v4h4"/></svg>',
};

/**
 * @param {object} o
 * @param {HTMLElement} o.root         container with [data-log] [data-form] [data-input] [data-send]; optional [data-attach] [data-file] [data-mic] [data-thumbs] [data-suggest]
 * @param {boolean} [o.persist]        save the conversation on this device
 * @param {() => object|null} [o.getAnalysis]  full in-page analysis (enables on-device answers)
 * @param {() => boolean} [o.useReport]        whether to include the saved latest report
 * @param {(conv)=>void} [o.onChange]
 */
export class ChatView {
  constructor(o) {
    this.o = o;
    this.root = o.root;
    this.log = o.root.querySelector('[data-log]');
    this.form = o.root.querySelector('[data-form]');
    this.input = o.root.querySelector('[data-input]');
    this.sendBtn = o.root.querySelector('[data-send]');
    this.thumbs = o.root.querySelector('[data-thumbs]');
    this.pending = [];
    this.busy = false;
    this.abort = null;
    this.conv = null;
    this.form.addEventListener('submit', (e) => { e.preventDefault(); this.sendFromInput(); });
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.sendFromInput(); } });
    this.input.addEventListener('input', () => this.autosize());
    this.log.addEventListener('click', (e) => this.onLogClick(e));
    this.setupAttach();
    this.setupMic();
    // "3 of 4 AI questions left today"
    this.usageEl = document.createElement('p');
    this.usageEl.className = 'usage-note';
    this.form.after(this.usageEl);
    onUsage((left, limit) => {
      this.usageEl.textContent = left > 0 ? `${left} of ${limit} free AI uses left today` : `No AI uses left today — they reset at midnight`;
      this.usageEl.classList.toggle('out', left <= 0);
    });
  }

  autosize() { this.input.style.height = 'auto'; this.input.style.height = Math.min(180, this.input.scrollHeight) + 'px'; }

  start(conv, hello) {
    this.conv = conv || { id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: '', messages: [] };
    this.log.innerHTML = '';
    if (!this.conv.messages.length && hello) this.bubble('assistant', hello, { hello: true });
    for (const m of this.conv.messages) this.bubble(m.role, m.content, { sources: m.sources, images: m.imageCount });
    this.scroll(true);
  }

  sendFromInput() {
    if (this.busy) { this.stop(); return; }
    const v = this.input.value.trim();
    if (!v && !this.pending.length) return;
    this.input.value = ''; this.autosize();
    this.send(v);
  }

  async send(text, { fromChip = false } = {}) {
    const q = String(text || '').trim();
    const images = this.pending.splice(0);
    this.renderThumbs();
    if (!q && !images.length) return;
    this.o.root.querySelector('[data-suggest]')?.classList.add('hidden');
    this.bubble('user', q, { images: images.length, previews: images.map((i) => i.preview) });

    // Suggested questions about your own history can be answered right here.
    const a = this.o.getAnalysis?.();
    if (a && fromChip) {
      const local = askLocal(q, { items: a.items, weeks: a.weeks, drift: a.drift });
      if (local) {
        this.bubble('assistant', local, { note: 'Answered on your device' });
        this.remember(q, local, [], images.length);
        return;
      }
    }

    const el = this.bubble('assistant', '', { typing: true });
    this.setBusy(true);
    const ctl = new AbortController();
    this.abort = ctl;
    let textOut = '', sources = [];
    const history = (this.conv?.messages || []).slice(-16).map((m) => ({ role: m.role, content: m.content }));
    const rep = this.o.getContext?.() || (a ? { drift: a.drift, report: a.report, stats: chatStats(a) } : (this.o.useReport?.() ? latestReport() : null));
    try {
      const r = await this.fetchWithWake(API + '/api/chat', {
        method: 'POST', headers: apiHeaders(), signal: ctl.signal,
        body: JSON.stringify({
          question: q, images: images.map(({ media_type, data }) => ({ media_type, data })),
          drift: rep?.drift || null, report: rep?.report || null, stats: rep?.stats || null,
          history, now: new Date().toISOString(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      }, el);
      noteUsage(r);
      if (!r.ok) { const e = new Error('http'); e.status = r.status; try { e.body = await r.json(); } catch { /* not json */ } throw e; }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m.s === 'searching') this.status(el, 'Searching the web…');
          if (m.t) { textOut += m.t; this.fill(el, textOut); }
          if (m.sources) sources = m.sources;
          if (m.error) throw new Error(m.error);
        }
      }
      if (!textOut) throw new Error('empty');
      this.finish(el, textOut, { sources });
      this.remember(q, textOut, sources, images.length);
    } catch (err) {
      if (err.name === 'AbortError') {
        if (textOut) { this.finish(el, textOut + '\n\n*(stopped)*', {}); this.remember(q, textOut, [], images.length); }
        else el.remove();
      } else if (textOut) {
        this.finish(el, textOut, {}); this.remember(q, textOut, [], images.length);
      } else {
        el.classList.remove('typing');
        el.innerHTML = `<p>${err.body?.error === 'daily_limit' ? `You've used today's ${err.body.limit || 4} free AI questions. They reset at midnight — see you tomorrow! (The suggested questions about your own report still work, because they're answered on your device.)` : err.status === 429 ? 'That\'s a lot of questions in a minute. Please wait a moment and try again.' : err.status === 503 ? 'The assistant is still starting up. Please try again in a minute.' : err.status === 413 ? 'Those photos are too large. Try fewer or smaller ones.' : 'The assistant couldn\'t be reached just now. Check your connection and try again.'}</p>`;
        el.dataset.retry = q;
        if (err.body?.error !== 'daily_limit') el.insertAdjacentHTML('beforeend', `<div class="msg-actions"><button class="ma" data-act="retry" type="button">${ICON.retry}<span>Try again</span></button></div>`);
      }
    } finally {
      this.abort = null;
      this.setBusy(false);
    }
  }

  // The AI server sleeps when idle; wait for it (up to ~2.5 min) instead of failing.
  async fetchWithWake(url, opts, el) {
    const t0 = Date.now();
    for (;;) {
      try {
        const r = await fetch(url, opts);
        if (r.status !== 502 && r.status !== 503 && r.status !== 504) return r;
      } catch (e) { if (e.name === 'AbortError') throw e; }
      if (Date.now() - t0 > 150000) { const e = new Error('asleep'); e.status = 503; throw e; }
      this.status(el, 'Waking up the assistant — the first question can take up to a minute…');
      await new Promise((r) => setTimeout(r, 4000));
    }
  }

  stop() { this.abort?.abort(); }

  remember(q, answer, sources, imageCount) {
    if (!this.conv) return;
    this.conv.messages.push({ role: 'user', content: q || '(photo)', imageCount: imageCount || 0 }, { role: 'assistant', content: answer, sources });
    if (!this.conv.title) this.conv.title = (q || 'Photo question').slice(0, 60);
    if (this.o.persist) { upsertConv(this.conv); setCurrent(this.conv.id); }
    this.o.onChange?.(this.conv);
  }

  // ---- rendering ----
  bubble(role, text, opt = {}) {
    const d = document.createElement('div');
    d.className = `msg ${role}${opt.typing ? ' typing' : ''}`;
    if (role === 'user') {
      if (opt.previews?.length) d.innerHTML = `<div class="msg-imgs">${opt.previews.map((p) => `<img src="${p}" alt="Attached photo" />`).join('')}</div>`;
      else if (opt.images) d.innerHTML = `<div class="msg-imgnote">📎 ${opt.images} photo${opt.images > 1 ? 's' : ''}</div>`;
      if (text) d.insertAdjacentHTML('beforeend', `<div>${esc(text).replace(/\n/g, '<br>')}</div>`);
    } else if (opt.typing) {
      d.innerHTML = '<span class="dots"><i></i><i></i><i></i></span><span class="status"></span>';
    } else {
      d.innerHTML = md(text);
      this.decorate(d, text, opt);
    }
    this.log.appendChild(d);
    this.scroll();
    return d;
  }
  status(el, txt) { const s = el.querySelector('.status'); if (s) s.textContent = txt; }
  fill(el, text) {
    el.classList.remove('typing');
    el.innerHTML = md(text);
    this.scroll();
  }
  finish(el, text, opt) {
    el.classList.remove('typing');
    el.innerHTML = md(text);
    this.decorate(el, text, opt);
    this.scroll();
  }
  decorate(el, text, opt) {
    if (opt.hello) return;
    el.dataset.text = text;
    if (opt.sources?.length) {
      el.insertAdjacentHTML('beforeend', `<div class="sources"><span>Sources</span>${opt.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(hostOf(s.url))}</a>`).join('')}</div>`);
    }
    if (opt.note) el.insertAdjacentHTML('beforeend', `<span class="src">${esc(opt.note)}</span>`);
    el.insertAdjacentHTML('beforeend', `<div class="msg-actions"><button class="ma" data-act="copy" type="button" aria-label="Copy answer">${ICON.copy}<span>Copy</span></button><button class="ma" data-act="retry" type="button" aria-label="Ask again">${ICON.retry}<span>Ask again</span></button></div>`);
  }
  async onLogClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.classList.contains('copy-code')) {
      const code = b.parentElement.querySelector('code')?.textContent || '';
      try { await navigator.clipboard.writeText(code); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1500); } catch { /* ignore */ }
      return;
    }
    const msg = b.closest('.msg');
    if (b.dataset.act === 'copy') {
      try { await navigator.clipboard.writeText(msg.dataset.text || msg.innerText); b.querySelector('span').textContent = 'Copied'; setTimeout(() => (b.querySelector('span').textContent = 'Copy'), 1500); } catch { /* ignore */ }
    }
    if (b.dataset.act === 'retry' && !this.busy) {
      // Ask the question before this answer again.
      let prev = msg.dataset.retry;
      if (!prev) { let p = msg.previousElementSibling; while (p && !p.classList.contains('user')) p = p.previousElementSibling; prev = p?.innerText?.replace(/^📎.*\n?/, '').trim(); }
      if (prev) this.send(prev);
    }
  }
  scroll(force) {
    const l = this.log;
    const near = l.scrollHeight - l.scrollTop - l.clientHeight < 160;
    if (force || near) l.scrollTop = l.scrollHeight;
  }
  setBusy(b) {
    this.busy = b;
    this.root.classList.toggle('busy', b);
    if (this.sendBtn) { this.sendBtn.setAttribute('aria-label', b ? 'Stop' : 'Send'); this.sendBtn.classList.toggle('stop', b); }
  }

  // ---- photos ----
  setupAttach() {
    const btn = this.root.querySelector('[data-attach]');
    const fi = this.root.querySelector('[data-file]');
    if (!btn || !fi) return;
    btn.addEventListener('click', () => fi.click());
    fi.addEventListener('change', async () => {
      for (const f of [...fi.files].slice(0, 4 - this.pending.length)) {
        if (!f.type.startsWith('image/')) continue;
        try { this.pending.push(await prepImage(f)); } catch { /* unreadable image */ }
      }
      fi.value = '';
      this.renderThumbs();
      this.input.focus();
    });
    // paste a screenshot straight into the box
    this.input.addEventListener('paste', async (e) => {
      const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      for (const f of files.slice(0, 4 - this.pending.length)) { try { this.pending.push(await prepImage(f)); } catch { /* ignore */ } }
      this.renderThumbs();
    });
  }
  renderThumbs() {
    if (!this.thumbs) return;
    this.thumbs.innerHTML = this.pending.map((p, i) => `<span class="thumb"><img src="${p.preview}" alt="" /><button type="button" data-rm="${i}" aria-label="Remove photo">✕</button></span>`).join('');
    this.thumbs.classList.toggle('hidden', !this.pending.length);
    this.thumbs.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { this.pending.splice(+b.dataset.rm, 1); this.renderThumbs(); }));
  }

  // ---- voice ----
  setupMic() {
    const btn = this.root.querySelector('[data-mic]');
    if (!btn) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { btn.classList.add('hidden'); return; }
    let rec = null, base = '';
    btn.addEventListener('click', () => {
      if (rec) { rec.stop(); return; }
      rec = new SR();
      rec.lang = navigator.language || 'en-IN';
      rec.interimResults = true;
      rec.continuous = false;
      base = this.input.value ? this.input.value.trim() + ' ' : '';
      rec.onresult = (e) => {
        let t = '';
        for (const r of e.results) t += r[0].transcript;
        this.input.value = base + t;
        this.autosize();
      };
      rec.onend = () => { rec = null; btn.classList.remove('on'); btn.setAttribute('aria-label', 'Speak your question'); this.input.focus(); };
      rec.onerror = () => {};
      btn.classList.add('on');
      btn.setAttribute('aria-label', 'Stop listening');
      try { rec.start(); } catch { rec = null; btn.classList.remove('on'); }
    });
  }
}

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } }

// Markup for a chat box (used by the corner bubble and the report panel).
export function chatBoxHTML({ placeholder = 'Ask anything…' } = {}) {
  return `
    <div class="cw-log" data-log aria-live="polite"></div>
    <div class="cw-suggest" data-suggest></div>
    <div class="thumbs hidden" data-thumbs></div>
    <form class="cw-form" data-form autocomplete="off">
      <button class="cw-tool" data-attach type="button" aria-label="Add a photo or screenshot" title="Add a photo"><svg viewBox="0 0 20 20"><path d="M15.5 9.5 9.6 15.4a3.5 3.5 0 0 1-5-5l6.4-6.4a2.3 2.3 0 0 1 3.3 3.3L8 13.6a1.2 1.2 0 0 1-1.7-1.7l5.6-5.6"/></svg></button>
      <input type="file" data-file accept="image/*" multiple hidden />
      <textarea data-input rows="1" placeholder="${esc(placeholder)}" aria-label="Your question" maxlength="8000"></textarea>
      <button class="cw-tool" data-mic type="button" aria-label="Speak your question" title="Speak"><svg viewBox="0 0 20 20"><rect x="7" y="2.5" width="6" height="10" rx="3"/><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5"/></svg></button>
      <button class="cw-send" data-send type="submit" aria-label="Send"><svg class="i-send" viewBox="0 0 20 20"><path d="M4 10h11M10 4l6 6-6 6"/></svg><svg class="i-stop" viewBox="0 0 20 20"><rect x="5.5" y="5.5" width="9" height="9" rx="1.5"/></svg></button>
    </form>`;
}
