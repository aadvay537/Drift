/*
 * Drift "Grab my history" bookmarklet — full, readable source (PRD §3, §7).
 *
 * What it does, and ONLY this:
 *   - Runs on the history page you clicked it on (YouTube or Reddit).
 *   - Reads the video/post cards already loaded on that page.
 *   - Pulls out: title, channel, duration, and date. Nothing else.
 *   - Saves ONE small JSON file straight to your device. It talks to no server.
 *
 * It cannot see your password, your other tabs, or anything beyond this page.
 * This is the exact code behind the draggable button — read it top to bottom.
 */
(function () {
  var host = location.hostname;
  var items = [];

  function txt(el, sel) { var n = el.querySelector(sel); return n ? n.textContent.trim() : ''; }

  // Turn "12:34" or "1:02:03" into seconds.
  function toSeconds(s) {
    if (!s) return 0;
    var p = s.split(':').map(Number).reverse();
    return (p[0] || 0) + (p[1] || 0) * 60 + (p[2] || 0) * 3600;
  }

  if (host.indexOf('youtube') !== -1) {
    // History is grouped under dated sections; each video is a *-renderer card.
    document.querySelectorAll('ytd-item-section-renderer, ytd-section-list-renderer > #contents > *').forEach(function (section) {
      var dateLabel = txt(section, '#title, #header #title, .ytd-item-section-header-renderer');
      section.querySelectorAll('ytd-video-renderer, ytd-grid-video-renderer').forEach(function (card) {
        var title = txt(card, '#video-title, a#video-title-link');
        if (!title) return;
        items.push({
          title: title,
          channel: txt(card, 'ytd-channel-name #text, #channel-name #text'),
          durationSec: toSeconds(txt(card, 'ytd-thumbnail-overlay-time-status-renderer #text, .ytd-thumbnail-overlay-time-status-renderer')),
          watchedAt: parseDate(dateLabel)
        });
      });
    });
  } else if (host.indexOf('reddit') !== -1) {
    document.querySelectorAll('shreddit-post, article').forEach(function (card) {
      var title = txt(card, 'a[slot="title"], h3, [id^="post-title"]');
      if (!title) return;
      var time = card.querySelector('time');
      items.push({
        title: title,
        channel: txt(card, 'a[href^="/r/"]'),
        durationSec: 0,
        watchedAt: time ? (time.getAttribute('datetime') || new Date().toISOString()) : new Date().toISOString()
      });
    });
  } else {
    alert('Open your YouTube history (youtube.com/feed/history) or Reddit profile, then click this.');
    return;
  }

  if (!items.length) {
    alert('Drift: no history cards found on this page. Make sure you are on your history page and have scrolled down a little.');
    return;
  }

  var file = { source: host.indexOf('reddit') !== -1 ? 'reddit' : 'youtube', grabbedAt: new Date().toISOString(), count: items.length, items: items };
  var blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'drift-history-' + file.source + '.json';
  a.click();
  alert('Drift: saved ' + items.length + ' items to your downloads. Now drop that file into the Drift site.');

  // Best-effort date parser: "Today" / "Yesterday" / "Jun 12, 2026" → ISO.
  function parseDate(label) {
    var now = new Date();
    if (!label) return now.toISOString();
    var l = label.toLowerCase();
    if (l.indexOf('today') !== -1) return now.toISOString();
    if (l.indexOf('yesterday') !== -1) { now.setDate(now.getDate() - 1); return now.toISOString(); }
    var d = new Date(label);
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
})();
