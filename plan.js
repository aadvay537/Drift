// plan.js — "Make it better": after the report, people choose what they want,
// and get a personal 7-day plan, the exact app settings that help, a checklist
// that's saved on their device, and a reminder to check again in 2 weeks.

import { $, $$, esc, API, server, waitForServer, toast } from './common.js';
import { chatStats } from './chat.js';
import { topicName } from './insights.js';

const GOALS = [
  ['sleep', '🌙', 'Sleep better', 'Less scrolling late at night'],
  ['less_time', '⏱️', 'Spend less time', 'Use the app less overall'],
  ['less_topic', '🎯', 'See less of what\'s taking over', ''],
  ['variety', '🌈', 'More variety', 'Get back the topics I used to enjoy'],
  ['focus', '📚', 'Focus better', 'Fewer distractions while studying or working'],
  ['happy', '🙂', 'I\'m happy with my feed', 'Keep it that way'],
];

// Exact settings people can change today. Menu names can shift slightly between app versions.
export const SETTINGS = {
  youtube: {
    name: 'YouTube',
    steps: [
      ['Turn off Autoplay', 'While a video plays, tap the Autoplay switch at the top of the player so it shows off. Also: profile picture → Settings → Playback → turn off "Playback in feeds" to stop previews playing as you scroll.'],
      ['Tell it what you don\'t want', 'On any video in Home, tap ⋮ → "Not interested" or "Don\'t recommend channel". A few of these change your feed within days.'],
      ['Reset what it learned', 'Profile picture → Settings → Manage all history → pause "Saving your YouTube history", or delete recent history. Your Home feed starts fresh.'],
      ['Get a nudge to stop', 'Profile picture → Settings → General → "Remind me to take a break" and "Remind me when it\'s bedtime".'],
    ],
  },
  instagram: {
    name: 'Instagram',
    steps: [
      ['Reset your suggested content', 'Profile → ☰ menu → Settings and activity → Content preferences → Reset suggested content → follow the steps. Explore, Reels and suggested posts start fresh.'],
      ['Snooze suggested posts', 'Same Content preferences screen → turn on "Snooze suggested posts in feed" (hides them for 30 days).'],
      ['Mark "Not interested"', 'On a post or reel you don\'t want more of, tap ⋯ → Not interested.'],
      ['Set a daily limit and Quiet mode', 'Settings and activity → Time management → set a daily limit, and turn on Quiet mode for your sleep hours.'],
    ],
  },
  tiktok: {
    name: 'TikTok',
    steps: [
      ['Refresh your For You feed', 'Profile → ☰ menu → Settings and privacy → Content preferences → Refresh your For You feed → Continue → Refresh. It can\'t be undone, so it truly starts fresh.'],
      ['Filter out words', 'Same Content preferences screen → Filter keywords → add words for topics you want less of.'],
      ['Long-press → Not interested', 'On any video you don\'t want more of, press and hold → Not interested.'],
      ['Set a daily screen-time limit', 'Settings and privacy → Screen time → Daily screen time → choose a limit. Turn on "Sleep reminders" too.'],
    ],
  },
  reddit: {
    name: 'Reddit',
    steps: [
      ['Mute communities', 'On a post from a community you want less of, tap ⋯ → Mute r/community, or "Show fewer posts like this".'],
      ['Turn off recommendations', 'In Settings, look for the feed or content preferences and turn off recommendations in your home feed (where your app version offers it).'],
      ['Turn off autoplay', 'Settings → turn off "Autoplay" for videos and GIFs.'],
    ],
  },
};
const PHONE = [
  ['iPhone: limit an app', 'Settings → Screen Time → App Limits → Add Limit → choose the app and a daily time.'],
  ['iPhone: quiet at night', 'Settings → Screen Time → Downtime → choose your sleep hours, so only the apps you allow work.'],
  ['Android: limit an app', 'Settings → Digital Wellbeing & parental controls → Dashboard → tap the app → App timer.'],
  ['Android: quiet at night', 'Settings → Digital Wellbeing → Bedtime mode → set your sleep hours.'],
];

export function planTile() {
  return `<div class="tile wide plan-tile" id="planTile">
    <h4>Make it the feed you want</h4>
    <p class="sub">What would you like to change? Pick one and get a simple 7-day plan, made from your own results.</p>
    <div class="goals" id="goals"></div>
    <div id="planOut"></div>
  </div>`;
}

// p = { drift, stats, platform, hasTitles, key }
export function planFromAnalysis(a) {
  return { drift: a.drift, stats: chatStats(a), platform: a.file.platform || 'youtube', hasTitles: !!a.file.hasTitles, key: `${a.drift.startDate || 's'}.${a.drift.endDate || 'e'}` };
}

export function wirePlan(a) {
  const growing = (a.drift.topClusters || []).filter((t) => t !== 'other').map((t) => topicName(t).toLowerCase());
  $('#goals').innerHTML = GOALS.map(([id, icon, label, sub]) => {
    const s = id === 'less_topic' ? (growing.length ? `Less ${growing.slice(0, 2).join(' and ')}` : 'Less of the topic that\'s growing') : sub;
    if (id === 'less_topic' && !a.hasTitles) return '';
    return `<button class="goal" data-goal="${id}" type="button"><span class="g-icon" aria-hidden="true">${icon}</span><b>${esc(label)}</b>${s ? `<small>${esc(s)}</small>` : ''}</button>`;
  }).join('');
  $$('#goals .goal').forEach((b) => b.addEventListener('click', () => makePlan(a, b.dataset.goal, b)));
}

async function makePlan(a, goal, btn) {  // a = plan context
  $$('#goals .goal').forEach((x) => x.classList.toggle('picked', x === btn));
  const out = $('#planOut');
  out.innerHTML = '<p class="muted plan-wait"><span class="dots"><i></i><i></i><i></i></span> Making your plan…</p>';
  const platform = a.platform || 'youtube';
  let plan = null;
  if (server.up || await waitForServer(20000)) {
    try {
      const r = await fetch(API + '/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ drift: a.drift, stats: a.stats, goal, platform: SETTINGS[platform] ? platform : 'youtube' }) });
      if (r.ok) plan = (await r.json()).plan;
    } catch { /* fall back below */ }
  }
  if (!plan) plan = localPlan(a, goal);
  renderPlan(a, goal, plan, platform);
}

// Written on this device if the AI is unavailable. Still uses their numbers.
function localPlan(a, goal) {
  const s = a.stats || {};
  const lateHour = (() => { const h = s.hourShareRecent || []; let best = -1, v = 0; for (const i of [22, 23, 0, 1, 2, 3]) if ((h[i] || 0) > v) { v = h[i]; best = i; } return best; })();
  const lateTxt = lateHour >= 0 ? `${lateHour === 0 ? '12' : lateHour > 12 ? lateHour - 12 : lateHour}${lateHour >= 12 ? 'pm' : 'am'}` : 'late at night';
  const app = SETTINGS[a.platform]?.name || 'your most-used app';
  const growing = (a.drift.topClusters || []).filter((t) => t !== 'other').map((t) => topicName(t).toLowerCase())[0] || 'the topic that grew';
  // Instagram has no autoplay switch; use its daily limit / Quiet mode instead.
  const autoplay = a.platform === 'instagram'
    ? ['Set Instagram\'s daily limit', 'Settings and activity → Time management → Daily limit (see the settings below).', 'A gentle stop when the time is up.']
    : [`Turn off Autoplay in ${app}`, 'See the settings below for the exact steps.', 'Videos stop instead of rolling on.'];
  const plans = {
    sleep: [['Pick a phone-down time', `Choose a time 30 minutes before bed. Your busiest late hour recently was around ${lateTxt}.`, 'A set time is easier than willpower.'], ['Turn on a bedtime limit', 'Use Downtime (iPhone) or Bedtime mode (Android) for your sleep hours.', 'It adds a pause right when scrolling is easiest.'], ['Charge your phone away from bed', 'Put the charger across the room or outside the bedroom.', 'Out of reach usually means out of mind.'], autoplay, ['Swap the last scroll', 'Keep a book, music or a podcast for the last 20 minutes.', 'Gives your hands something else to do.'], ['Check how it went', 'Notice whether falling asleep felt easier this week.', 'Small wins add up.'], ['Keep what worked', 'Keep the one change that helped most.', 'One habit is enough to start.']],
    less_time: [['Set a daily limit', `Add an App Limit for ${app} (see the settings below).`, 'A gentle reminder when time is up.'], ['Move the app', 'Move it off your home screen into a folder.', 'One extra tap makes opening it a choice.'], autoplay, ['Turn off non-essential notifications', 'Keep only messages from people.', 'Fewer pings, fewer pickups.'], ['Have a reason to open it', 'Before opening the app, say why in your head.', 'Turns autopilot into a decision.'], ['One app-free hour', 'Pick one hour today with the phone in another room.', 'Shows how the time feels without it.'], ['Look back', 'Check Screen Time or Digital Wellbeing for the week.', 'See what changed.']],
    less_topic: [[`Mark ${growing} posts "Not interested"`, 'Do it on 5 posts or videos today.', 'This is the strongest signal you can send.'], ['Search for what you want instead', 'Search for and watch 2–3 things you actually enjoy.', 'Your feed learns from what you choose.'], ['Reset suggestions', 'Use the reset option for your app in the settings below.', 'Gives your feed a fresh start.'], ['Unfollow or mute 3 accounts', `Choose accounts that mostly post ${growing}.`, 'Removes the source.'], autoplay, ['Notice how you feel', 'After scrolling, notice your mood.', 'Helps you decide what to keep.'], ['Run Drift again later', 'Check again in 2 weeks.', 'See whether it moved.']],
    variety: [['Remember 3 old interests', 'Write down three things you used to enjoy watching.', 'A list makes searching easy.'], ['Search for one each day', 'Watch one video or post from your list.', 'Teaches your feed something new.'], ['Follow 3 new creators', 'Pick from your old interests.', 'More voices in your feed.'], ['Reset suggestions', 'Use the reset option in the settings below.', 'Clears the narrow pattern.'], ['Use "Not interested" on repeats', 'When you see the same kind of thing again, tap it.', 'Makes room for new things.'], ['Try a different format', 'One longer video or article instead of short clips.', 'A change of pace.'], ['Look back', 'Notice which new things you enjoyed.', 'Keep those.']],
    focus: [['Set focus hours', 'Pick study or work hours and use a Focus mode (iPhone) or Focus mode (Android).', 'Blocks distracting apps during that time.'], ['Phone out of sight', 'Keep it in a bag or another room while working.', 'Even seeing it pulls attention.'], ['25-minute blocks', 'Work 25 minutes, then a 5-minute break.', 'Easier than "study for hours".'], autoplay, ['Notifications off', 'Silence social apps during focus hours.', 'Fewer interruptions.'], ['Plan your breaks', 'Decide what you\'ll do in the break before it starts.', 'Stops breaks turning into an hour.'], ['Look back', 'Notice what you finished this week.', 'See the difference.']],
    happy: [['Keep it intentional', 'Before opening the app, have something in mind.', 'Keeps your feed yours.'], ['Use "Not interested" when needed', 'Tap it when something feels off.', 'Small nudges keep it healthy.'], ['Follow what you love', 'Follow 2 creators you really enjoy.', 'Good signals in.'], ['Check your settings', 'Glance at the settings below.', 'Know what\'s there.'], ['Take one break day', 'Try one day with less scrolling and notice how it feels.', 'A good reset.'], ['Share what you enjoy', 'Send something good to a friend.', 'Social media at its best.'], ['Run Drift again', 'Check again in a few weeks.', 'Make sure it stays this way.']],
  };
  const list = plans[goal] || plans.happy;
  return { intro: 'Here\'s a simple plan for the next 7 days. One small step a day — skip any that don\'t suit you.', days: list.map(([title, how, why], i) => ({ day: i + 1, title, how, why })), checkIn: 'In 2 weeks, run Drift again and see whether things moved the way you wanted.', source: 'local' };
}

function renderPlan(a, goal, plan, platform) {
  const key = `drift.plan.${a.key || 'x'}.${goal}`;
  const done = (() => { try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; } })();
  const app = SETTINGS[platform] || SETTINGS.youtube;
  const others = Object.entries(SETTINGS).filter(([k]) => k !== platform && k !== 'reddit');
  $('#planOut').innerHTML = `
    <div class="plan">
      <p class="plan-intro">${esc(plan.intro)}</p>
      <ol class="plan-days">
        ${plan.days.map((d) => `<li class="${done.includes(d.day) ? 'done' : ''}">
          <label><input type="checkbox" data-day="${d.day}" ${done.includes(d.day) ? 'checked' : ''}/><span class="pd-day">Day ${d.day}</span></label>
          <div><b>${esc(d.title)}</b><p>${esc(d.how)}</p>${d.why ? `<small>${esc(d.why)}</small>` : ''}</div>
        </li>`).join('')}
      </ol>
      <p class="plan-progress" id="planProgress"></p>
      <h5>Settings that help in ${esc(app.name)}</h5>
      <div class="settings-list">${app.steps.map(([t, d]) => `<details><summary>${esc(t)}</summary><p>${esc(d)}</p></details>`).join('')}</div>
      <details class="more-settings"><summary>Phone settings, and other apps</summary>
        <div class="settings-list">${PHONE.map(([t, d]) => `<details><summary>${esc(t)}</summary><p>${esc(d)}</p></details>`).join('')}
        ${others.map(([, o]) => o.steps.slice(0, 2).map(([t, d]) => `<details><summary>${esc(o.name)}: ${esc(t)}</summary><p>${esc(d)}</p></details>`).join('')).join('')}</div>
      </details>
      <p class="fine">Menu names can differ slightly between app versions. Ask Drift if you can't find something.</p>
      <div class="actions">
        <button class="btn btn-lantern" id="remindBtn" type="button">Remind me to check again in 2 weeks</button>
        <button class="btn btn-quiet" id="askPlan" type="button">Ask Drift about this plan</button>
      </div>
      ${plan.checkIn ? `<p class="fine">${esc(plan.checkIn)}</p>` : ''}
    </div>`;
  const progress = () => { const n = $$('#planOut [data-day]:checked').length; $('#planProgress').textContent = n ? `${n} of ${plan.days.length} done — nice.` : ''; };
  $$('#planOut [data-day]').forEach((c) => c.addEventListener('change', () => {
    const ids = $$('#planOut [data-day]:checked').map((x) => +x.dataset.day);
    try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* ignore */ }
    c.closest('li').classList.toggle('done', c.checked);
    progress();
  }));
  progress();
  $('#remindBtn').addEventListener('click', () => { downloadReminder(); toast('Reminder file downloaded — open it to add it to your calendar.'); });
  $('#askPlan').addEventListener('click', () => {
    const box = $('#reportAsk');
    box?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const input = box?.querySelector('[data-input]');
    if (input) { input.value = 'About my 7-day plan: '; input.focus(); }
  });
  $('#planOut').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// A calendar file (.ics) that works with Apple, Google and Outlook calendars.
function downloadReminder() {
  const d = new Date(Date.now() + 14 * 86400000);
  d.setHours(18, 0, 0, 0);
  const fmt = (x) => x.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const end = new Date(d.getTime() + 15 * 60000);
  const url = location.origin + location.pathname.replace(/[^/]*$/, '') + 'start.html';
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Drift//Reminder//EN', 'BEGIN:VEVENT',
    `UID:drift-${Date.now()}@drift`, `DTSTAMP:${fmt(new Date())}`, `DTSTART:${fmt(d)}`, `DTEND:${fmt(end)}`,
    'SUMMARY:Check my feed again with Drift', `DESCRIPTION:Run Drift again to see how your feed changed since your plan. ${url}`, `URL:${url}`,
    'BEGIN:VALARM', 'TRIGGER:-PT0M', 'ACTION:DISPLAY', 'DESCRIPTION:Check my feed with Drift', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = 'drift-reminder.ics';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
