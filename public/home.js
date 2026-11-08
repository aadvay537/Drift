// home.js — the home page: just the currents picture.
import { $, reduceMotion } from './common.js';

// ---------------------------------------------------------------------------
// The hero: many varied currents that slowly drift toward one narrow channel.
// It's the whole idea of Drift in one picture. Paused when off-screen.
// ---------------------------------------------------------------------------
(function currents() {
  const cv = $('#currents');
  const ctx = cv.getContext('2d');
  const colors = ['#63cfae', '#7fb4e6', '#c39bef', '#f0846c', '#e6d38a', '#5fa3a0'];
  let w, h, dpr, lines = [], visible = true, t0 = performance.now();
  function size() {
    dpr = Math.min(2, devicePixelRatio || 1);
    w = cv.clientWidth; h = cv.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = w < 700 ? 26 : 44;
    lines = Array.from({ length: n }, (_, i) => ({
      y0: (i + 0.5) / n,
      amp: 6 + Math.random() * 18,
      freq: 0.004 + Math.random() * 0.006,
      speed: 0.15 + Math.random() * 0.35,
      phase: Math.random() * 6.28,
      color: i % 9 === 4 ? '#f4b740' : colors[i % colors.length],
      alpha: 0.18 + Math.random() * 0.32,
    }));
  }
  function frame(now) {
    if (!visible) return;
    const t = (now - t0) / 1000;
    ctx.clearRect(0, 0, w, h);
    const target = h * 0.34; // where the currents converge, top-right
    for (const L of lines) {
      ctx.beginPath();
      for (let x = 0; x <= w; x += 8) {
        const p = x / w;
        const pull = p * p * (3 - 2 * p); // smoothstep: spread on the left, narrow on the right
        const base = L.y0 * h * (1 - pull) + (target + (L.y0 - 0.5) * h * 0.06) * pull;
        const y = base + Math.sin(x * L.freq + t * L.speed + L.phase) * L.amp * (1 - pull * 0.7);
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.strokeStyle = L.color;
      ctx.globalAlpha = L.alpha;
      ctx.lineWidth = L.color === '#f4b740' ? 1.8 : 1.1;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (!reduceMotion) requestAnimationFrame(frame);
  }
  size();
  addEventListener('resize', () => { size(); if (reduceMotion) frame(performance.now()); });
  new IntersectionObserver(([e]) => { const was = visible; visible = e.isIntersecting; if (visible && !was && !reduceMotion) requestAnimationFrame(frame); }).observe(cv);
  requestAnimationFrame(frame);
})();

