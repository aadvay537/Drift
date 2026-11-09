// End-to-end smoke test of the Drift website in a headless browser.
//   SITE=https://aadvay537.github.io/Drift/ node scripts/site-check.mjs
//   SITE=http://localhost:3000/ node scripts/site-check.mjs
// Checks: every page loads with no console errors (desktop + phone),
// the sample report renders, Ask Drift answers a free-form question,
// and the consent questions never allow sharing for under-13s or 13–17s
// without a parent's OK. Exits 1 if anything fails.
import { createRequire } from 'module';
// require() (unlike import) also finds a globally installed Playwright via NODE_PATH.
const { chromium, devices } = createRequire(import.meta.url)('playwright');

const SITE = (process.env.SITE || 'http://localhost:3000/').replace(/\/?$/, '/');
const PAGES = ['index.html', 'start.html', 'how.html', 'privacy.html', 'help.html', 'results.html'];
const failures = [];
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); failures.push(m); };

async function withPage(browser, ctxOpts, fn) {
  const ctx = await browser.newContext(ctxOpts);
  // STUB_FONTS=1: answer Google Fonts with an empty stylesheet (for sandboxes without internet).
  if (process.env.STUB_FONTS) await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  try { await fn(page, errors); } finally { await ctx.close(); }
}

const browser = await chromium.launch();
for (const [label, opts] of [['desktop', { viewport: { width: 1280, height: 860 } }], ['phone', devices['iPhone 13']]]) {
  console.log(`\nPages (${label})`);
  for (const p of PAGES) {
    await withPage(browser, opts, async (page, errors) => {
      const res = await page.goto(SITE + p, { waitUntil: 'networkidle', timeout: 60000 }).catch((e) => ({ status: () => String(e) }));
      await page.waitForTimeout(800);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      if (res.status() !== 200) bad(`${p}: HTTP ${res.status()}`);
      else if (errors.length) bad(`${p}: console errors → ${errors.slice(0, 3).join(' | ')}`);
      else if (wide) bad(`${p}: page scrolls sideways on ${label}`);
      else ok(`${p}`);
    });
  }

  console.log(`Sample report (${label})`);
  await withPage(browser, opts, async (page, errors) => {
    await page.goto(SITE + 'start.html?sample=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
    // The "here's exactly what will be sent" preview comes first.
    await page.locator('#sendConfirm').click({ timeout: 30000 }).catch(() => bad('send preview never appeared'));
    const done = await page.locator('.dial').first().waitFor({ timeout: 90000 }).then(() => true).catch(() => false);
    const text = done ? await page.locator('#stepRun').innerText() : '';
    if (!done) bad('sample report never appeared');
    else if (!/example report, so nothing is shared/i.test(text)) bad('sample report does not say nothing is shared');
    else ok('sample report renders and shares nothing');
    if (errors.length) bad('sample console errors → ' + errors.slice(0, 3).join(' | '));
  });
}

console.log('\nConsent questions');
await withPage(browser, {}, async (page) => {
  await page.goto(SITE + 'start.html', { waitUntil: 'domcontentloaded' });
  const pick = (n, v) => page.check(`input[name=${n}][value="${v}"]`);
  const state = async () => ({
    enabled: !(await page.locator('#consentNext').isDisabled()),
    note: await page.locator('#consentNote').innerText(),
    parentShown: await page.locator('#qParent').isVisible(),
  });
  await pick('share', 'yes'); await pick('age', 'under13');
  let s = await state();
  s.enabled && /device only/i.test(s.note) ? ok('under-13 → nothing shared') : bad('under-13 consent: ' + JSON.stringify(s));
  await pick('age', '13-17');
  s = await state();
  !s.enabled && s.parentShown ? ok('13–17 asks for a parent') : bad('13–17 did not ask for parent: ' + JSON.stringify(s));
  await pick('parent', 'no');
  s = await state();
  s.enabled && /device only/i.test(s.note) ? ok('13–17 without parent → nothing shared') : bad('13–17 no parent: ' + JSON.stringify(s));
  await page.click('#consentNext');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('drift.consent.v1')));
  stored && stored.share === false ? ok('saved choice is share:false') : bad('saved consent was ' + JSON.stringify(stored));
});

console.log('\nAsk Drift (free-form)');
await withPage(browser, {}, async (page) => {
  await page.goto(SITE + 'index.html', { waitUntil: 'domcontentloaded' });
  await page.click('#chatFab');
  await page.fill('#cwInput', 'In one sentence, what is a recommendation algorithm?');
  await page.press('#cwInput', 'Enter');
  const last = page.locator('#cwLog .msg, #cwLog > *').last();
  let answer = '';
  for (let i = 0; i < 90 && !answer; i++) {
    await page.waitForTimeout(2000);
    const t = (await last.innerText().catch(() => '')).trim();
    if (t && !/waking|starting up/i.test(t) && !(await page.locator('#cwLog .dots').count())) answer = t;
  }
  if (!answer) bad('chat never answered');
  else if (/couldn.t be reached|still starting up|a lot of questions/i.test(answer)) bad('chat error: ' + answer.slice(0, 120));
  else ok('chat answered: ' + answer.replace(/\s+/g, ' ').slice(0, 100));
});

await browser.close();
console.log(failures.length ? `\nFAILED (${failures.length})` : '\nALL SITE CHECKS PASS');
process.exit(failures.length ? 1 : 0);
