/*
 * Drift "Grab my history" bookmarklet — full, readable source (PRD §3, §7).
 *
 * What it does, and ONLY this:
 *   - Runs on the history page you clicked it on (YouTube or Reddit).
 *   - Auto-scrolls the page for you to load your older history.
 *   - Reads each video/post card: title, channel, duration, and date. Nothing else.
 *   - Saves ONE small JSON file straight to your device. It talks to no server.
 *
 * It cannot see your password, your other tabs, or anything beyond this page.
 * This is the exact code behind the draggable button — read it top to bottom.
 */
void (async function () {
  var host = location.hostname;
  var isReddit = host.indexOf('reddit') !== -1;
  var isYouTube = host.indexOf('youtube') !== -1;

  if (!isYouTube && !isReddit) {
    alert('Open your YouTube history (youtube.com/feed/history) or your Reddit profile history, then click this.');
    return;
  }

  // ---- small helpers ------------------------------------------------------
  // Snapshot "now" ONCE. We re-read the same cards on every scroll pass, so
  // relative dates ("Today"/"Yesterday") MUST resolve identically each time —
  // otherwise the same video gets a new timestamp per pass and never de-dupes.
  var RUN_NOW = new Date();

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function txt(el, sel) { if (!el) return ''; var n = el.querySelector(sel); return n ? n.textContent.trim() : ''; }

  // "12:34" or "1:02:03" -> seconds.
  function toSeconds(s) {
    if (!s) return 0;
    var p = s.split(':').map(Number).reverse();
    return (p[0] || 0) + (p[1] || 0) * 60 + (p[2] || 0) * 3600;
  }

  // "Today" / "Yesterday" / "Jun 12, 2026" -> ISO date. Deterministic per run.
  function parseDate(label) {
    var now = new Date(RUN_NOW.getTime());
    if (!label) return now.toISOString();
    var l = label.toLowerCase();
    if (l.indexOf('today') !== -1) return now.toISOString();
    if (l.indexOf('yesterday') !== -1) { now.setDate(now.getDate() - 1); return now.toISOString(); }
    var d = new Date(label);
    return isNaN(d.getTime()) ? now.toISOString() : d.toISOString();
  }

  // ---- a tiny status bar so you can see it working ------------------------
  var bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483647;background:#111;color:#fff;font:600 14px/1.4 system-ui,-apple-system,sans-serif;padding:10px 16px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.35);pointer-events:none;';
  bar.textContent = 'Drift: loading your history…';
  document.body.appendChild(bar);

  // ---- collect as we scroll, into a de-duped map, so nothing is lost even if
  //      the page recycles old cards (new Reddit) as you move down ------------
  var seen = new Map();

  // YouTube: find the actual video *links* (/watch?v=…). Anchoring on the link
  // instead of a specific custom-element tag survives YouTube's layout changes,
  // which is what makes "no history found" happen with tag-based selectors.
  function harvestYouTube() {
    var links = document.querySelectorAll('a#video-title-link');
    if (!links.length) links = document.querySelectorAll('a[href*="/watch?v="]');
    links.forEach(function (a) {
      var href = a.getAttribute('href') || '';
      if (href.indexOf('/watch') === -1) return;
      var title = (a.getAttribute('title') || a.textContent || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      if (!title) return;
      var m = href.match(/[?&]v=([\w-]+)/);
      var vid = m ? m[1] : title;
      var card = a.closest('ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer') || a.parentElement || a;
      var section = a.closest('ytd-item-section-renderer');
      var dateLabel = section ? txt(section, '#title, #header #title, .ytd-item-section-header-renderer') : '';
      var when = parseDate(dateLabel);
      var key = vid + '|' + when;
      if (seen.has(key)) return;
      seen.set(key, {
        title: title,
        channel: txt(card, 'ytd-channel-name #text') || txt(card, '#channel-name #text') || txt(card, '#channel-name'),
        durationSec: toSeconds(
          txt(card, 'ytd-thumbnail-overlay-time-status-renderer #text') ||
          txt(card, '.badge-shape-wiz__text') ||
          txt(card, '#time-status #text')
        ),
        watchedAt: when
      });
    });
  }

  function harvestReddit() {
    document.querySelectorAll('shreddit-post, article').forEach(function (card) {
      var title = txt(card, 'a[slot="title"]') || txt(card, 'h3') || txt(card, '[id^="post-title"]');
      if (!title) return;
      var time = card.querySelector('time');
      var when = (time && time.getAttribute('datetime')) || RUN_NOW.toISOString();
      var key = title + '|' + when;
      if (seen.has(key)) return;
      seen.set(key, { title: title, channel: txt(card, 'a[href^="/r/"]'), durationSec: 0, watchedAt: when });
    });
  }

  var harvest = isYouTube ? harvestYouTube : harvestReddit;

  // ---- auto-scroll until no new items load (or we hit a safe limit) --------
  var MAX_ROUNDS = 120, MAX_ITEMS = 5000, stable = 0;
  for (var round = 0; round < MAX_ROUNDS; round++) {
    harvest();
    bar.textContent = 'Drift: loading your history… ' + seen.size + ' items';
    if (seen.size >= MAX_ITEMS) break;
    var before = seen.size;
    window.scrollTo(0, document.documentElement.scrollHeight);
    await sleep(900);
    harvest();
    if (seen.size === before) { stable++; if (stable >= 3) break; } else { stable = 0; }
  }
  harvest();
  window.scrollTo(0, 0);
  bar.remove();

  var items = Array.from(seen.values()).slice(0, MAX_ITEMS);
  if (!items.length) {
    alert('Drift: no history cards found here. Make sure you are on your history page (youtube.com/feed/history, or your Reddit profile) and try again.');
    return;
  }

  // ---- save one small file straight to your device ------------------------
  var file = { source: isReddit ? 'reddit' : 'youtube', grabbedAt: new Date().toISOString(), count: items.length, items: items };
  var blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'drift-history-' + file.source + '.json';
  a.click();
  alert('Drift: saved ' + items.length + ' items to your downloads. Now drop that file into the Drift site.');
})();
