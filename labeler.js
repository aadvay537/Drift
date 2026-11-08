// labeler.js — Drift's deterministic keyword labeler.
// Shared by the server (demo mode + AI fallback) and the browser (backup engine
// when the AI server is still waking up). Same title → same label, always.

// Deterministic keyword labeler — used in mock mode and as the live fallback.
// Same title always yields the same label (PRD §9: "same file, same result").
const TOPIC_KEYWORDS = {
  news_politics: ['news', 'election', 'president', 'senate', 'policy', 'war', 'protest', 'government', 'political', 'breaking'],
  commentary_drama: ['exposed', 'drama', 'reacts', 'response', 'cancelled', 'beef', 'called out', 'the truth about', 'destroyed', 'owns'],
  true_crime: ['murder', 'killer', 'case', 'crime', 'disappearance', 'detective', 'unsolved', 'serial'],
  gaming: ['gameplay', 'speedrun', 'minecraft', 'fortnite', 'boss', 'playthrough', 'gaming', 'noob', 'ranked'],
  music: ['official video', 'lyrics', 'live performance', 'album', 'song', 'remix', 'cover', 'ft.', 'audio'],
  cooking_food: ['recipe', 'cooking', 'bake', 'kitchen', 'meal', 'dinner', 'easy', 'homemade', 'chef'],
  science_tech: ['review', 'iphone', 'unboxing', 'ai', 'coding', 'explained', 'how it works', 'physics', 'space', 'tech'],
  education_study: ['study', 'lecture', 'tutorial', 'learn', 'course', 'math', 'history of', 'how to learn', 'exam'],
  fitness_health: ['workout', 'gym', 'fitness', 'diet', 'abs', 'run', 'yoga', 'health', 'weight'],
  comedy_entertainment: ['funny', 'comedy', 'sketch', 'meme', 'prank', 'try not to laugh', 'stand up'],
  sports: ['highlights', 'match', 'goal', 'nba', 'football', 'soccer', 'game recap', 'tournament'],
  diy_crafts: ['diy', 'craft', 'build', 'woodworking', 'restoration', 'how i made'],
  finance_money: ['stocks', 'crypto', 'invest', 'money', 'passive income', 'millionaire', 'side hustle', 'trading'],
  lifestyle_vlog: ['vlog', 'day in my life', 'morning routine', 'grwm', 'haul', 'apartment tour'],
};
const HIGH_INTENSITY = ['shocking', 'insane', 'destroyed', 'exposed', 'you won\'t believe', 'gone wrong', 'crisis', 'outrage', 'ragebait', 'terrifying', 'worst', 'never again', 'the truth', 'lies', 'cancelled', 'war', 'attack', 'meltdown', 'brutal', 'furious', 'panic', 'emergency'];
const LOW_INTENSITY = ['relaxing', 'calm', 'tutorial', 'explained', 'how to', 'guide', 'lofi', 'asmr', 'study', 'recipe', 'review'];

export function keywordLabel(it) {
  const t = (it.title || '').toLowerCase();
  let topic = 'other';
  let best = 0;
  for (const [tp, kws] of Object.entries(TOPIC_KEYWORDS)) {
    const hits = kws.reduce((n, k) => n + (t.includes(k) ? 1 : 0), 0);
    if (hits > best) { best = hits; topic = tp; }
  }
  // Base intensity by topic, nudged by charged words in the title.
  const base = {
    news_politics: 0.55, commentary_drama: 0.7, true_crime: 0.65, finance_money: 0.5,
    gaming: 0.4, sports: 0.45, comedy_entertainment: 0.35, music: 0.3,
    science_tech: 0.3, cooking_food: 0.2, education_study: 0.2, fitness_health: 0.35,
    diy_crafts: 0.25, lifestyle_vlog: 0.3, other: 0.35,
  }[topic];
  let intensity = base;
  for (const w of HIGH_INTENSITY) if (t.includes(w)) intensity += 0.12;
  for (const w of LOW_INTENSITY) if (t.includes(w)) intensity -= 0.1;
  return { id: it.id, topic, intensity: clamp01(intensity) };
}

function clamp01(x) { return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0.35; }
