// results.js — public totals from everyone who chose to share an anonymous summary.
import { $, esc, API, waitForServer } from './common.js';

const TYPE = { escalation: 'Escalation', narrowing: 'Narrowing', engagement: 'Engagement drift', mixed: 'Mixed signal', rhythm: 'Rhythm shift', unknown: 'Unknown' };
const PLAT = { youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok', reddit: 'Reddit', unknown: 'Unknown' };
const ACC = { yes: 'Yes', partly: 'Partly', no: 'No', unsure: 'Not sure', unknown: 'Didn\'t answer' };

function bars(obj, names) {
  const entries = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, n]) => s + n, 0) || 1;
  return entries.map(([k, n]) => `
    <div class="bar-row"><span>${esc(names[k] || k)}</span>
      <span class="bar"><span style="width:${(n / total) * 100}%"></span></span>
      <span class="n">${n}</span></div>`).join('');
}

async function load() {
  const el = $('#results');
  if (!(await waitForServer(90000))) { el.innerHTML = '<p class="muted">The results server is starting up. Refresh in a minute.</p>'; return; }
  try {
    const r = await (await fetch(API + '/api/results', { cache: 'no-store' })).json();
    if (!r.total) {
      el.innerHTML = '<div class="tile wide"><h3>No shared results yet</h3><p class="muted">When people choose to share an anonymous summary of their report, the totals will appear here.</p><p style="margin-top:16px"><a class="btn btn-lantern" href="start.html">Get my report</a></p></div>';
      return;
    }
    el.innerHTML = `
      <div class="stat-row">
        <div class="tile"><div class="big-stat">${r.total}</div><p class="muted">people shared a summary</p></div>
        <div class="tile"><div class="big-stat">${r.averageScore ?? '–'}</div><p class="muted">average drift score</p></div>
        <div class="tile"><div class="big-stat">${r.averageLateNightShare == null ? '–' : Math.round(r.averageLateNightShare * 100) + '%'}</div><p class="muted">of watching after midnight, on average</p></div>
      </div>
      <div class="grid2">
        <div class="tile"><h3>Drift types found</h3>${bars(r.byType, TYPE)}</div>
        <div class="tile"><h3>"Did this feel accurate?"</h3>${bars(r.byAccuracy, ACC)}</div>
        <div class="tile"><h3>Apps</h3>${bars(r.byPlatform, PLAT)}</div>
        <div class="tile"><h3>Topics growing most</h3>${(r.topicGrowth || []).filter((t) => t.avgChange > 0).slice(0, 6).map((t) => `<div class="bar-row"><span>${esc(t.topic)}</span><span class="bar"><span style="width:${Math.min(100, t.avgChange * 400)}%"></span></span><span class="n">+${Math.round(t.avgChange * 100)}</span></div>`).join('') || '<p class="muted">Not enough data yet.</p>'}</div>
      </div>
      <p class="fine-print">Shares of each topic are compared between each person's earlier and recent weeks; "+5" means a topic's share grew by 5 points on average. ${r.storage && r.storage.startsWith('file') ? 'Note: results are currently kept in temporary storage and reset when the server updates.' : ''}</p>`;
  } catch {
    el.innerHTML = '<p class="muted">Couldn\'t load the results just now. Please refresh in a minute.</p>';
  }
}
load();
