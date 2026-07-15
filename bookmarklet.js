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

  // "Today" / "Saturday" / "Jul 10" / "Jun 12, 2026" -> ISO date. Deterministic per run.
  // The traps this must dodge, learned the hard way:
  //   - Year-less labels ("Jul 10") parse to July 10, 2001 in Chrome. Trusting
  //     new Date() either poisons the file with 2001 dates or (with a sanity
  //     check alone) collapses EVERY video to "today" — zero days of coverage,
  //     so even a 120-video grab came back "not enough data". We read the month
  //     and day ourselves and anchor them to the current year.
  //   - Bare weekday headers ("Saturday", how YouTube labels the last week)
  //     don't parse at all — we step back to the most recent such day.
  //   - Anything still implausible (before YouTube existed / in the future)
  //     falls back to today rather than wrecking the timeline.
  var MONTH_IDX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  var DAY_IDX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  var MIN_T = new Date('2005-02-01').getTime();
  function parseDate(label) {
    var now = new Date(RUN_NOW.getTime());
    var maxT = RUN_NOW.getTime() + 24 * 3600 * 1000;
    if (!label) return now.toISOString();
    var l = label.toLowerCase().replace(/\s+/g, ' ').trim();
    if (l.indexOf('today') !== -1) return now.toISOString();
    if (l.indexOf('yesterday') !== -1) { now.setDate(now.getDate() - 1); return now.toISOString(); }
    var wd = l.match(/^(sun|mon|tue|wed|thu|fri|sat)[a-z]*$/);
    if (wd) {
      var back = (RUN_NOW.getDay() - DAY_IDX[wd[1]] + 7) % 7 || 7;
      now.setDate(now.getDate() - back);
      return now.toISOString();
    }
    var m = l.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})\b/);
    if (!m) {
      var m2 = l.match(/\b(\d{1,2})\.? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/);
      if (m2) m = [m2[0], m2[2], m2[1]];
    }
    if (m) {
      var ym = l.match(/\b(20\d{2})\b/);
      var d = new Date(ym ? +ym[1] : RUN_NOW.getFullYear(), MONTH_IDX[m[1]], +m[2], 12, 0, 0);
      if (!ym && d.getTime() > maxT) d.setFullYear(d.getFullYear() - 1);
      if (!isNaN(d.getTime()) && d.getTime() >= MIN_T && d.getTime() <= maxT) return d.toISOString();
      return now.toISOString();
    }
    if (/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/.test(l)) {
      var d2 = new Date(l);
      if (!isNaN(d2.getTime()) && d2.getTime() >= MIN_T && d2.getTime() <= maxT) return d2.toISOString();
    }
    return now.toISOString();
  }

  // ---- collect into a de-duped map, so nothing is lost even when the page
  //      recycles old cards out of view as you scroll ------------------------
  var seen = new Map();

  // YouTube: scan EVERY link to a video — normal videos (/watch?v=…) AND Shorts
  // (/shorts/…). Anchoring on the link, not a specific custom-element tag,
  // survives YouTube's frequent layout changes (tag-based selectors are what
  // make "no history found" happen), and picking up both URL shapes is why
  // Shorts-heavy histories used to come back nearly empty.
  var CARD_SEL = 'ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer, ytd-reel-item-renderer, ytm-shorts-lockup-view-model, ytd-compact-video-renderer';
  function harvestYouTube() {
    var links = document.querySelectorAll('a[href*="/watch?v="], a[href*="/shorts/"]');
    links.forEach(function (a) {
      var href = a.getAttribute('href') || '';
      var m = href.match(/[?&]v=([\w-]+)/) || href.match(/\/shorts\/([\w-]+)/);
      if (!m) return;
      var vid = m[1];
      var card = a.closest(CARD_SEL) || a.parentElement || a;
      var title = (a.getAttribute('title') || a.getAttribute('aria-label') || a.textContent || '').replace(/\s+/g, ' ').trim();
      if (!title) title = txt(card, '#video-title') || txt(card, 'h3') || txt(card, '[id^="video-title"]');
      if (!title) return;
      var section = a.closest('ytd-item-section-renderer');
      // The date is the section's header ("Today" / "Jul 10, 2026"). Try the header
      // element first, then broader fallbacks — a missed header used to stamp every
      // card as "today", collapsing coverage to 0 days and reading as "not enough data".
      var dateLabel = section ? (
        txt(section, 'ytd-item-section-header-renderer #title') ||
        txt(section, '#header #title') ||
        txt(section, '#title') ||
        txt(section, '.ytd-item-section-header-renderer')
      ) : '';
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

  // Keep collecting as you scroll. Three overlapping nets so nothing is missed,
  // even though YouTube deletes each card the instant it scrolls out of view:
  //   1. A MutationObserver fires the moment ANY new card is inserted — this is
  //      the important one: it catches every card while it is briefly alive,
  //      no matter how fast you scroll past it.
  //   2. A scroll listener (capture=true also catches inner-container scrolls).
  //   3. A steady timer, as a final safety net.
  // Day coverage shown live, so you can SEE real dates being captured — if the
  // day count sits at 1 while you scroll past older videos, something is wrong.
  function dayCount() {
    var days = {};
    seen.forEach(function (v) { days[String(v.watchedAt).slice(0, 10)] = 1; });
    return Object.keys(days).length;
  }
  function tick() {
    harvest();
    var d = dayCount();
    label.textContent = 'Drift is watching — scroll slowly. Collected ' + seen.size + ' item' + (seen.size === 1 ? '' : 's') + ' across ' + d + ' day' + (d === 1 ? '' : 's') + '. Press Download when you reach the bottom.';
  }
  // The observer can fire a flood of mutations while scrolling, so throttle the
  // actual work to ~every 120ms (leading + trailing) — fast enough to catch a
  // card before it is recycled away, cheap enough not to lag the page.
  var lastRun = 0, trailing = null;
  function runTick() { lastRun = Date.now(); tick(); }
  function throttled() {
    var since = Date.now() - lastRun;
    if (since >= 120) { runTick(); }
    else if (!trailing) { trailing = setTimeout(function () { trailing = null; runTick(); }, 120 - since); }
  }
  runTick();
  var observer = new MutationObserver(throttled);
  observer.observe(document.body, { childList: true, subtree: true });
  var timer = setInterval(tick, 600);
  window.addEventListener('scroll', throttled, true);

  function stop() {
    clearInterval(timer);
    if (trailing) { clearTimeout(trailing); trailing = null; }
    window.removeEventListener('scroll', throttled, true);
    try { observer.disconnect(); } catch (e) {}
  }

  btn.addEventListener('click', function () {
    stop();
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
    alert('Drift: saved ' + items.length + ' items covering ' + dayCount() + ' day(s) to your downloads. Now drop that file into the Drift site.');
  });
})();
