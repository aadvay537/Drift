# Drift 🪞

**A mirror, not a filter.** One click grabs your own YouTube/Reddit history, and in about two
minutes Drift shows you what kind of algorithmic influence you've been under — using an **AI agent**
to read your content, **plain published rules** to classify it, and a **tone-checked report** that
informs without judging.

This is a working implementation of the [Drift PRD v3.1](./Drift-PRD-v3.1-simple.md).

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
