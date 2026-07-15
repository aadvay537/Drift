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

  // ---- auto-scroll to the bottom, batch by batch --------------------------
  // The reliable way to advance an infinite-scroll feed is NOT window.scrollBy:
  // YouTube's history often scrolls an inner container, not the window, so
  // window scrolling silently does nothing and you get only the first screen
  // (~12 items). Instead we grab the LAST loaded card and pull it into view.
  // scrollIntoView works no matter which ancestor actually scrolls, and it is
  // exactly what triggers YouTube to lazy-load the next batch. We also nudge
  // every scrollable container as a belt-and-braces fallback, then harvest.
  var MAX_ITEMS = 5000;
  // MAX_TIME_MS is a hard stop so it can never hang forever; stable counts
  // consecutive "nothing changed" tries before we decide we're at the end.
  var MAX_TIME_MS = 10 * 60 * 1000;
  var startMs = RUN_NOW.getTime();
  var stable = 0;
  var lastLog = -1;

  function lastCard() {
    var links = document.querySelectorAll('a#video-title-link, a[href*="/watch?v="], shreddit-post, article');
    return links.length ? links[links.length - 1] : null;
  }

  // Push the feed down one batch. Returns the tallest scroll height we saw so
  // the caller can tell whether anything new actually loaded.
  function scrollDown() {
    var last = lastCard();
    if (last && last.scrollIntoView) { try { last.scrollIntoView({ block: 'end', inline: 'nearest' }); } catch (e) {} }
    var step = Math.max(800, (window.innerHeight || 800));
    try { window.scrollBy(0, step); } catch (e) {}
    var maxH = document.documentElement.scrollHeight;
    // Nudge any inner element that has its own scrollbar (covers YouTube's
    // container-scrolled layouts) and track the tallest one.
    var all = document.querySelectorAll('div, main, ytd-app, #contents, #primary');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.scrollHeight > el.clientHeight + 40) {
        try { el.scrollTop = el.scrollTop + step; } catch (e) {}
        if (el.scrollHeight > maxH) maxH = el.scrollHeight;
      }
    }
    return maxH;
  }

  while (true) {
    harvest();
    if (seen.size !== lastLog) { bar.textContent = 'Drift: loading your history… ' + seen.size + ' items'; lastLog = seen.size; }
    if (seen.size >= MAX_ITEMS) break;
    if (new Date().getTime() - startMs > MAX_TIME_MS) break;

    var beforeCount = seen.size;
    // scrollDown() scrolls the feed AND returns the tallest scroll height.
    var beforeH = scrollDown();
    // Give the next batch a moment to lazy-load and render, then read it.
    await sleep(1000);
    harvest();

    var afterH = document.documentElement.scrollHeight;
    var all2 = document.querySelectorAll('div, main, ytd-app, #contents, #primary');
    for (var j = 0; j < all2.length; j++) { if (all2[j].scrollHeight > afterH) afterH = all2[j].scrollHeight; }

    // gained = we read new videos; grew = more history lazy-loaded in.
    var gained = seen.size > beforeCount;
    var grew = afterH > beforeH + 4;

    if (gained || grew) {
      stable = 0;
    } else {
      // Nothing new this time — but the batch may just be slow to arrive.
      // Wait longer and try again; only give up after several empty tries.
      stable++;
      await sleep(1400);
      scrollDown();
      await sleep(900);
      harvest();
      if (stable >= 6) break;
    }
  }
  harvest();
  try { window.scrollTo(0, 0); } catch (e) {}
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
