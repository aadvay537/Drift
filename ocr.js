// ocr.js — read text from screenshots INSIDE the browser (nothing is uploaded).
// Uses Tesseract (open-source text recognition), hosted on this site in /vendor/ocr.

const BASE = new URL('./vendor/ocr/', import.meta.url).href;
let workerPromise = null;

function loadScript(src) {
  return new Promise((res, rej) => {
    if (window.Tesseract) return res();
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load the text reader.'));
    document.head.appendChild(s);
  });
}

async function getWorker(onStatus) {
  if (!workerPromise) {
    workerPromise = (async () => {
      onStatus?.('Getting the text reader ready (first time only)…');
      await loadScript(BASE + 'tesseract.min.js');
      return window.Tesseract.createWorker('eng', 1, {
        workerPath: BASE + 'worker.min.js',
        corePath: BASE,
        langPath: BASE,
        gzip: true,
        workerBlobURL: false,
      });
    })().catch((e) => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

/** Read each image; returns [{name, text}] in the order given. */
export async function readImages(files, onStatus) {
  const worker = await getWorker(onStatus);
  const out = [];
  for (let i = 0; i < files.length; i++) {
    onStatus?.(`Reading screenshot ${i + 1} of ${files.length} on your device…`);
    const { data } = await worker.recognize(files[i]);
    out.push({ name: files[i].name, text: data.text || '' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// YouTube history screenshots → titles (+ any date headers, durations).
// In the YouTube app's History list, each video is its title (1–2 lines)
// followed by a line with the channel and views, e.g. "Channel · 1.2M views".
// ---------------------------------------------------------------------------
const UI_NOISE = /^(recently viewed|recent|popular|answers|chat|inbox|communities|history|search watch history|home|shorts|subscriptions|you|library|watch history|manage all history|all|videos|music|podcasts|live|clear all watch history|pause watch history|[+]|create|notifications)$/i;
const META = /(\bviews?\b|\bwatched\b|\bago\b|[•·]|\bsubscribers?\b|\br\/\w+|\bu\/\w+|\bcomments?\b|\bupvotes?\b|\bvotes?\b|\bpromoted\b)/i;
const STATUS_BAR = /^\s*\d{1,2}:\d{2}\s*(am|pm)?\s*[\W\d%]*$/i;
const DUR = /^\d{1,2}:\d{2}(:\d{2})?$/;
const DATE_HDR = /^(today|yesterday|(sun|mon|tue|wed|thu|fri|sat)[a-z]*(,?\s.*\d)?|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(,\s*\d{4})?|\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(\s+\d{4})?)$/i;

/** Turn the text of YouTube history screenshots into a paste-style text block. */
export function youtubeTextFromScreens(pages) {
  const out = [];
  for (const { text } of pages) {
    const lines = text.split(/\r?\n/).map((l) => l.replace(/[|_~]+/g, ' ').replace(/\s{2,}/g, ' ').trim()).filter(Boolean);
    let buf = [];
    let first = true;
    const flush = () => { const t = buf.join(' ').trim(); if (t.length >= 8 && /[a-z]/i.test(t)) out.push(t); buf = []; };
    for (const line of lines) {
      if (first && STATUS_BAR.test(line)) { first = false; continue; } // phone clock at the top
      first = false;
      if (UI_NOISE.test(line)) continue;
      if (DATE_HDR.test(line)) { flush(); out.push(line); continue; }
      if (DUR.test(line)) { flush(); out.push(line); continue; }
      if (META.test(line)) { flush(); continue; } // channel · views line ends a video
      if (line.length < 4) continue;
      buf.push(line);
      if (buf.length > 3) buf.shift(); // titles are at most ~3 lines
    }
    flush();
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Screen Time / Digital Wellbeing screenshots → daily average + time per app.
// ---------------------------------------------------------------------------
const APPS = ['Instagram', 'YouTube', 'TikTok', 'Snapchat', 'WhatsApp', 'Reddit', 'Facebook', 'X', 'Twitter', 'Threads', 'Netflix', 'Prime Video', 'Hotstar', 'JioCinema', 'Spotify', 'Chrome', 'Safari', 'Discord', 'Telegram', 'Pinterest', 'LinkedIn', 'Messages', 'Photos', 'Camera', 'Games', 'Roblox', 'Minecraft', 'BGMI', 'Free Fire', 'Clash of Clans', 'ChatGPT', 'Claude', 'Gmail', 'Maps', 'Moj', 'Josh', 'ShareChat'];
const SOCIAL = new Set(['Instagram', 'YouTube', 'TikTok', 'Snapchat', 'Reddit', 'Facebook', 'X', 'Twitter', 'Threads', 'Pinterest', 'Moj', 'Josh', 'ShareChat', 'Discord']);
const DUR_RE = /(\d{1,2})\s*h(?:r|rs|ours?)?\s*(?:(\d{1,2})\s*m(?:in|ins|inutes?)?)?|(\d{1,3})\s*m(?:in|ins|inutes?)?\b/i;

function toMinutes(m) {
  if (!m) return null;
  if (m[3]) return +m[3];
  return (+m[1]) * 60 + (+(m[2] || 0));
}

// Common text-reading slips in times: "Sh 40m" → "5h 40m", "1Om" → "10m".
function fixDigits(t) {
  return t.replace(/\b[Ss](?=\s?h\b)/g, '5').replace(/\b[lI|](?=\s?h\b)/g, '1')
    .replace(/(\d)[Oo](?=\s?[hm]\b)/g, '$10').replace(/\b[Oo](\d)(?=\s?[hm]\b)/g, '0$1');
}

export function parseScreenTime(pages) {
  const apps = new Map();
  let daily = null, pickups = null, weekly = false;
  for (const { text } of pages) {
    const lines = fixDigits(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/daily average/i.test(l)) {
        const m = (l.match(DUR_RE) || (lines[i + 1] || '').match(DUR_RE));
        const v = toMinutes(m); if (v && v < 24 * 60) daily = Math.max(daily || 0, v);
      }
      if (/\bweek\b|last 7 days/i.test(l)) weekly = true;
      if (/pick-?ups?/i.test(l)) {
        const n = (l.match(/(\d{1,4})/) || (lines[i + 1] || '').match(/^(\d{1,4})\b/));
        if (n) pickups = Math.max(pickups || 0, +n[1]);
      }
      for (const app of APPS) {
        const re = new RegExp(`^${app.replace(/\s/g, '\\s*')}\\b`, 'i');
        if (!re.test(l)) continue;
        const m = l.match(DUR_RE) || (lines[i + 1] || '').match(DUR_RE);
        const v = toMinutes(m);
        if (v != null && v > 0 && v < 24 * 60 * 7) apps.set(app, Math.max(apps.get(app) || 0, v));
      }
    }
  }
  const list = [...apps.entries()].map(([name, minutes]) => ({ name, minutes, social: SOCIAL.has(name) })).sort((a, b) => b.minutes - a.minutes).slice(0, 10);
  // A weekly view lists totals for the week; turn them into per-day averages.
  if (weekly && daily) {
    const sum = list.reduce((s, a) => s + a.minutes, 0);
    if (sum > daily * 2) list.forEach((a) => (a.minutes = Math.round(a.minutes / 7)));
  }
  return { dailyMinutes: daily, pickups, apps: list };
}

export const fmtMin = (m) => (m == null ? '–' : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
