// platforms.js — read history downloads from every platform, in your browser.
//
// Supported:
//   - YouTube: Google Takeout watch-history.json (or the whole Takeout .zip),
//              the Drift bookmarklet file, or pasted text (handled in app.js)
//   - Reddit:  the Drift bookmarklet file
//   - Instagram: "Download your information" export (JSON format, .zip or files)
//   - TikTok:  "Download your data" export (JSON format, .zip or user_data json)
//
// Every platform is turned into the same shape:
//   { source, items:[{title, channel, durationSec, watchedAt}], hasTitles, note? }
// Nothing here talks to any server.

import { normalizeHistoryFile } from './normalize.js';

/** Read a dropped File (json or zip) and return a normalized history, or throw a friendly Error. */
export async function readHistoryFile(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.zip') || (await looksLikeZip(file))) {
    const entries = await unzipJson(file);
    return fromJsonFiles(entries);
  }
  const text = await file.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error('That file isn\'t JSON. If you downloaded from Instagram or TikTok, choose the JSON format (not HTML) when you request your data.'); }
  return fromJsonFiles([{ name, json }]);
}

/** Merge everything we recognise across one or more JSON files. */
export function fromJsonFiles(entries) {
  // 1. YouTube Takeout / bookmarklet / sample — the original formats.
  for (const e of entries) {
    if (/watch-history\.json$/.test(e.name) || Array.isArray(e.json) || Array.isArray(e.json?.items)) {
      const n = normalizeHistoryFile(e.json);
      if (n) return { ...n, hasTitles: true, platform: n.source === 'reddit' ? 'reddit' : 'youtube' };
    }
  }
  // 2. TikTok
  const tt = entries.flatMap((e) => tiktokItems(e.json));
  if (tt.length) {
    return {
      source: 'tiktok', platform: 'tiktok', hasTitles: false, items: tt,
      note: 'TikTok\'s download only records when you watched — not what. So Drift shows your watching rhythm, not topics.',
    };
  }
  // 3. Instagram
  const ig = instagramItems(entries);
  if (ig.items.length) {
    return {
      source: 'instagram', platform: 'instagram', hasTitles: false, items: ig.items,
      igTopics: ig.topics,
      note: 'Instagram\'s download lists whose posts you saw and when, but not captions. So Drift looks at creators and rhythm, and shows the interests Instagram has guessed for you.',
    };
  }
  throw new Error('We couldn\'t find watch history in that file. Drop Google Takeout\'s watch-history.json, the Drift bookmarklet file, or an Instagram/TikTok data download in JSON format.');
}

// ---------------------------------------------------------------------------
// TikTok: { "Your Activity": { "Watch History": { "VideoList": [{Date, Link}] } } }
// Older exports use "Activity" → "Video Browsing History". We search for any
// VideoList so both shapes (and future renames) work.
// ---------------------------------------------------------------------------
function tiktokItems(json) {
  const out = [];
  walk(json, (key, val) => {
    if (/videolist/i.test(key) && Array.isArray(val)) {
      for (const v of val) {
        const d = v && (v.Date || v.date);
        if (!d) continue;
        const t = Date.parse(String(d).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(d) ? '' : 'Z'));
        if (Number.isFinite(t)) out.push({ title: 'TikTok video', channel: '', durationSec: 0, watchedAt: new Date(t).toISOString() });
      }
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Instagram: files like posts_viewed.json / videos_watched.json hold
//   { "impressions_history_posts_seen": [{ "string_map_data": { "Author": {value}, "Time": {timestamp} } }] }
// liked_posts.json holds { "likes_media_likes": [{ title, string_list_data:[{timestamp}] }] }
// your_topics.json holds { "topics_your_topics": [{ string_map_data: { Name: {value} } }] }
// Meta renames keys from time to time, so we match loosely.
// ---------------------------------------------------------------------------
function instagramItems(entries) {
  const items = [];
  const topics = [];
  for (const { json } of entries) {
    if (!json || typeof json !== 'object') continue;
    for (const [key, arr] of Object.entries(json)) {
      if (!Array.isArray(arr)) continue;
      if (/topic/i.test(key)) {
        for (const r of arr) {
          const n = r?.string_map_data?.Name?.value || r?.value || r?.title;
          if (n) topics.push(String(n));
        }
        continue;
      }
      if (!/impression|viewed|watched|seen|likes/i.test(key)) continue;
      const kind = /video|reel/i.test(key) ? 'Reel' : /like/i.test(key) ? 'Liked post' : 'Post';
      for (const r of arr) {
        const smd = r?.string_map_data || {};
        const author = smd.Author?.value || smd.Owner?.value || smd.Username?.value || r?.title || '';
        const ts = smd.Time?.timestamp || r?.string_list_data?.[0]?.timestamp || r?.timestamp;
        if (!ts) continue;
        items.push({ title: `${kind}${author ? ' by ' + author : ''}`, channel: author, durationSec: 0, watchedAt: new Date(Number(ts) * 1000).toISOString() });
      }
    }
  }
  items.sort((a, b) => (a.watchedAt < b.watchedAt ? 1 : -1)); // newest first, like other files
  return { items, topics: [...new Set(topics)].slice(0, 40) };
}

function walk(o, fn, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 6) return;
  for (const [k, v] of Object.entries(o)) { fn(k, v); if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, fn, depth + 1); }
}

// ---------------------------------------------------------------------------
// A tiny zip reader using the browser's built-in DecompressionStream, so a
// whole Takeout / Instagram / TikTok zip can be dropped as-is. Only .json
// files with history-ish names are opened; the rest are never read.
// ---------------------------------------------------------------------------
const WANTED = /(watch-history|posts_viewed|videos_watched|liked_posts|your_topics|recommended_topics|user_data|watch_history|browsing)[^/]*\.json$/i;

async function looksLikeZip(file) {
  const b = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

export async function unzipJson(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer);
  // Find End Of Central Directory (signature 0x06054b50) scanning backwards.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('That zip looks damaged. Try unzipping it and dropping the JSON file instead.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [];
  const dec = new TextDecoder();
  for (let n = 0; n < count && p < buf.length; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!WANTED.test(name)) continue;
    const lNameLen = dv.getUint16(local + 26, true);
    const lExtraLen = dv.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    let bytes;
    if (method === 0) bytes = raw;
    else if (method === 8) bytes = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else continue;
    try { out.push({ name: name.toLowerCase(), json: JSON.parse(dec.decode(bytes)) }); } catch { /* not JSON — skip */ }
  }
  if (!out.length) throw new Error('No history files found inside that zip. For Instagram and TikTok, make sure you chose JSON format when requesting your data.');
  return out;
}
