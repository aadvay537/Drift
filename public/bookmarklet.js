/*
 * Drift "Grab my history" bookmarklet — full, readable source (PRD §3, §7).
 *
 * What it does, and ONLY this:
 *   - Runs on the history page you clicked it on (YouTube or Reddit).
 *   - Does NOT move the page for you. YOU scroll softly down your history;
 *     it just watches and collects each card as it passes by.
 *   - Reads each video/post card: title, channel, duration, and date. Nothing else.
 *   - When you press "Download my history", saves ONE small JSON file straight
 *     to your device. It talks to no server.
 *
 * It cannot see your password, your other tabs, or anything beyond this page.
 * This is the exact code behind the draggable button — read it top to bottom.
 */
void (function () {
  var host = location.hostname;
  var isReddit = host.indexOf('reddit') !== -1;
  var isYouTube = host.indexOf('youtube') !== -1;

  if (!isYouTube && !isReddit) {
    alert('Open your YouTube history (youtube.com/feed/history) or your Reddit profile history, then click this.');
    return;
  }

  // ---- small helpers ------------------------------------------------------
  // Snapshot "now" ONCE. We re-read the same cards many times while you scroll,
  // so relative dates ("Today"/"Yesterday") MUST resolve identically each time —
  // otherwise the same video gets a new timestamp per read and never de-dupes.
  var RUN_NOW = new Date();

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

  // ---- collect into a de-duped map, so nothing is lost even when the page
  //      recycles old cards out of view as you scroll ------------------------
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

  // ---- a little panel: live counter + the download button -----------------
  // We deliberately do NOT scroll the page. You scroll softly to the bottom of
  // your history yourself; this panel just shows the running count and lets you
  // save when you are done. Scrolling by hand is what reliably loads older
  // history, and going gently keeps each card on screen long enough to be read.
  var panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:12px;background:#111;color:#fff;font:600 14px/1.4 system-ui,-apple-system,sans-serif;padding:10px 14px;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35);';

  var label = document.createElement('span');
  label.textContent = 'Drift is watching — scroll slowly to the bottom of your history…';

  var btn = document.createElement('button');
  btn.textContent = 'Download my history';
  btn.style.cssText = 'cursor:pointer;border:0;border-radius:9px;padding:8px 12px;font:700 13px system-ui,sans-serif;background:linear-gradient(135deg,#ffb27c,#ff8a8a);color:#2a0f0f;';

  panel.appendChild(label);
  panel.appendChild(btn);
  document.body.appendChild(panel);

  // Keep collecting as you scroll: on every scroll (capture=true catches scroll
  // on inner containers too, not just the window) and on a steady timer as a
  // safety net, so nothing slips past between scrolls.
  function tick() {
    harvest();
    label.textContent = 'Drift is watching — scroll slowly. Collected ' + seen.size + ' item' + (seen.size === 1 ? '' : 's') + '. Press Download when you reach the bottom.';
  }
  tick();
  var timer = setInterval(tick, 600);
  window.addEventListener('scroll', tick, true);

  btn.addEventListener('click', function () {
    clearInterval(timer);
    window.removeEventListener('scroll', tick, true);
    harvest();
    panel.remove();

    var items = Array.from(seen.values());
    if (!items.length) {
      alert('Drift: no history cards found. Make sure you are on your history page (youtube.com/feed/history, or your Reddit profile), scroll through it a little, then try again.');
      return;
    }

    // ---- save one small file straight to your device ----------------------
    var file = { source: isReddit ? 'reddit' : 'youtube', grabbedAt: new Date().toISOString(), count: items.length, items: items };
    var blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'drift-history-' + file.source + '.json';
    a.click();
    alert('Drift: saved ' + items.length + ' items to your downloads. Now drop that file into the Drift site.');
  });
})();
