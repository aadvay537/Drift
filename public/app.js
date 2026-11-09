// app.js — the browser orchestrator. Nothing identifying leaves this page except
// cleaned titles (YouTube/Reddit), and only after you approve the preview.
import { computeDrift, RULES_VERSION } from './drift.js';
import { ensureUsableTimeline, parseFlexibleDate, cleanItems, normalizeHistoryFile } from './normalize.js';
import { readHistoryFile } from './platforms.js';
import { keywordLabel } from './labeler.js';
import { weeklyTimeline, turningPoint, creatorConcentration, hourProfile, topicShift, topicName } from './insights.js';
import { $, $$, esc, pct, reduceMotion, ctx, API, server, waitForServer, postJSON, toast } from './common.js';
import { ChatView, chatBoxHTML, saveLatestReport, prepImage } from './chat.js';
import { planTile, wirePlan, planFromAnalysis } from './plan.js';
import { readImages, youtubeTextFromScreens, parseScreenTime, fmtMin, isSocial } from './ocr.js';
import { saveLatestContext } from './chat.js';

const state = {
  platform: null,
  pending: null,     // waiting on the send preview
  analysis: null,    // { drift, report, items, weeks, file, extras }
  chat: [],          // completed turns, for the AI assistant
  bmHref: '#',
  bmSource: '',
};

const rv = $('#rulesV'); if (rv) rv.textContent = RULES_VERSION;

// ---------------------------------------------------------------------------
// Steps: pick → get → run
// ---------------------------------------------------------------------------
function goStep(n) {
  $('#stepConsent').classList.toggle('hidden', n !== 1);
  $('#stepPick').classList.toggle('hidden', n !== 2);
  $('#stepGet').classList.toggle('hidden', n !== 3);
  $('#stepRun').classList.toggle('hidden', n !== 4);
  $$('#stepper li').forEach((li) => {
    const s = +li.dataset.step;
    li.classList.toggle('on', s === n);
    li.classList.toggle('done', s < n);
  });
}

$$('.platform, .quick').forEach((b) => b.addEventListener('click', () => {
  state.platform = b.dataset.platform;
  renderGuide(state.platform, b.dataset.tab);
  goStep(3);
  $('#start').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
}));
$('#backToPick').addEventListener('click', () => goStep(2));
$('#backToConsent').addEventListener('click', () => goStep(1));
$('#sampleBtn').addEventListener('click', loadSample);

// ---------------------------------------------------------------------------
// Step 1: the consent questions. Sharing an anonymous summary is optional;
// 13–17s need a parent's OK; nothing is ever shared for under-13s.
// ---------------------------------------------------------------------------
const CONSENT_KEY = 'drift.consent.v1';
function loadConsent() { try { return JSON.parse(localStorage.getItem(CONSENT_KEY) || 'null'); } catch { return null; } }
state.consent = loadConsent();

function readConsentForm() {
  const share = $('input[name=share]:checked')?.value;
  const age = $('input[name=age]:checked')?.value;
  const parent = $('input[name=parent]:checked')?.value;
  $('#qAge').classList.toggle('hidden', share !== 'yes');
  $('#qParent').classList.toggle('hidden', !(share === 'yes' && age === '13-17'));
  const note = $('#consentNote');
  let ready = false, result = null;
  if (share === 'no') { ready = true; result = { share: false }; note.textContent = 'Nothing will be kept.'; }
  else if (share === 'yes' && age === '18+') { ready = true; result = { share: true, ageGroup: '18+' }; note.textContent = 'Thank you!'; }
  else if (share === 'yes' && age === 'under13') { ready = true; result = { share: false }; note.textContent = 'Nothing is kept for under-13s.'; }
  else if (share === 'yes' && age === '13-17' && parent === 'yes') { ready = true; result = { share: true, ageGroup: '13-17' }; note.textContent = 'Thank you!'; }
  else if (share === 'yes' && age === '13-17' && parent === 'no') { ready = true; result = { share: false }; note.textContent = 'No problem — nothing will be kept.'; }
  else note.textContent = '';
  $('#consentNext').disabled = !ready;
  return result;
}
$$('#stepConsent input').forEach((i) => i.addEventListener('change', readConsentForm));
$('#consentNext').addEventListener('click', () => {
  const c = readConsentForm();
  if (!c) return;
  state.consent = { ...c, at: Date.now() };
  try { localStorage.setItem(CONSENT_KEY, JSON.stringify(state.consent)); } catch { /* private mode */ }
  goStep(2);
  $('#start').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
});
// Pre-fill a choice made on an earlier visit (they can still change it).
if (state.consent) {
  const c = state.consent;
  const set = (name, v) => { const el = $(`input[name=${name}][value="${v}"]`); if (el) el.checked = true; };
  set('share', c.share ? 'yes' : 'no');
  if (c.share) { set('age', c.ageGroup); if (c.ageGroup === '13-17') set('parent', 'yes'); }
  readConsentForm();
}
// "See an example first" from the home page goes straight to the sample.
if (new URLSearchParams(location.search).has('sample')) loadSample();

// ---------------------------------------------------------------------------
// Per-platform guides. One clear recommended route, alternatives in tabs.
// ---------------------------------------------------------------------------
// Short steps for each app. Extra detail sits in a "More info" dropdown.
const more = (t) => `<details class="more-info"><summary>More info</summary><p>${t}</p></details>`;
const steps = (...xs) => `<ol class="howto">${xs.map((x) => `<li><span>${x}</span></li>`).join('')}</ol>`;
const SHOT_LOCAL = more('Your screenshots are read on your phone and never uploaded. Only the video titles go to the AI, after you\'ve seen them. Dates are estimated if the screenshots don\'t show them.');
const SHOT_AI = more('These screenshots show pictures, not titles, so they are sent to the AI to recognise what kind of videos they are. You\'ll see a preview first. They\'re deleted straight after, and the AI is told to ignore names.');
const GUIDES = {
  youtube: {
    title: 'YouTube',
    tabs: {
      'Screenshots': steps('YouTube app → <strong>You</strong> → <strong>History</strong> → <strong>View all</strong>', 'Screenshot, scroll, repeat — <strong>5–10</strong> is great', 'Tap <strong>Choose</strong> and pick them all') + SHOT_LOCAL,
      'Google Takeout': steps('Open <a href="https://takeout.google.com/settings/takeout/custom/youtube" target="_blank" rel="noopener">Google Takeout</a> (YouTube is pre-selected)', 'Keep only <strong>history</strong>, format <strong>JSON</strong>', '<strong>Create export</strong>, then add the .zip here') + more('Google emails the file, usually within minutes. You don\'t need to unzip it. Takeout has no video lengths, so "shorter videos" can\'t be measured — everything else works.'),
      'Quick grab': 'BOOKMARKLET',
      'Paste': 'PASTE',
    },
  },
  instagram: {
    title: 'Instagram',
    tabs: {
      'Screenshots': steps('Profile → <strong>☰</strong> → <strong>Your activity</strong> → <strong>Watch history</strong>', 'Screenshot, scroll, repeat — <strong>5–10</strong> is great', 'Tap <strong>Choose</strong> and pick them all') + SHOT_AI,
      'Download': steps('Open <a href="https://accountscenter.instagram.com/info_and_permissions/dyi/" target="_blank" rel="noopener">Download your information</a>', 'Pick <strong>Ads information</strong> + <strong>Your activity</strong>, format <strong>JSON</strong>', 'When it\'s emailed, add the .zip here') + more('Can take minutes to a couple of days. The download has no captions, so Drift shows your rhythm and which creators fill your feed. Nothing from it is sent anywhere.'),
    },
  },
  tiktok: {
    title: 'TikTok',
    tabs: {
      'Screenshots': steps('Profile → <strong>☰</strong> → <strong>Settings and privacy</strong> → <strong>Activity center</strong> → <strong>Watch history</strong>', 'Screenshot, scroll, repeat — <strong>5–10</strong> is great', 'Tap <strong>Choose</strong> and pick them all') + SHOT_AI,
      'Download': steps('<strong>Settings and privacy</strong> → <strong>Account</strong> → <strong>Download your data</strong>', 'Choose <strong>JSON</strong> and request it', 'When it\'s ready, add the .zip here') + more('Can take minutes to a few days. The download only says when you watched, so Drift shows your rhythm. Nothing from it is sent anywhere.'),
    },
  },
  reddit: {
    title: 'Reddit',
    tabs: {
      'Screenshots': steps('Reddit app → your profile → <strong>History</strong> (or Recently viewed)', 'Screenshot, scroll, repeat — <strong>5–10</strong> is great', 'Tap <strong>Choose</strong> and pick them all') + SHOT_LOCAL,
      'Quick grab': 'BOOKMARKLET',
      'Paste': 'PASTE',
    },
  },
  screentime: {
    title: 'Screen Time check',
    tabs: {
      'iPhone': steps('<strong>Settings</strong> → <strong>Screen Time</strong> → <strong>See All App &amp; Website Activity</strong> → <strong>Week</strong>', 'Screenshot the top (<strong>Daily Average</strong>)', 'Scroll down and screenshot again until the <strong>whole app list</strong> is in (2–4 is fine)', 'Skip the App Limits part — only usage counts') + 'QUICK_QS',
      'Android': steps('<strong>Settings</strong> → <strong>Digital Wellbeing</strong>', 'Screenshot the circle', 'Scroll and screenshot until the <strong>whole app list</strong> is in (2–4 is fine)') + 'QUICK_QS',
    },
  },
};

function bookmarkletHtml() {
  return `
    <a id="bookmarklet" class="grab" href="${esc(state.bmHref)}" draggable="true" title="Drag me to your bookmarks bar">Grab my history</a>
    ${steps('Drag the yellow button to your bookmarks bar', 'Open your <a href="https://www.youtube.com/feed/history" target="_blank" rel="noopener">history page</a> and click it', 'Scroll a bit, then <strong>Download</strong> and add the file here')}
    <details class="more-info"><summary>More info</summary>
      <p>Computer only. It reads only the page you click it on and talks to no server. Installed before? Drag it up again to update it.</p>
      <p><button id="copyBm" class="btn btn-quiet btn-sm" type="button">Copy the script</button></p>
      <details><summary>Read the script</summary><pre>${esc(state.bmSource || 'loading…')}</pre></details>
    </details>`;
}

const PASTE_HTML = `
  <div class="paste">
    ${steps('On your history page: select all, copy', 'Paste below')}
    <textarea id="pasteArea" placeholder="Paste here"></textarea>
    <div class="row">
      <select id="pasteSource" aria-label="Where it's from"><option value="youtube">YouTube</option><option value="reddit">Reddit</option></select>
      <button id="pasteBtn" class="btn btn-lantern btn-sm" type="button">Analyse</button>
    </div>
  </div>`;

const IS_PHONE = /iphone|ipad|android/i.test(navigator.userAgent);
const IS_ANDROID = /android/i.test(navigator.userAgent);
const QUICK_QS = `
  <div class="quick-qs">
    <label>Scroll most<select name="qWhen"><option value="">Choose…</option>${['Morning', 'Afternoon', 'Evening', 'Late at night'].map((v) => `<option>${v}</option>`).join('')}</select></label>
    <label>Feel after<select name="qFeel"><option value="">Choose…</option>${['Good', 'Fine', 'Tired', 'Low or anxious', 'Like I wasted time'].map((v) => `<option>${v}</option>`).join('')}</select></label>
    <label>Open it for<select name="qWhy"><option value="">Choose…</option>${['To relax', 'Boredom', 'Friends and messages', 'News and updates', 'Just habit'].map((v) => `<option>${v}</option>`).join('')}</select></label>
  </div>`;

function renderGuide(platform, preferTab) {
  const g = GUIDES[platform];
  const names = Object.keys(g.tabs);
  $('#guide').innerHTML = `
    <h3>${esc(g.title)}</h3>
    ${names.length > 1 ? `<div class="tabs" role="tablist">${names.map((n, i) => `<button class="tab" role="tab" aria-selected="${i === 0}" data-tab="${esc(n)}" type="button">${esc(n)}</button>`).join('')}</div>` : ''}
    <div id="tabBody"></div>`;
  const show = (name) => {
    const v = g.tabs[name];
    $('#tabBody').innerHTML = v === 'BOOKMARKLET' ? bookmarkletHtml() : v === 'PASTE' ? PASTE_HTML : v.replace('QUICK_QS', QUICK_QS);
    $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    $('#pasteSource') && ($('#pasteSource').value = platform === 'reddit' ? 'reddit' : 'youtube');
    wireGuide();
  };
  $$('.tab').forEach((t) => t.addEventListener('click', () => show(t.dataset.tab)));
  const first = preferTab && g.tabs[preferTab] ? preferTab
    : platform === 'screentime' ? (IS_ANDROID ? 'Android' : 'iPhone')
    : g.tabs.Screenshots && (IS_PHONE || platform !== 'youtube') ? 'Screenshots' : names.find((n) => n !== 'Screenshots') || names[0];
  show(first);
  const shots = platform === 'screentime';
  $('#dropTitle').textContent = shots ? 'Add your screenshot' : 'Add screenshots or a file';
  $('#dropBtn').textContent = 'Choose';
  $('#dropSub').textContent = '';
}

function wireGuide() {
  const a = $('#bookmarklet');
  if (a) a.addEventListener('click', (e) => { e.preventDefault(); toast('Drag this up to your bookmarks bar — clicking it here does nothing.'); });
  $('#copyBm')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(state.bmHref); toast('Script copied'); }
    catch { toast('Couldn\'t copy — long-press the yellow button instead'); }
  });
  $('#pasteBtn')?.addEventListener('click', () => {
    const text = $('#pasteArea').value.trim();
    if (text.length < 40) return toast('Paste a bit more of your history page first.');
    ingest(parsePastedHistory(text, $('#pasteSource').value));
  });
}

// Build the draggable bookmarklet straight from the readable source, so the
// button and the code you can read are provably the same thing.
fetch('bookmarklet.js').then((r) => r.text()).then((src) => {
  state.bmSource = src;
  state.bmHref = 'javascript:' + encodeURIComponent(
    src.replace(/\/\*[\s\S]*?\*\//g, '')
       .replace(/^\s*\/\/.*$/gm, '')
       .replace(/([^:])\/\/[^\n]*/g, '$1') // trailing comments, keeping URLs
       .replace(/\n\s*/g, ' ')
       .trim());
  if (state.platform) renderGuide(state.platform);
}).catch(() => {});

// ---------------------------------------------------------------------------
// Getting a file in
// ---------------------------------------------------------------------------
const drop = $('#drop');
['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('drag')));
drop.addEventListener('drop', (e) => { e.preventDefault(); const fs = [...(e.dataTransfer.files || [])]; if (fs.length) readFiles(fs); });
drop.addEventListener('click', () => $('#fileInput').click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#fileInput').click(); } });
$('#fileInput').addEventListener('change', (e) => { const fs = [...(e.target.files || [])]; if (fs.length) readFiles(fs); e.target.value = ''; });

// Photos → screenshot modes (read on this device); anything else → history file.
function readFiles(files) {
  const imgs = files.filter((f) => f.type.startsWith('image/') || /\.(png|jpe?g|heic|webp)$/i.test(f.name));
  if (!imgs.length) return readFile(files[0]);
  if (state.platform === 'screentime') return quickCheck(imgs);
  if (state.platform === 'instagram' || state.platform === 'tiktok') return visionScreens(imgs, state.platform);
  return textScreens(imgs, state.platform === 'reddit' ? 'reddit' : 'youtube');
}

function showBusy(title, line) {
  goStep(4);
  $('#stepRun').innerHTML = `<div class="running"><h3>${esc(title)}</h3><ol class="run-steps"><li class="now" id="busyLine">${esc(line)}</li></ol><p class="muted">This happens on your device. Nothing is uploaded.</p></div>`;
  $('#start').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
  return (t) => { const l = $('#busyLine'); if (l) l.textContent = t; };
}

async function textScreens(imgs, source) {
  const set = showBusy('Reading your screenshots…', 'Getting ready…');
  try {
    const pages = await readImages(imgs.slice(0, 30), set);
    const text = youtubeTextFromScreens(pages);
    const file = parsePastedHistory(text, source);
    file.screenshots = true;
    if (file.items.length < 15) {
      return showError(file.items.length ? `We could read ${file.items.length} videos` : 'We couldn\'t find video titles in those screenshots',
        'Drift needs at least 15. Take a few more screenshots (5–10 is usually enough).');
    }
    ingest(file);
  } catch (err) {
    console.error(err);
    showError('We couldn\'t read those screenshots', 'Please try again, or use Google Takeout instead.');
  }
}

// Instagram / TikTok watch history = thumbnails. With the person's OK, the
// screenshots go to the AI to recognise the topics (1 AI use), then deleted.
async function visionScreens(imgs, platform) {
  const set = showBusy('Preparing your screenshots…', 'Getting them ready…');
  try {
    const images = [];
    for (const f of imgs.slice(0, 10)) images.push(await prepImage(f, 1200));
    set('Ready');
    const name = platformName(platform);
    state.pending = { file: { platform, source: platform, vision: true, hasTitles: true, images, items: [] }, items: [], cleaned: [] };
    $('#sendLede').textContent = `These ${images.length} screenshots go to the AI so it can recognise what kind of ${name} videos you watch. They're deleted right after.`;
    $('#sendStats').innerHTML = `<div><b>${images.length}</b><span>screenshots sent</span></div><div><b>0</b><span>kept afterwards</span></div><div><b>1</b><span>AI use today</span></div>`;
    $('#sendPreview').classList.add('hidden');
    $('#sendThumbs').innerHTML = images.map((im) => `<img src="${im.preview}" alt="" />`).join('');
    $('#sendThumbs').classList.remove('hidden');
    goStep(3);
    $('#sendModal').classList.remove('hidden');
    $('#sendConfirm').focus();
  } catch (err) {
    console.error(err);
    showError('We couldn\'t open those screenshots', 'Please try again with regular screenshots (PNG or JPG).');
  }
}

// ---------------------------------------------------------------------------
// The Screen Time quick check: one screenshot + three questions → a short
// report and a personal plan. Only app names, minutes and answers are used.
// ---------------------------------------------------------------------------
function quickAnswers() {
  return { when: $('select[name=qWhen]')?.value || '', feel: $('select[name=qFeel]')?.value || '', why: $('select[name=qWhy]')?.value || '' };
}

// Up to 6 screenshots (the app list rarely fits in one). With the person's OK
// the AI reads them (1 AI use) — it knows App Limits aren't usage. If that
// isn't possible, the on-device reader is the backup. Then they check the numbers.
async function quickCheck(imgs) {
  const answers = quickAnswers();
  const files = imgs.slice(0, 6);
  const set = showBusy('Preparing your screenshots…', 'Getting them ready…');
  try {
    const images = [];
    for (const f of files) images.push(await prepImage(f, 1568));
    set('Ready');
    state.pending = { screentime: true, files, images, answers };
    $('#sendLede').textContent = `${images.length === 1 ? 'This screenshot goes' : `These ${images.length} screenshots go`} to the AI to read your app times. Limits are ignored. Deleted right after.`;
    $('#sendStats').innerHTML = `<div><b>${images.length}</b><span>screenshots sent</span></div><div><b>0</b><span>kept afterwards</span></div><div><b>1</b><span>AI use today</span></div>`;
    $('#sendPreview').classList.add('hidden');
    $('#sendThumbs').innerHTML = images.map((im) => `<img src="${im.preview}" alt="" />`).join('');
    $('#sendThumbs').classList.remove('hidden');
    goStep(3);
    $('#sendModal').classList.remove('hidden');
    $('#sendConfirm').focus();
  } catch (err) {
    console.error(err);
    showError('We couldn\'t open those screenshots', 'Please try again with regular screenshots (PNG or JPG).');
  }
}

async function readScreenTimeShots(p) {
  const set = showBusy('Reading your Screen Time…', 'Reading app times…');
  const note = $('#stepRun .running .muted'); if (note) note.textContent = 'Screenshots are deleted right after.';
  let st = null;
  try {
    const r = await postJSON('/api/screentime', { images: p.images.map(({ media_type, data }) => ({ media_type, data })) });
    st = r.screenTime;
  } catch (err) {
    console.warn('AI reading failed, using the on-device reader', err);
    if (err?.body?.error === 'daily_limit') state.limitHit = true;
  }
  if (!st || (!st.apps?.length && !st.dailyMinutes)) {
    try {
      set('Reading on this device…');
      st = parseScreenTime(await readImages(p.files, set));
    } catch (err) { console.error(err); st = null; }
  }
  if (!st || (!st.apps?.length && !st.dailyMinutes)) {
    return showError('We couldn\'t read those screenshots', 'Make sure they show the Daily Average and the apps with times next to them.');
  }
  confirmNumbers(st, p.answers);
}

// "Check the numbers" — fix anything read wrong before the report.
function confirmNumbers(st, answers) {
  goStep(4);
  const d = st.dailyMinutes || 0;
  const row = (a = { name: '', minutes: '' }) => `<div class="st-row"><input class="st-name" value="${esc(a.name)}" placeholder="App" aria-label="App name" /><input class="st-min" type="number" min="0" max="1440" value="${esc(String(a.minutes))}" aria-label="Minutes a day" /><span class="muted">min/day</span><button class="btn btn-quiet btn-sm st-del" type="button" aria-label="Remove">✕</button></div>`;
  $('#stepRun').innerHTML = `<div class="st-check">
    <h3>Check the numbers</h3><p class="muted">Fix anything that looks wrong.</p>
    ${state.limitHit ? '<p class="fine">Daily AI limit reached — read on your device instead.</p>' : ''}
    <div class="st-daily"><span>Daily average</span><input id="stH" type="number" min="0" max="24" value="${Math.floor(d / 60)}" aria-label="Hours" /><span>h</span><input id="stM" type="number" min="0" max="59" value="${d % 60}" aria-label="Minutes" /><span>m</span></div>
    <div id="stRows">${st.apps.map(row).join('')}</div>
    <div class="row-between"><button id="stAdd" class="btn btn-quiet btn-sm" type="button">+ Add app</button><button id="stOk" class="btn btn-lantern" type="button">Looks right</button></div>
  </div>`;
  $('#stepRun').addEventListener('click', (e) => { if (e.target.closest('.st-del')) e.target.closest('.st-row').remove(); });
  $('#stAdd').addEventListener('click', () => { $('#stRows').insertAdjacentHTML('beforeend', row()); $('#stRows .st-row:last-child .st-name').focus(); });
  $('#stOk').addEventListener('click', () => {
    const apps = $$('#stRows .st-row').map((r) => ({ name: r.querySelector('.st-name').value.trim().slice(0, 40), minutes: Math.round(Number(r.querySelector('.st-min').value)) }))
      .filter((a) => a.name && a.minutes > 0).map((a) => ({ ...a, social: isSocial(a.name) })).sort((a, b) => b.minutes - a.minutes);
    const daily = (Number($('#stH').value) || 0) * 60 + (Number($('#stM').value) || 0);
    if (!apps.length && !daily) return toast('Add your daily average or at least one app');
    renderQuick({ dailyMinutes: daily || null, pickups: st.pickups, pickupsPeriod: st.pickupsPeriod, apps }, answers);
  });
}

const APP_KEYS = { YouTube: 'youtube', Instagram: 'instagram', TikTok: 'tiktok', Reddit: 'reddit' };
function renderQuick(st, answers) {
  goStep(4);
  const social = st.apps.filter((a) => a.social);
  const socialMin = social.reduce((s, a) => s + a.minutes, 0);
  const top = st.apps[0];
  const max = Math.max(...st.apps.map((a) => a.minutes), 1);
  const headline = st.dailyMinutes
    ? `You spend about ${fmtMin(st.dailyMinutes)} a day on your phone${socialMin ? `, and about ${fmtMin(socialMin)} of it on social and video apps` : ''}.`
    : top ? `${top.name} is where most of your phone time goes — about ${fmtMin(top.minutes)} a day.` : 'Here\'s how your phone time splits.';
  const feelings = { 'Tired': 'You said you usually feel tired afterwards.', 'Low or anxious': 'You said you often feel low or anxious afterwards — that\'s worth paying attention to.', 'Like I wasted time': 'You said it often feels like wasted time.', 'Good': 'You said you usually feel good afterwards — great.', 'Fine': 'You said you usually feel fine afterwards.' };
  const lines = [answers.when && (answers.when === 'Late at night' ? 'You scroll most late at night.' : `You scroll most in the ${answers.when.toLowerCase()}.`), feelings[answers.feel], answers.why && `You mostly open it for: ${answers.why.toLowerCase()}.`].filter(Boolean);
  const mainApp = social.find((a) => APP_KEYS[a.name]) || st.apps.find((a) => APP_KEYS[a.name]);
  const platform = mainApp ? APP_KEYS[mainApp.name] : 'youtube';
  const drift = { type: 'quickcheck', metric: 'screen time', percent: 0, driftScore: null, severity: 'none', weeks: 1, coverageDays: 7, confidence: 'medium', topClusters: [], habitChanges: lines };
  const hourShareRecent = answers.when === 'Late at night' ? Array.from({ length: 24 }, (_, h) => (h >= 23 || h < 2 ? 0.2 : 0.02)) : [];
  const stats = { platform: 'phone', screenTime: st, answers, hourShareRecent };
  const report = { headline, driving: lines.join(' '), changed: '', tryThis: '' };
  saveLatestContext({ platform, sample: false, drift, report, stats });
  ctx.analysis = null;
  $('#stepRun').innerHTML = `
    <div class="report">
      <div class="r-tags"><span class="tag type">Quick check</span><span class="tag">From your Screen Time</span></div>
      <h3 class="r-headline">${esc(headline)}</h3>
      ${lines.length ? `<p class="section-lede" style="font-size:17px">${esc(lines.join(' '))}</p>` : ''}
      <div class="grid">
        ${st.apps.length ? `<div class="tile wide"><h4>Time per app, per day</h4>
          ${st.apps.map((a) => `<div class="bar-row"><span>${esc(a.name)}</span><span class="bar"><span style="width:${(a.minutes / max) * 100}%;background:${a.social ? 'var(--lantern)' : 'var(--kelp)'}"></span></span><span class="n">${fmtMin(a.minutes)}</span></div>`).join('')}
          <div class="legend"><span><i style="background:var(--lantern)"></i>Social and video apps</span><span><i style="background:var(--kelp)"></i>Other apps</span></div>
          ${st.pickups ? `<p class="fine">You pick up your phone about ${st.pickups} times ${st.pickupsPeriod === 'week' ? 'a week' : 'a day'}.</p>` : ''}</div>` : ''}
        ${planTile()}
        ${quickAskPanel()}
      </div>
      
      <div class="actions"><button class="btn btn-quiet" id="againBtn" type="button">Start again</button></div>
    </div>`;
  wirePlan({ drift, stats, platform, hasTitles: false, key: 'quick.' + new Date().toISOString().slice(0, 10) });
  const root = $('#quickAsk .ask-box');
  const view = new ChatView({ root, persist: false, getContext: () => ({ drift, report, stats }) });
  view.start(null, null);
  const box = root.querySelector('[data-suggest]');
  const qs = ['Is my screen time a lot?', 'Which app should I cut down first?', 'Make me a plan for my evenings', 'How do I set an app limit on my phone?'];
  box.innerHTML = qs.map((q) => `<button type="button">${esc(q)}</button>`).join('');
  box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => view.send(b.textContent)));
  $('#againBtn').addEventListener('click', () => goStep(2));
  $('#start').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
}
function quickAskPanel() {
  return `<div class="ask" id="quickAsk">
    <div class="ask-head"><h4>Ask Drift about your screen time</h4><a class="text-link" href="ask.html">Open full page</a></div>
    
    <div class="ask-box">${chatBoxHTML({ placeholder: 'e.g. how do I cut down at night?' })}</div>
  </div>`;
}

async function readFile(file) {
  try {
    ingest(await readHistoryFile(file));
  } catch (err) {
    showError('We couldn\'t read that file', err.message || 'Try the JSON file instead of the zip, or use another method.');
  }
}

function loadSample() {
  fetch('sample-data.json').then((r) => r.json())
    .then((j) => ingest({ ...normalizeHistoryFile(j), hasTitles: true, platform: 'youtube', sample: true }))
    .catch(() => showError('The sample didn\'t load', 'Check your connection and try again.'));
}

// Paste-in fallback: titles + any date headers from the copied page text.
const DUR_RE = /^\d{1,2}:\d{2}(?::\d{2})?$/;
const NOISE_RE = /^(\d+(\.\d+)?[km]?\s*views?|watched|more actions?|shorts?|now playing|recommended|mix|live|new|cc|hd|\d+\s*(minutes?|hours?|days?|weeks?|months?|years?)\s*ago|•+|\d+)$/i;
const DATE_HDR = /^(today|yesterday|(sun|mon|tue|wed|thu|fri|sat)[a-z]*(,?\s.*\d)?|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(,\s*\d{4})?)$/i;
function parsePastedHistory(text, source) {
  const items = [];
  let curDate = null, pendingDur = 0;
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    if (DATE_HDR.test(line)) { curDate = parseFlexibleDate(line); continue; }
    if (DUR_RE.test(line)) { const p = line.split(':').map(Number).reverse(); pendingDur = (p[0] || 0) + (p[1] || 0) * 60 + (p[2] || 0) * 3600; continue; }
    if (NOISE_RE.test(line) || line.length < 12 || !/[a-z]/i.test(line)) continue;
    if (!/\s/.test(line) && line.length < 25) continue;
    items.push({ title: line, channel: '', durationSec: pendingDur, watchedAt: curDate });
    pendingDur = 0;
  }
  return { source, platform: source, items, hasTitles: true, pasted: true };
}

// ---------------------------------------------------------------------------
// Clean locally, then show exactly what will be sent.
// ---------------------------------------------------------------------------
function ingest(file) {
  const items = file.hasTitles ? cleanItems(file.items) : (file.items || []);
  if (items.length < 15) {
    return showError(
      items.length ? `Only ${items.length} item${items.length === 1 ? '' : 's'} found` : 'No history found in that',
      'Drift needs at least 15 to say anything honest. Google Takeout (for YouTube) or a longer date range (for Instagram/TikTok) gives you much more.');
  }
  const capped = items.slice(0, 1000);
  const cleaned = file.hasTitles ? capped.map((it, i) => ({ id: 'v' + i, title: scrubTitle(it.title) })) : [];
  state.pending = { file, items: capped, cleaned, total: items.length };

  $('#sendLede').textContent = file.hasTitles
    ? 'Your file, creator names, @handles and every timestamp stay in this browser. Only these cleaned titles go to the AI to be tagged, then deleted.'
    : `Nothing from your ${file.platform === 'tiktok' ? 'TikTok' : 'Instagram'} file is sent anywhere. It's analysed entirely on this device.`;
  $('#sendStats').innerHTML = `
    <div><b>${cleaned.length}</b><span>titles sent</span></div>
    <div><b>0</b><span>names or @handles sent</span></div>
    <div><b>0</b><span>timestamps sent</span></div>`;
  $('#sendPreview').textContent = cleaned.length
    ? cleaned.slice(0, 10).map((c) => c.title).join('\n') + (cleaned.length > 10 ? `\n…and ${cleaned.length - 10} more` : '') +
      (items.length > capped.length ? `\n\n(Your file holds ${items.length} — Drift reads the newest ${capped.length}.)` : '')
    : `${capped.length} items, analysed on this device only.`;
  $('#sendPreview').classList.remove('hidden');
  $('#sendThumbs').classList.add('hidden');
  $('#sendModal').classList.remove('hidden');
  $('#sendConfirm').focus();
}

function scrubTitle(title) {
  return String(title)
    .replace(/@[\w.\-]+/g, '@creator')
    .replace(/\bu\/[\w\-]+/gi, 'u/user')
    .replace(/\s{2,}/g, ' ')
    .trim().slice(0, 300);
}

$('#sendCancel').addEventListener('click', () => { $('#sendModal').classList.add('hidden'); state.pending = null; });
$('#sendConfirm').addEventListener('click', () => { $('#sendModal').classList.add('hidden'); const p = state.pending; if (!p) return; if (p.screentime) { state.pending = null; return readScreenTimeShots(p); } analyze(p); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sendModal').classList.contains('hidden')) $('#sendCancel').click(); });

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------
const RUN_STEPS = ['Reading your file on this device', 'Tagging topics and intensity', 'Applying the published rules', 'Writing your report and checking its tone'];

function showRunning(skipLabel) {
  goStep(4);
  const steps = skipLabel ? RUN_STEPS.filter((_, i) => i !== 1) : RUN_STEPS;
  $('#stepRun').innerHTML = `<div class="running"><h3>Reading your drift…</h3><ol class="run-steps">${steps.map((s) => `<li>${s}</li>`).join('')}</ol></div>`;
  $('#start').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
  let i = -1;
  return () => { const li = $$('.run-steps li'); if (li[i]) li[i].className = 'ok'; i++; if (li[i]) li[i].className = 'now'; };
}

async function analyze({ file, items, cleaned }) {
  const next = showRunning(!file.hasTitles);
  try {
    next();
    let labeled;
    let usedBackup = false;
    state.limitHit = false;
    if (file.vision) {
      next();
      const li = $('.run-steps li.now'); if (li) li.textContent = 'Looking at your screenshots';
      if (!server.up && !(await waitForServer(60000))) { const e = new Error('asleep'); e.status = 503; throw e; }
      let videos;
      try { videos = (await postJSON('/api/vision', { platform: file.platform, images: file.images.map(({ media_type, data }) => ({ media_type, data })) })).videos; }
      catch (e) { if (e.body?.error === 'daily_limit') { e.status = 'limit'; } throw e; }
      file.images = null; // don't keep them around
      if (!videos || videos.length < 15) {
        return showError(`We found ${videos?.length || 0} videos`, 'Drift needs at least 15. Add a few more screenshots (5–10 is usually enough).');
      }
      labeled = videos.map((v) => ({ title: `${platformName(file.platform)} video`, channel: '', topic: v.topic, intensity: v.intensity, durationSec: 0, watchedAt: null }));
    } else if (file.hasTitles) {
      next();
      // Give a sleeping AI server up to ~40s to wake; otherwise use the
      // in-browser backup engine so you're never stuck waiting.
      let labels = null;
      if (!server.up) { const li = $('.run-steps li.now'); if (li) li.textContent = 'Waking the AI (first visit only) — a backup engine takes over if it\'s slow'; }
      if (server.up || await waitForServer(25000)) {
        // Out of today's AI uses (or the AI is busy)? The on-device engine takes over.
        try { labels = (await postJSON('/api/label', { items: cleaned })).labels; } catch (e) { if (e.body?.error === 'daily_limit') state.limitHit = true; }
      }
      if (!labels) { usedBackup = true; labels = cleaned.map(keywordLabel); }
      const byId = new Map((labels || []).map((l) => [l.id, l]));
      labeled = items.map((it, i) => {
        const l = byId.get('v' + i) || {};
        return { title: it.title, channel: it.channel || '', topic: l.topic || 'other', intensity: typeof l.intensity === 'number' ? l.intensity : 0.35, durationSec: Number(it.durationSec) || 0, watchedAt: it.watchedAt };
      });
    } else {
      labeled = items.map((it) => ({ ...it, topic: 'other', intensity: null }));
    }

    next();
    const prepared = ensureUsableTimeline(labeled.map((x) => ({ ...x, intensity: x.intensity ?? 0.35 })));
    let drift = computeDrift(prepared.items);
    if (prepared.estimated && drift.type !== 'insufficient') { drift.estimatedDates = true; if (drift.confidence === 'high') drift.confidence = 'medium'; }
    const weeks = weeklyTimeline(prepared.items);
    const extras = {
      creators: creatorConcentration(prepared.items),
      hours: hourProfile(prepared.items),
      shift: file.hasTitles ? topicShift(prepared.items) : [],
      turn: file.hasTitles ? turningPoint(weeks) : null,
      igTopics: file.igTopics || [],
    };
    if (!file.hasTitles) drift = rhythmDrift(drift, weeks, extras.creators, file.platform);

    next();
    let report;
    if (file.hasTitles && !usedBackup && server.up) {
      try { report = (await postJSON('/api/report', { drift })).report; } catch { report = null; }
    }
    if (!file.hasTitles || !report) report = localReport(drift, file, extras, report);
    next();

    state.analysis = { drift, report, items: prepared.items, weeks, file, extras };
    ctx.analysis = state.analysis;
    saveLatestReport(state.analysis);
    renderReport();
  } catch (err) {
    console.error(err);
    if (err.status === 'limit') return showError('Today\'s AI uses are used up', 'Screenshots from Instagram and TikTok need the AI. Your uses reset at midnight — or try the Screen Time check, which works on your device.');
    showError(err.status === 429 ? 'Too many analyses at once' : 'Something went wrong while analysing',
      err.status === 429 ? 'Drift limits how often each person can run it, to keep it free. Wait a minute and try again.' : 'Please try again in a moment.');
  }
}

// Instagram / TikTok: no titles, so no topics. We measure the rhythm instead,
// with the same saturating score curve as the published rules.
function rhythmDrift(drift, weeks, creators, platform) {
  if (drift.type === 'insufficient') return { ...drift, platform };
  const live = weeks.filter((w) => w.count);
  const half = Math.floor(live.length / 2);
  const early = live.slice(0, half), late = live.slice(half);
  const per = (ws) => ws.reduce((s, w) => s + w.sessions, 0) / (ws.length || 1);
  const vol = (ws) => ws.reduce((s, w) => s + w.count, 0) / (ws.length || 1);
  const sess = per(early) ? (per(late) - per(early)) / per(early) : 0;
  const volume = vol(early) ? (vol(late) - vol(early)) / vol(early) : 0;
  const conc = creators ? creators.lateTop3 - creators.earlyTop3 : 0;
  const mag = Math.max(0, sess / 0.25, volume / 0.25, conc / 0.10);
  const score = Math.round(100 * mag / (mag + 1));
  const habits = [];
  if (Math.abs(sess) > 0.15) habits.push(`You opened ${pct(Math.abs(sess))}% ${sess > 0 ? 'more' : 'fewer'} separate sessions per week.`);
  if (Math.abs(volume) > 0.15) habits.push(`You saw ${pct(Math.abs(volume))}% ${volume > 0 ? 'more' : 'less'} per week than in your earlier weeks.`);
  if (creators && Math.abs(conc) > 0.05) habits.push(`Your top 3 creators went from ${pct(creators.earlyTop3)}% to ${pct(creators.lateTop3)}% of what you saw.`);
  return {
    ...drift, platform, type: 'rhythm', metric: 'rhythm', percent: pct(Math.max(sess, volume, 0)),
    driftScore: score, severity: score >= 67 ? 'strong' : score >= 34 ? 'moderate' : score > 0 ? 'subtle' : 'flat',
    topClusters: [], habitChanges: habits.length ? habits : drift.habitChanges,
  };
}

function localReport(drift, file, extras, aiReport) {
  if (aiReport && file.hasTitles) return aiReport;
  if (file.hasTitles) return browserReport(drift);
  const name = file.platform === 'tiktok' ? 'TikTok' : 'Instagram';
  if (drift.type === 'insufficient') {
    return { headline: 'Not enough history yet to say anything honest.', driving: `This file covers about ${drift.coverageDays} days. Drift needs at least 10.`, changed: 'Request a longer date range from your app and try again.', tryThis: 'Or try the sample to see what a full report looks like.', toneChecked: true, source: 'insufficient' };
  }
  const band = { strong: 'a strong', moderate: 'a moderate', subtle: 'a subtle', flat: 'barely any' }[drift.severity] || 'a';
  return {
    headline: `Your ${name} rhythm shows ${band} shift over ${drift.weeks} weeks since ${drift.startDate}.`,
    driving: extras.creators
      ? `Lately, ${pct(extras.creators.lateTop3)}% of what you saw came from just 3 creators.`
      : `${name}'s download records when you watched, so this report is about rhythm rather than topics.`,
    changed: (drift.habitChanges?.length ? drift.habitChanges.join(' ') + ' ' : 'Your rhythm looks broadly like your earlier weeks. ') + 'Is this how you want your week to look?',
    tryThis: 'Try opening the app only on purpose for one day — with something specific in mind — and notice the difference.',
    toneChecked: true, source: 'local',
  };
}

// Written on your device when the AI server isn't reachable. Same calm rules.
function browserReport(drift) {
  if (drift.type === 'insufficient') {
    return { headline: 'Not enough history yet to say anything honest.', driving: `This file covers ${drift.itemCount || 0} items over about ${drift.coverageDays || 0} days. Drift needs at least 15 items across 10 days.`, changed: 'Google Takeout gives you your complete history with no scrolling.', tryThis: 'Or try the sample to see what a full report looks like.', toneChecked: true, source: 'browser' };
  }
  const clusters = (drift.topClusters || []).filter((t) => t !== 'other').map((t) => topicName(t).toLowerCase());
  const since = drift.startDate ? ` since ${drift.startDate}` : '';
  const head = {
    escalation: `What you watch became about ${drift.percent}% more emotionally charged over ${drift.weeks} weeks${since}.`,
    narrowing: `Your topics narrowed by about ${drift.percent}% over ${drift.weeks} weeks${since}.`,
    engagement: `Your videos got about ${drift.percent}% shorter while you watched more often, over ${drift.weeks} weeks${since}.`,
    mixed: `Your watching shifted over ${drift.weeks} weeks${since}, but no single pattern stands out.`,
  }[drift.type] || `Your watching shifted over ${drift.weeks} weeks${since}.`;
  const tries = {
    escalation: 'Try one day without news or drama content and see if your focus feels different.',
    narrowing: 'Try one video from a topic you used to enjoy but drifted away from.',
    engagement: 'Try picking one longer video and watching it start to finish.',
    mixed: 'Pick one thing to watch on purpose this week, and notice how it compares with the autoplay picks.',
  };
  return {
    headline: head,
    driving: clusters.length ? `Most of the change sits in ${clusters.join(', ')}.` : 'The change is spread across several topics.',
    changed: (drift.habitChanges?.length ? drift.habitChanges.join(' ') + ' ' : '') + 'Is this how you want your week to look?',
    tryThis: tries[drift.type] || tries.mixed,
    toneChecked: true, source: 'browser',
  };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------
const TYPE_LABEL = { escalation: 'Escalation', narrowing: 'Narrowing', engagement: 'Engagement drift', mixed: 'Mixed signal', insufficient: 'Not enough data', rhythm: 'Rhythm shift' };
const PALETTE = ['#f4b740', '#63cfae', '#7fb4e6', '#f0846c', '#c39bef', '#e6d38a'];

function renderReport() {
  const { drift, report, weeks, file, extras } = state.analysis;
  const real = drift.type !== 'insufficient';
  const prev = loadRuns().filter((r) => r.platform === (file.platform || 'youtube')).at(-1);
  const sourceTag = { ai: 'Written by AI, tone-checked', fallback: 'Plain pre-written report', mock: 'Demo report', local: 'Written on your device', browser: state.limitHit ? 'Made by the on-device engine, because today\'s AI uses are used up (they reset at midnight)' : 'Written on your device by the backup engine (the AI server was asleep)', insufficient: '' }[report.source] || '';

  const tiles = [];
  if (real) tiles.push(planTile());
  if (real && weeks.length > 1) tiles.push(`<div class="tile wide"><h4>Week by week</h4>${timelineSvg(weeks, file.hasTitles, extras.turn)}</div>`);
  if (real && extras.shift.length) tiles.push(`<div class="tile"><h4>What moved</h4><p class="sub"><span style="color:var(--mist)">Earlier</span> vs <span style="color:var(--lantern)">recent</span></p>${shiftRows(extras.shift)}</div>`);
  if (real) tiles.push(`<div class="tile ${extras.shift.length ? '' : 'wide'}"><h4>Your habits</h4>${habitsHtml(report)}</div>`);
  if (real && extras.hours) tiles.push(`<div class="tile wide"><h4>When you watch</h4>${clockSvg(extras.hours)}</div>`);
  if (extras.igTopics.length) tiles.push(`<div class="tile wide"><h4>What Instagram thinks you like</h4><div class="chips">${extras.igTopics.slice(0, 24).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div></div>`);
  const small = [];
  if (real && extras.creators) small.push(`<h4>Your top 3 creators</h4><div class="big-stat">${pct(extras.creators.lateTop3)}%<small>recently, from ${pct(extras.creators.earlyTop3)}% earlier</small></div><div class="chips">${extras.creators.lateTop.slice(0, 5).map((c) => `<span class="chip">${esc(c.name)}</span>`).join('')}</div>`);
  if (prev && real) small.push(`<h4>Since your last saved run</h4><p class="sub">${esc(new Date(prev.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))}: ${esc(TYPE_LABEL[prev.type] || prev.type)}</p><div class="big-stat">${drift.driftScore ?? '–'}<small>now, from ${prev.score ?? '–'}</small></div>`);
  const cols = small.length === 1 ? 'wide' : '';
  small.forEach((h) => tiles.push(`<div class="tile ${cols}">${h}</div>`));
  if (!real) tiles.push(`<div class="tile wide try"><h4>What to do next</h4><p class="body">${esc(report.tryThis)}</p></div>`);
  if (real) tiles.push(shareTile());
  if (real) tiles.push(askPanel());

  $('#stepRun').innerHTML = `
    <div class="report">
      <div class="r-top">
        <div>
          <div class="r-tags">
            <span class="tag type">${esc(TYPE_LABEL[drift.type] || 'Result')}</span>
            ${real ? `<span class="tag">${esc(drift.confidence)} confidence</span>` : ''}
            <span class="tag">${drift.coverageDays || 0} days${drift.startDate && drift.endDate ? `, ${esc(drift.startDate)} to ${esc(drift.endDate)}` : ''}</span>
            <span class="tag">${esc(platformName(file.platform))}${file.sample ? ' sample' : ''}</span>
            ${drift.estimatedDates ? '<span class="tag">dates estimated</span>' : ''}
            ${state.limitHit ? '<span class="tag">today\'s AI uses are used up — made on your device</span>' : ''}
          </div>
          <h3 class="r-headline">${esc(report.headline)}</h3>
          ${report.driving ? `<p class="section-lede" style="font-size:17px">${esc(report.driving)}</p>` : ''}
        </div>
        ${real && typeof drift.driftScore === 'number' ? dialHtml(drift.driftScore) : ''}
      </div>
      <div class="grid">${tiles.join('')}</div>
      <div class="actions">
        ${real ? '<button class="btn btn-lantern" id="shareBtn" type="button">Download share card</button>' : ''}
        ${real ? '<button class="btn btn-quiet" id="saveBtn" type="button">Save to this device</button>' : ''}
        <button class="btn btn-quiet" id="againBtn" type="button">Analyse another file</button>
      </div>
      <details class="more-info fine"><summary>About this report</summary><p>${esc(sourceTag)}. Drift shows patterns, not proof, and compares you only with your own earlier weeks. Rules v${RULES_VERSION}.</p></details>
    </div>`;

  requestAnimationFrame(() => { const v = $('.dial .val'); if (v) v.style.strokeDashoffset = v.dataset.to; });
  $('#againBtn').addEventListener('click', () => { state.analysis = null; ctx.analysis = null; goStep(2); renderPastRuns(); });
  $('#shareBtn')?.addEventListener('click', shareCard);
  $('#saveBtn')?.addEventListener('click', saveRun);
  if (real) wireAsk();
  if (real) wirePlan(planFromAnalysis(state.analysis));
  if (real) wireShare();
}

// ---------------------------------------------------------------------------
// The optional anonymous summary. Only offered if they said yes at the start
// (and never for example reports). They answer one question, then it's sent.
// ---------------------------------------------------------------------------
const SHARED_KEY = 'drift.shared.v1';
function sharedList() { try { return JSON.parse(localStorage.getItem(SHARED_KEY) || '[]'); } catch { return []; } }

function shareTile() {
  const { file } = state.analysis;
  const c = state.consent;
  if (file.sample || !c?.share) {
    return '';
  }
  return `<div class="tile wide share-tile" id="shareTile">
    <h4>Did this feel accurate?</h4>
    <div class="mcq-row" role="group" aria-label="Did this feel accurate?">
      <button class="opt-btn" data-acc="yes" type="button">Yes</button>
      <button class="opt-btn" data-acc="partly" type="button">Partly</button>
      <button class="opt-btn" data-acc="no" type="button">No</button>
      <button class="opt-btn" data-acc="unsure" type="button">Not sure</button>
    </div>
    <p class="sub" style="margin:12px 0 0"><button class="linkish" id="skipShare" type="button">Don't share this one</button></p>
  </div>`;
}

function contributionPayload(accuracy) {
  const { drift, items, weeks, file, extras } = state.analysis;
  const night = items.filter((x) => new Date(x.watchedAt).getHours() < 5).length;
  return {
    platform: file.platform || 'youtube',
    type: drift.type, score: drift.driftScore, severity: drift.severity, percent: drift.percent,
    confidence: drift.confidence, coverageDays: drift.coverageDays, itemCount: drift.itemCount ?? items.length,
    estimatedDates: !!drift.estimatedDates,
    ageGroup: state.consent.ageGroup, accuracy,
    lateNightShare: items.length ? night / items.length : null,
    top3CreatorShare: extras.creators ? { earlier: extras.creators.earlyTop3, recent: extras.creators.lateTop3 } : null,
    topicShift: (extras.shift || []).map((t) => ({ topic: topicName(t.topic), earlyShare: t.early, recentShare: t.late })),
    weekly: weeks.map((w) => ({ items: w.count, sessions: w.sessions, intensity: file.hasTitles ? w.intensity : null })),
    rules: RULES_VERSION,
  };
}

function wireShare() {
  const tile = $('#shareTile');
  if (!tile) return;
  $$('[data-acc]', tile).forEach((b) => b.addEventListener('click', async () => {
    $$('[data-acc]', tile).forEach((x) => (x.disabled = true));
    b.classList.add('picked');
    try {
      if (!server.up && !(await waitForServer(60000))) throw new Error('asleep');
      const r = await postJSON('/api/contribute', contributionPayload(b.dataset.acc));
      const list = sharedList(); list.push({ id: r.id, token: r.deleteToken, at: Date.now() });
      try { localStorage.setItem(SHARED_KEY, JSON.stringify(list.slice(-50))); } catch { /* ignore */ }
      tile.innerHTML = `<h4>Thanks — shared anonymously</h4><p class="sub" style="margin:0"><a class="text-link" href="results.html">See shared totals</a></p>
        <p style="margin-top:14px"><button class="btn btn-quiet btn-sm" id="unshare" type="button">Remove my summary</button></p>`;
      $('#unshare').addEventListener('click', async () => {
        try {
          const res = await fetch(API + '/api/contribute/' + encodeURIComponent(r.id), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: r.deleteToken }) });
          if (!res.ok && res.status !== 404) throw new Error();
          try { localStorage.setItem(SHARED_KEY, JSON.stringify(sharedList().filter((x) => x.id !== r.id))); } catch { /* ignore */ }
          tile.innerHTML = '<h4>Removed</h4><p class="sub" style="margin:0">Your summary has been deleted.</p>';
        } catch { toast('Couldn\'t remove it just now. Please try again.'); }
      });
    } catch {
      $$('[data-acc]', tile).forEach((x) => (x.disabled = false));
      b.classList.remove('picked');
      toast('Couldn\'t share just now. Please try again in a minute.');
    }
  }));
  $('#skipShare')?.addEventListener('click', () => { tile.innerHTML = '<h4>Not shared</h4><p class="sub" style="margin:0">Nothing about this report is kept.</p>'; });
}

function platformName(p) { return { youtube: 'YouTube', reddit: 'Reddit', instagram: 'Instagram', tiktok: 'TikTok' }[p] || 'YouTube'; }

function dialHtml(score) {
  const C = 2 * Math.PI * 70;
  return `<div class="dial" role="img" aria-label="Drift score ${score} out of 100">
    <svg viewBox="0 0 160 160"><circle class="track" cx="80" cy="80" r="70" fill="none" stroke-width="9"/>
    <circle class="val" cx="80" cy="80" r="70" fill="none" stroke-width="9" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${reduceMotion ? C * (1 - score / 100) : C}" data-to="${C * (1 - score / 100)}"/></svg>
    <div class="dial-num"><b>${score}</b><span>drift score</span></div></div>`;
}

function habitsHtml(report) {
  const text = report.changed || '';
  const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const q = parts.length && parts[parts.length - 1].endsWith('?') ? parts.pop() : '';
  return `<ul class="habit-list">${parts.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>${q ? `<p class="reflect">${esc(q)}</p>` : ''}`;
}

function timelineSvg(weeks, byTopic, turn) {
  const W = 720, H = 230, pad = { l: 8, r: 8, t: 14, b: 28 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const max = Math.max(...weeks.map((w) => w.count), 1);
  const bw = iw / weeks.length;
  const topicsAll = {};
  weeks.forEach((w) => Object.entries(w.topics).forEach(([k, n]) => (topicsAll[k] = (topicsAll[k] || 0) + n)));
  const top = Object.entries(topicsAll).filter(([k]) => k !== 'other').sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
  const color = (k) => (byTopic ? (top.includes(k) ? PALETTE[top.indexOf(k)] : '#2f5560') : '#2f6a73');
  let bars = '';
  weeks.forEach((w, i) => {
    let y = pad.t + ih;
    const x = pad.l + i * bw + bw * 0.15;
    const entries = byTopic ? [...top.map((k) => [k, w.topics[k] || 0]), ['_rest', Object.entries(w.topics).filter(([k]) => !top.includes(k)).reduce((s, [, n]) => s + n, 0)]] : [['_all', w.count]];
    for (const [k, n] of entries) {
      if (!n) continue;
      const hh = (n / max) * ih;
      y -= hh;
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${Math.max(0, hh - 1).toFixed(1)}" rx="2" fill="${color(k)}" opacity=".9"><title>${esc(w.label)}: ${n} ${k.startsWith('_') ? 'watches' : esc(topicName(k).toLowerCase())}</title></rect>`;
    }
  });
  const lineVals = weeks.map((w) => (byTopic ? w.intensity : w.sessions));
  const lmax = byTopic ? 1 : Math.max(...lineVals.map((v) => v || 0), 1);
  const pts = lineVals.map((v, i) => (v == null || (!byTopic && !weeks[i].count) ? null : [pad.l + i * bw + bw / 2, pad.t + ih - (v / lmax) * ih])).filter(Boolean);
  const line = pts.length > 1 ? `<polyline points="${pts.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="#f0846c" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>${pts.map((p) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.2" fill="#f0846c"/>`).join('')}` : '';
  const marker = turn ? `<line x1="${pad.l + turn.index * bw}" x2="${pad.l + turn.index * bw}" y1="${pad.t - 6}" y2="${pad.t + ih}" stroke="#f4b740" stroke-dasharray="4 4" stroke-width="1.5"/><text x="${pad.l + turn.index * bw + 6}" y="${pad.t + 4}" style="fill:#f4b740">shift starts</text>` : '';
  const step = Math.ceil(weeks.length / 8);
  const labels = weeks.map((w, i) => (i % step ? '' : `<text x="${pad.l + i * bw + bw / 2}" y="${H - 8}" text-anchor="middle">${esc(w.label)}</text>`)).join('');
  const legend = byTopic
    ? `<div class="legend">${top.map((k, i) => `<span><i style="background:${PALETTE[i]}"></i>${esc(topicName(k))}</span>`).join('')}<span><i style="background:#2f5560"></i>Other</span><span><i style="background:#f0846c;height:3px;border-radius:2px"></i>Intensity</span></div>`
    : `<div class="legend"><span><i style="background:#2f6a73"></i>Items seen</span><span><i style="background:#f0846c;height:3px;border-radius:2px"></i>Sessions</span></div>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly chart">${bars}${line}${marker}${labels}</svg>${legend}`;
}

function shiftRows(shift) {
  shift = [...shift.filter((x) => x.topic !== 'other'), ...shift.filter((x) => x.topic === 'other')].slice(0, 6);
  const max = Math.max(...shift.flatMap((s) => [s.early, s.late]), 0.01);
  return shift.map((s) => {
    const d = Math.round((s.late - s.early) * 100);
    return `<div class="shift-row"><span>${esc(topicName(s.topic))}</span><span class="shift-bars"><span class="e" style="width:${(s.early / max) * 100}%"></span><span class="l" style="width:${(s.late / max) * 100}%"></span></span><span class="d ${d > 0 ? 'up' : ''}">${d > 0 ? '+' : ''}${d}</span></div>`;
  }).join('');
}

function clockSvg(h) {
  const W = 720, H = 150, ih = 110, bw = W / 24;
  const max = Math.max(...h.early, ...h.late, 0.01);
  let s = '';
  for (let i = 0; i < 24; i++) {
    const eh = (h.early[i] / max) * ih, lh = (h.late[i] / max) * ih;
    s += `<rect x="${i * bw + bw * 0.12}" y="${ih - eh}" width="${bw * 0.36}" height="${eh}" rx="2" fill="#2f5560"/>`;
    s += `<rect x="${i * bw + bw * 0.52}" y="${ih - lh}" width="${bw * 0.36}" height="${lh}" rx="2" fill="${i < 5 ? '#f0846c' : '#f4b740'}"><title>${i}:00 — ${pct(h.late[i])}% recently, ${pct(h.early[i])}% earlier</title></rect>`;
    if (i % 3 === 0) s += `<text x="${i * bw + bw / 2}" y="${H - 14}" text-anchor="middle">${i === 0 ? '12am' : i === 12 ? '12pm' : i < 12 ? i + 'am' : i - 12 + 'pm'}</text>`;
  }
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="When you watch, by hour">${s}</svg><div class="legend"><span><i style="background:#2f5560"></i>Earlier</span><span><i style="background:#f4b740"></i>Recent</span><span><i style="background:#f0846c"></i>Recent, midnight to 5am</span></div>`;
}

// ---------------------------------------------------------------------------
// Ask your data — the central assistant in the report. Questions it can
// answer from your own data are answered right here, on your device; the
// rest go to the AI with only the short summary.
// ---------------------------------------------------------------------------
const LOCAL_SUGGEST = ['What did I watch late at night?', 'When did it start changing?', 'Who do I watch most?', 'What was my busiest week?', 'What was most intense?'];
const AI_SUGGEST = ['What does my result mean?', 'What should I change first?', 'How do I reset my feed?', 'Is this reliable?'];

function askPanel() {
  return `<div class="ask" id="reportAsk">
    <div class="ask-head"><h4>Ask Drift about your report</h4><a class="text-link" href="ask.html">Open full page</a></div>
    
    <div class="ask-box">${chatBoxHTML({ placeholder: 'e.g. what should I change first?' })}</div>
  </div>`;
}

let reportView = null;
function wireAsk() {
  const root = $('#reportAsk .ask-box');
  reportView = new ChatView({ root, persist: false, getAnalysis: () => state.analysis });
  reportView.start(null, null);
  const qs = state.analysis.file.hasTitles ? [...LOCAL_SUGGEST, ...AI_SUGGEST] : ['Who do I watch most?', 'What was my busiest week?', 'What did I watch late at night?', ...AI_SUGGEST];
  const box = root.querySelector('[data-suggest]');
  box.innerHTML = qs.map((q) => `<button type="button">${esc(q)}</button>`).join('');
  box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => reportView.send(b.textContent, { fromChip: LOCAL_SUGGEST.includes(b.textContent) })));
}

// ---------------------------------------------------------------------------
// Share card — an image of your result to post or send. Made on this device.
// ---------------------------------------------------------------------------
async function shareCard() {
  const { drift, report, file } = state.analysis;
  await document.fonts?.ready;
  const W = 1080, H = 1350;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#061418'; g.fillRect(0, 0, W, H);
  // currents
  const cols = ['#63cfae', '#7fb4e6', '#c39bef', '#f0846c', '#e6d38a'];
  for (let i = 0; i < 40; i++) {
    g.beginPath();
    const y0 = 60 + (i / 40) * 520;
    for (let x = 0; x <= W; x += 10) {
      const p = x / W, pull = p * p * (3 - 2 * p);
      const y = y0 * (1 - pull) + (300 + (i - 20) * 2) * pull + Math.sin(x * 0.01 + i) * 10 * (1 - pull);
      x ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.strokeStyle = i % 9 === 4 ? '#f4b740' : cols[i % cols.length];
    g.globalAlpha = 0.35; g.lineWidth = 2; g.stroke();
  }
  g.globalAlpha = 1;
  const font = (wt, px) => `${wt} ${px}px "Bricolage Grotesque", system-ui, sans-serif`;
  g.fillStyle = '#f4b740'; g.font = font(700, 40); g.fillText('drift', 80, 120);
  g.fillStyle = '#93aeab'; g.font = font(500, 34); g.fillText(`My ${platformName(file.platform)} drift`, 80, 720);
  g.fillStyle = '#e9f2ef'; g.font = font(700, 220); g.fillText(String(drift.driftScore ?? '–'), 72, 930);
  g.fillStyle = '#93aeab'; g.font = font(500, 34); g.fillText('/ 100 drift score', 80, 990);
  g.fillStyle = '#f4b740'; g.font = font(700, 54); g.fillText(TYPE_LABEL[drift.type] || '', 80, 1080);
  g.fillStyle = '#c4d6d2'; g.font = font(400, 34);
  wrap(g, report.headline, 80, 1150, W - 160, 46, 3);
  g.fillStyle = '#93aeab'; g.font = font(500, 28); g.fillText(`See yours at ${location.host}`, 80, H - 110);
  g.fillText('Your history never leaves your browser', 80, H - 66);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const f = new File([blob], 'my-drift.png', { type: 'image/png' });
  if (navigator.canShare?.({ files: [f] })) { try { await navigator.share({ files: [f], title: 'My drift' }); return; } catch { /* fall through to download */ } }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'my-drift.png'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Share card downloaded');
}
function wrap(g, text, x, y, maxW, lh, maxLines) {
  const words = String(text).split(' ');
  let line = '', n = 0;
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (g.measureText(t).width > maxW && line) { g.fillText(line, x, y); y += lh; line = w; if (++n >= maxLines - 1) { line = words.slice(words.indexOf(w)).join(' '); break; } }
    else line = t;
  }
  if (g.measureText(line).width > maxW) { while (g.measureText(line + '…').width > maxW) line = line.slice(0, -1); line += '…'; }
  g.fillText(line, x, y);
}

// ---------------------------------------------------------------------------
// Saved runs — a small summary only (no titles), kept in this browser.
// ---------------------------------------------------------------------------
const RUNS_KEY = 'drift.runs.v1';
function loadRuns() { try { return JSON.parse(localStorage.getItem(RUNS_KEY) || '[]'); } catch { return []; } }
function saveRun() {
  const { drift, file } = state.analysis;
  const runs = loadRuns();
  runs.push({ at: Date.now(), platform: file.platform || 'youtube', type: drift.type, score: drift.driftScore, severity: drift.severity, sample: !!file.sample });
  try { localStorage.setItem(RUNS_KEY, JSON.stringify(runs.slice(-30))); toast('Saved on this device. Run it again in a few weeks to compare.'); $('#saveBtn').disabled = true; $('#saveBtn').textContent = 'Saved'; }
  catch { toast('Your browser blocked saving here.'); }
}
function renderPastRuns() {
  const runs = loadRuns().filter((r) => typeof r.score === 'number');
  const el = $('#pastRuns');
  if (!runs.length) { el.classList.add('hidden'); return; }
  const last = runs.at(-1);
  const pts = runs.slice(-10).map((r, i, a) => `${(i / Math.max(1, a.length - 1)) * 116 + 2},${32 - (r.score / 100) * 28}`).join(' ');
  el.innerHTML = `${runs.length > 1 ? `<svg viewBox="0 0 120 34" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="#f4b740" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>` : ''}
    <span>Last saved: <b>${last.score}</b> (${esc(TYPE_LABEL[last.type] || last.type)}, ${esc(platformName(last.platform))}) on ${esc(new Date(last.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))}</span>
    <button class="btn btn-quiet btn-sm" id="clearRuns" type="button">Clear</button>`;
  el.classList.remove('hidden');
  $('#clearRuns').addEventListener('click', () => { localStorage.removeItem(RUNS_KEY); renderPastRuns(); toast('Saved runs cleared'); });
}
renderPastRuns();

// ---------------------------------------------------------------------------
function showError(title, msg) {
  goStep(4);
  $('#stepRun').innerHTML = `<div class="error-box"><h3>${esc(title)}</h3><p>${esc(msg)}</p><button class="btn btn-lantern" id="errBack" type="button">Start again</button></div>`;
  $('#errBack').addEventListener('click', () => goStep(state.platform ? 3 : 2));
  $('#start').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
}

