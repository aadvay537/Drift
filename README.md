# Drift 🪞

**A mirror, not a filter.** One click grabs your own YouTube/Reddit history, and in about two
minutes Drift shows you what kind of algorithmic influence you've been under — using an **AI agent**
to read your content, **plain published rules** to classify it, and a **tone-checked report** that
informs without judging.

This is a working implementation of the [Drift PRD v3.1](./Drift-PRD-v3.1-simple.md).

## What's new in v4

- **Full redesign** — a guided three-step flow (pick your app → get your history → see your drift), new visual identity, mobile-friendly.
- **Instagram & TikTok** — drop their data download (JSON, even the whole `.zip`). These files have no titles, so Drift shows rhythm, creator concentration and Instagram's own guessed interests — and nothing from them is sent anywhere.
- **Richer report** — week-by-week chart with the "shift starts" marker, what moved (topic shares), when you watch (24-hour view), who fills your feed.
- **Ask your data** — questions about your own history (late nights, busiest week, top creators, when it changed) are answered on your device; the rest go to the assistant with only the summary.
- **Share card** (PNG) and **saved runs** (summary only, in your browser) to compare over time.
- **Under the hood** — current model names, a fast cheap model for labelling (`DRIFT_LABEL_MODEL`), parallel batches, a shared label cache, per-visitor rate limits, security headers, and an honest `/api/health` so a broken key or model name can't hide behind the demo engine.

## Pages (v4.1)

`index.html` home · `start.html` get your report (consent → app → history → report) · `how.html` · `privacy.html` · `help.html` · `results.html` shared totals. Shared code lives in `public/common.js` (AI connection, Ask Drift, formatting).

## Anonymous, opt-in sharing

Before choosing an app, people answer: share an anonymous summary or not; age group; for 13–17, whether a parent agreed. Under-13s and example reports never share. After the report they answer "Did this feel accurate?" and only then is a fixed summary sent (`POST /api/contribute`): drift type, score, weekly totals, topic shares, late-night share, accuracy, age group — no titles, names or timestamps. A delete token is kept in their browser for "Remove my summary". Totals: `GET /api/results`.

Storage: set `DATABASE_URL` (Postgres, e.g. a free Neon database) for durable storage. Without it, summaries go to a temporary file that resets on every Render deploy/restart.

## Quick start

```bash
npm install
npm start          # → http://localhost:3000
```

Open the site and click **"Try with sample data"** to see a full report in seconds — no history or
API key needed. To analyse your own data, drag the **"Grab my history"** bookmarklet to your
bookmarks bar, click it on `youtube.com/feed/history`, and drop the downloaded file in.

### Enable live AI analysis (optional)

Without an API key, Drift runs a deterministic **demo engine** so everything works end-to-end.
For live analysis with Claude:

```bash
cp .env.example .env      # then paste your ANTHROPIC_API_KEY
npm start
```

The badge in the top-right shows whether you're in `live` or `demo` mode.

## How the pieces map to the PRD (§4)

| PRD step | Where it lives | Notes |
|---|---|---|
| 1. File stays in browser | `public/app.js` | parsed locally, never uploaded |
| 2. Cleaning | `public/app.js` (`scrubTitle`) | handles/channels stripped before anything is sent |
| 3. AI labels each item | `agent.js` (`labelItems`) → `POST /api/label` | **only cleaned titles** are sent |
| 4. Plain math decides drift type | `public/drift.js` (`computeDrift`) | fixed, published thresholds — runs **in your browser** |
| 5. AI writes report + 2nd AI tone-checks | `agent.js` (`writeReport` → `toneCheck`) → `POST /api/report` | fails twice → pre-written fallback |

The **"what we send" preview** (PRD §7) pops up before any titles leave your browser.

## The AI agent (`agent.js`)

Three deliberately separate roles:

- **Labeler** — tags each title with a topic (closed, published vocabulary) + emotional intensity `0–1`.
- **Report writer** — turns the browser-computed drift result into calm prose.
- **Tone checker** — a *second* pass that rejects scare-words, causal claims, comparisons, and diagnosis.

The AI **reads and writes**; it never **judges** your drift type. That judgment is fixed math
(`public/drift.js`) so the same file always gives the same answer and anyone can audit it.

## Drift rules (`public/drift.js`)

Published thresholds (v3.1), late weeks vs your own early weeks:

- **Narrowing** — distinct topics shrink **> 15%**
- **Escalation** — average emotional intensity rises **> 10%**
- **Engagement drift** — videos get **> 20% shorter** *and* sessions get **> 25% more frequent**

Not enough data → `insufficient` (it refuses to classify). No clear signal → `Mixed / unclear`. Honest by design.

## Scripts

```bash
npm start                    # run the site + agent
npm test                     # deterministic drift-rule checks against the sample
node scripts/gen-sample.js   # regenerate public/sample-data.json
```

## Privacy

Your raw file, channel names, handles, and every timestamp stay in your browser. Only cleaned titles
reach the AI (to be labelled, then deleted). Your habit patterns are computed entirely client-side and
never sent. All code — including the bookmarklet's full script — is right here to read.

## Hosting

- **Website:** GitHub Pages, served from the `gh-pages` branch (a copy of `public/`) → https://aadvay537.github.io/Drift/ — loads instantly, never sleeps.
- **AI server:** Render (`server.js`) → https://drift-aatp.onrender.com. The page wakes it on arrival; if it's slow, a backup engine in the browser finishes the report. A GitHub Action pings it every 10 minutes to keep it awake.
- To publish website changes: `npm run deploy:pages` (pushes `public/` to `gh-pages`). Server changes still need a Render deploy.

## Weekly site check

`scripts/site-check.mjs` tests the site in a headless browser (every page with no console errors on desktop and phone, the sample report, the consent questions, and a free-form Ask Drift question):

```bash
SITE=http://localhost:3000/ node scripts/site-check.mjs           # local
SITE=https://aadvay537.github.io/Drift/ node scripts/site-check.mjs
```

The **Weekly site check** GitHub Action runs it against the live site every Monday (or by hand from the Actions tab) and also prints `/api/health` and `/api/results` — including `accuracyByPlatform` and `accuracyByType` — in its log.
