# Drift — Simple PRD (v3.1)

**What we're building:** A website where you grab your own YouTube or Reddit history with one click of a bookmarklet and, in about two minutes, see what kind of algorithmic influence you've been under — and how it changed you.

**Status:** Draft v3.1 · July 2026 · Change from v3: bookmarklet replaces Google Takeout as the main way to get your data (Takeout was too slow — exports can take hours or days).

---

## 1. The problem

Recommendation algorithms slowly change what you watch. It happens too gradually to notice. Screen-time apps tell you *how long* you were online — nothing about *how your content changed* or what that did to your habits.

## 2. The idea

Drift is a mirror, not a filter. It never blocks anything or tells you what to watch. It shows you three things:

1. **Your drift type.** Did your content narrow to fewer topics? Get more emotionally intense? Shift to shorter, faster videos?
2. **What changed alongside it.** Late-night watching, binge sessions, shorter attention to each video.
3. **One thing to try.** A single, optional suggestion. Never a lecture.

## 3. Getting your data: Takeout first, bookmarklet second

**Recommended path — Google Takeout (no scrolling).** A history-only Takeout export arrives in minutes, not hours: takeout.google.com → Deselect all → tick YouTube → keep only "history" → set format to JSON → export. Google emails a small zip; the `watch-history.json` inside drops straight into Drift. It carries the user's complete history with exact timestamps — the highest-quality timeline we can get. (Takeout has no video durations, so Engagement drift can't fire from it; Narrowing and Escalation work at full strength.)

**Alternative — the bookmarklet.** A bookmarklet is a bookmark that runs a tiny script instead of opening a page. Setup is one drag, use is one click:

1. On the Drift site, drag the **"Grab my history"** button to your bookmarks bar. (Mobile: copy-paste it into a bookmark — we show a 15-second how-to.)
2. Open your own YouTube history page (youtube.com/feed/history), click the bookmarklet, and scroll gently — its live counter shows items *and days* collected. 15+ videos across 10+ days is enough; a few weeks is sharper.
3. It reads the page you're looking at and downloads one small file: video titles, channels, durations, and dates. Nothing else. It cannot see your password, other tabs, or anything beyond the page on your screen. (Because it captures durations, this is the only path that can detect Engagement drift.)
4. Drop that file into Drift. Analysis starts immediately.

Same flow for Reddit (your profile's history page). Total time from landing on the site to seeing your report: **2–3 minutes.**

**Hard-won lesson (v3.1):** YouTube's on-page date headers are year-less ("Jul 10") or weekday names ("Saturday"); JavaScript parses "Jul 10" as the year 2001. Naive parsing either poisons the timeline or collapses every video to "today" — which made even 120-video grabs report "not enough data". The bookmarklet now anchors year-less dates to the current year, and the site rescues any decent-sized file whose dates look corrupted (spread in order over recent weeks, flagged "dates estimated") instead of refusing it.

**Other alternatives we considered:**
- *Browser extension* — needs installation, store approval, and constant maintenance. Cut entirely for v0.
- *Copy-paste the page* — kept as a fallback if the bookmarklet fails, but paste loses video durations and is messy across browsers.

**Also on day one:** a "Try with sample data" button, so anyone (including a judge at a fair) can see a full report in ten seconds without touching their own history.

## 4. How it works (the whole pipeline in five steps)

1. **Your file stays in your browser.** The bookmarklet's file is parsed locally on the Drift page. It is never uploaded to our server.
2. **We clean it.** Names, handles, and channel names are removed or replaced with codes before anything leaves your device.
3. **An AI labels each item.** Cleaned titles go to an AI service (which deletes them immediately after processing). It tags each video's topic and how emotionally charged it is.
4. **Plain math decides your drift type.** Not the AI. Fixed rules, running in your browser: topics shrinking >15% week over week = Narrowing. Emotional intensity rising >10% = Escalation. Videos getting 20% shorter while sessions get 25% more frequent = Engagement drift. (The bookmarklet captures durations from the page, so this third type works properly.)
5. **The AI writes your report — and a second AI checks its tone.** No scare words, no "this caused that" claims, no comparing you to others. If the check fails twice, you get a plain pre-written version instead.

Why split it this way? The AI is good at *reading* content but shouldn't *judge* you. The judgment comes from fixed, published rules — so the same data always gives the same answer, and anyone can audit how it works.

## 5. What the user sees

**One report, one screen, under 90 seconds to read:**

- **Your drift type** — e.g. "Emotional Escalation: your content became 34% more emotionally intense over 3 weeks, starting around April 12."
- **What's driving it** — the 2–3 topic clusters behind the shift.
- **What changed with it** — up to 3 habit changes, compared only to *your own* earlier weeks. Ends with a question, not a verdict: *"Is this how you want your week to look?"*
- **One thing to try** — matched to your drift type. Example for Escalation: "Try one day without news or political content. See if your focus changes."

## 6. What Drift will never do

- Block, filter, or recommend content
- Diagnose you or claim your habits were *caused* by the algorithm (we show patterns, not proof)
- Send your raw file, your name, or your habits data anywhere
- Read anything beyond the history page you clicked it on
- Ask how you're feeling
- Report to parents unless *you* choose to share a summary
- Use scores, streaks, or guilt

## 7. Privacy in one paragraph

The bookmarklet runs only on the page you click it on and saves its file straight to your device — it talks to no server. That file never leaves your browser. Only cleaned-up video titles reach the AI service, under a contract that they're deleted immediately and never used for training. Your habit patterns (when and how long you watch) are computed entirely in your browser and never sent. Before anything is sent, you see exactly what will be sent. All code — including the bookmarklet's full script, short enough to read in one sitting — is public on GitHub.

## 8. Who it's for

- **Teens who suspect their feed changed them** and want proof, not a lecture. If it feels like a parental-control app, they'll close the tab — so it can't.
- **Study participants** (40–60 teens, with parental consent) for the research this product is built on. For the study's weekly check-ins, participants just click the bookmarklet again — refreshing their data takes one minute, which makes weekly re-analysis actually realistic.

## 9. How we'll know it works

| Question | Target |
|---|---|
| Can people get their data in? | 80% who start the bookmarklet setup finish it and upload a file |
| Do people finish their report? | 80% read to the end |
| Do they understand it? | In testing, 5 of 5 users can say their drift type and the suggestion in their own words |
| Do they trust it? | Fewer than 1 in 10 say the report made them *more* anxious |
| Do they come back? | 30% run a second analysis within a month |
| Is the analysis stable? | Same file, same result, every time |
| Does it stay cheap? | Under $0.15 of AI cost per analysis |

## 10. Plan (8 weeks)

| Weeks | What ships |
|---|---|
| 1 | Bookmarklet v1 for YouTube history: reads the page, downloads a clean file. Tested on Chrome, Firefox, Edge, and a school Chromebook |
| 2 | Drift site: drag-to-install page, file drop, in-browser parsing, the cleaning step, "what we send" preview. Demo mode with sample data |
| 3 | AI labeling of titles (topics + emotional intensity), with a fixed test set to prove it's consistent |
| 4 | The drift rules + confidence score ("not enough data" handled honestly) |
| 5 | Report writing + tone checker + fallback version |
| 6 | The report page itself; Reddit bookmarklet; paste-in fallback |
| 7 | Test with 5 users — including whether they can install and use the bookmarklet unaided; fix what confuses them |
| 8 | Publish the code; guided Takeout walkthrough as the optional "deep analysis" path; invite the first study participants |

## 11. Biggest risks, plainly

1. **YouTube changes its page layout and the bookmarklet breaks.** This will happen occasionally. The script is ~50 lines, so a fix takes an hour, and the site detects a bad file and tells the user "we've been notified, try the paste-in method meanwhile" instead of failing silently.
2. **Bookmarklets are unfamiliar** — some users (especially on mobile) may stall at "drag this to your bookmarks bar." That's why the setup has a 15-second demo video, why paste-in exists as a fallback, and why we measure setup completion (target: 80%). If it lands below that, paste-in gets promoted to the front.
3. **"You're sending my watch history to an AI company."** True for the cleaned titles. Our answer: show exactly what's sent, delete-on-processing contract, everything else stays in the browser, public code. If this still scares users, a reduced "nothing leaves your browser" mode detects the short-video drift type only.
4. **The three drift types might not show up cleanly in real data.** Fine — the product says "Mixed / unclear" honestly instead of forcing a label, and that's a research finding either way.
5. **The AI refuses to label edgy content** — exactly what escalation-drift users watch. We skip those items, say so in the report, and lower the confidence score.
6. **Scroll depth limits history.** The bookmarklet only sees what the user scrolled past — someone who scrolls 30 seconds gets 2 weeks of data. The site checks date coverage on upload and says "this covers 12 days — scroll further back and re-grab for a better analysis" when needed. (The rules already refuse to classify on thin data.)

## 12. Later, not now

Live tracking (the extension), the mobile app, real-time drift alerts, TikTok/Instagram support, school dashboards. The website must prove people *want the mirror* first.

---

**The one-sentence version:** One click grabs your own watch history, and in two minutes Drift shows you what the algorithm has been doing to you — using AI to read your content, plain published rules to classify it, and a tone-checked report that informs without judging.
