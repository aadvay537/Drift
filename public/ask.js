// ask.js — the full Ask Drift page: chat + your saved chats + your latest report.
import { $, esc, HELLO } from './common.js';
import { ChatView, loadConvs, deleteConv, clearConvs, currentId, setCurrent, latestReport, forgetLatestReport } from './chat.js';

let useReport = true;
const view = new ChatView({
  root: $('#askChat'),
  persist: true,
  useReport: () => useReport,
  onChange: () => renderList(),
});

const STARTERS = [
  ['📰', 'What\'s in the news today?'],
  ['📱', 'How does the Instagram algorithm decide what I see?'],
  ['🌙', 'Help me stop scrolling late at night'],
  ['📚', 'Explain photosynthesis simply, then quiz me'],
  ['🧮', 'Solve 3x² − 12x + 9 = 0 and show the steps'],
  ['✉️', 'Help me write a polite email to my teacher'],
];
const REPORT_STARTERS = [
  ['📊', 'What does my latest report mean?'],
  ['🗓️', 'Make me a simple plan for next week'],
  ['🔄', 'How do I reset my feed?'],
  ['🌙', 'Help me stop scrolling late at night'],
];

function starters() {
  const box = $('#askChat [data-suggest]');
  const list = (latestReport() && useReport) ? REPORT_STARTERS : STARTERS;
  box.innerHTML = list.map(([i, q]) => `<button type="button"><span aria-hidden="true">${i}</span>${esc(q)}</button>`).join('');
  box.classList.remove('hidden');
  box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => view.send(b.textContent.replace(/^\S+\s*/u, '').trim() || b.textContent)));
}

function openConv(conv) {
  view.start(conv, conv ? null : HELLO());
  if (conv) { setCurrent(conv.id); $('#askChat [data-suggest]').classList.add('hidden'); }
  else { setCurrent(null); starters(); }
  renderList();
  document.body.classList.remove('side-open');
  $('#askChat [data-input]').focus();
}

function renderList() {
  const list = loadConvs();
  const cur = view.conv?.id;
  $('#convList').innerHTML = list.length
    ? list.map((c) => `<div class="conv${c.id === cur ? ' on' : ''}"><button class="conv-open" data-id="${esc(c.id)}" type="button">${esc(c.title || 'New chat')}<small>${esc(when(c.updated))}</small></button><button class="conv-del" data-del="${esc(c.id)}" type="button" aria-label="Delete this chat">✕</button></div>`).join('')
    : '<p class="muted small">Your chats will appear here.</p>';
  $('#convList').querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => openConv(loadConvs().find((c) => c.id === b.dataset.id))));
  $('#convList').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => { deleteConv(b.dataset.del); if (b.dataset.del === view.conv?.id) openConv(null); else renderList(); }));
}

function when(t) {
  if (!t) return '';
  const d = new Date(t), now = new Date();
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function renderReportChip() {
  const r = latestReport();
  const chip = $('#reportChip');
  if (!r) { chip.classList.add('hidden'); return; }
  const name = { youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok', reddit: 'Reddit' }[r.platform] || 'YouTube';
  chip.innerHTML = `<label><input type="checkbox" id="useRep" ${useReport ? 'checked' : ''}/> Use my latest report</label>
    <small>${esc(name)}${r.sample ? ' example' : ''}, ${esc(new Date(r.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))}</small>
    <button class="linkish" id="forgetRep" type="button">Forget it</button>`;
  chip.classList.remove('hidden');
  $('#useRep').addEventListener('change', (e) => { useReport = e.target.checked; if (!view.conv?.messages.length) starters(); });
  $('#forgetRep').addEventListener('click', () => { forgetLatestReport(); renderReportChip(); if (!view.conv?.messages.length) starters(); });
}

$('#newChat').addEventListener('click', () => openConv(null));
$('#clearAll').addEventListener('click', () => { if (confirm('Delete all your saved chats on this device?')) { clearConvs(); openConv(null); } });
$('#sideToggle').addEventListener('click', () => document.body.classList.toggle('side-open'));

renderReportChip();
const q = new URLSearchParams(location.search).get('q');
openConv(q ? null : loadConvs().find((c) => c.id === currentId()) || null);
if (q) view.send(q);
