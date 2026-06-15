// Achievement registry + pure evaluators. main.js tallies the human's match
// stats into a `summary` object during play, then runs evaluate() at game end.
//
// Every achievement carries a `tier` (easy | medium | hard | rare). The set is
// balanced to roughly 30% easy / 40% medium / 25% hard / 5% rare so there's
// always something within reach and something to chase. Current mix (35 total):
//   easy 9 (26%) · medium 15 (43%) · hard 9 (26%) · rare 2 (6%).

export const ACHIEVEMENTS = [
  // ---- easy: most players trip these in their first games -------------------
  { id: "first_blood", tier: "easy", icon: "🥇", name: "First Win", desc: "Win your first game (finish first).", test: (s) => s.place === 1 },
  { id: "the_shithead", tier: "easy", icon: "💩", name: "The Sh!thead", desc: "Lose a game. It happens to everyone.", test: (s) => s.isShithead },
  { id: "reset_button", tier: "easy", icon: "♻️", name: "Reset Button", desc: "Play a 2 to reset the pile.", test: (s) => s.twos >= 1 },
  { id: "ten_outta_ten", tier: "easy", icon: "🔟", name: "Ten Outta Ten", desc: "Win a game where you played a 10.", test: (s) => s.place === 1 && s.tens >= 1 },
  { id: "spin_cycle", tier: "easy", icon: "🌀", name: "Spin Cycle", desc: "Play an 8 to shake up the table.", test: (s) => s.eights >= 1 },
  { id: "survivor", tier: "easy", icon: "🛟", name: "Survivor", desc: "Win a game even after picking up the pile.", test: (s) => s.place === 1 && s.pickups >= 1 },
  { id: "off_the_hook", tier: "easy", icon: "🎣", name: "Off the Hook", desc: "Finish a 3+ player game without being the Sh!thead.", test: (s) => !s.isShithead && s.total >= 3 },
  { id: "up_in_flames", tier: "easy", icon: "💥", name: "Up in Flames", desc: "Burn the pile for the first time.", test: (s) => s.burns >= 1 },
  { id: "heads_up", tier: "easy", icon: "🤜", name: "Heads Up", desc: "Win a 1-on-1 game.", test: (s) => s.place === 1 && s.total === 2 },

  // ---- medium: a bit of skill, the right cards, or a few games ---------------
  { id: "four_play", tier: "medium", icon: "🍀", name: "Four Play", desc: "Burn the pile with a four-of-a-kind.", test: (s) => s.fourKinds >= 1 },
  { id: "garbage_day", tier: "medium", icon: "🗑️", name: "Garbage Day", desc: "Pick up a pile of 8+ cards and still not be the Sh!thead.", test: (s) => s.maxPickup >= 8 && !s.isShithead },
  { id: "table_for_four", tier: "medium", icon: "🪑", name: "Table for Four", desc: "Win a 4-player game.", test: (s) => s.place === 1 && s.total === 4 },
  { id: "jokers_wild", tier: "medium", icon: "🃏", name: "Joker's Wild", desc: "Drop a joker on an opponent.", test: (s) => s.jokers >= 1 },
  { id: "hat_trick", tier: "medium", icon: "🎩", name: "Hat Trick", desc: "Lay three of a kind in a single move.", test: (s) => s.bigPlay >= 3 },
  { id: "dumpster_dive", tier: "medium", icon: "🚛", name: "Dumpster Dive", desc: "Scoop up a monster pile of 12+ cards at once.", test: (s) => s.maxPickup >= 12 },
  { id: "comeback_kid", tier: "medium", icon: "🚀", name: "Comeback Kid", desc: "Win after picking up a pile of 10+ cards.", test: (s) => s.place === 1 && s.maxPickup >= 10 },
  { id: "no_laughing", tier: "medium", icon: "🛡️", name: "No Laughing Matter", desc: "Deflect a joker with a 3.", test: (s) => s.deflects >= 1 },
  { id: "send_in_clowns", tier: "medium", icon: "🤡", name: "Send in the Clowns", desc: "Drop 2 jokers on opponents in a single game.", test: (s) => s.jokers >= 2 },
  { id: "trash_panda", tier: "medium", icon: "🦝", name: "Trash Panda", desc: "Pick up the pile 3+ times and still dodge the Sh!thead title.", test: (s) => s.pickups >= 3 && !s.isShithead },
  { id: "deflector_shield", tier: "medium", icon: "🪞", name: "Deflector Shield", desc: "Deflect 2+ jokers with a 3 in a single game.", test: (s) => s.deflects >= 2 },

  // ---- hard: real skill or a specific tough condition -----------------------
  { id: "clean_hands", tier: "hard", icon: "🧼", name: "Clean Hands", desc: "Win a game without ever picking up the pile.", test: (s) => s.place === 1 && s.pickups === 0 },
  { id: "pyromaniac", tier: "hard", icon: "🔥", name: "Pyromaniac", desc: "Burn the pile 3+ times in one game.", test: (s) => s.burns >= 3 },
  { id: "hard_mode", tier: "hard", icon: "😈", name: "No Mercy", desc: "Win a game against a Hard CPU.", test: (s) => s.place === 1 && s.difficulty === "hard" },
  { id: "quad_squad", tier: "hard", icon: "🧨", name: "Quad Squad", desc: "Lay four of a kind in a single move.", test: (s) => s.bigPlay >= 4 },

  // ---- rare: lucky and hard-won ---------------------------------------------
  { id: "flawless", tier: "rare", icon: "😤", name: "Flawless Victory", desc: "Beat a Hard CPU without ever picking up the pile.", test: (s) => s.place === 1 && s.difficulty === "hard" && s.pickups === 0 },
  { id: "slash_and_burn", tier: "rare", icon: "🌋", name: "Slash & Burn", desc: "Win a game in which you burned the pile 3+ times.", test: (s) => s.place === 1 && s.burns >= 3 },
];

// Lifetime "progress" achievements — fill a bar over many games. `value(prof)`
// reads the player's accumulated stats/progress (see profiles.accrueProgress).
export const PROGRESS_ACHIEVEMENTS = [
  { id: "veteran", tier: "medium", icon: "🎖️", name: "Veteran", desc: "Play 25 games.", target: 25, value: (p) => p.stats.games },
  { id: "hot_streak", tier: "medium", icon: "🌶️", name: "Hot Streak", desc: "Win 3 games in a row.", target: 3, value: (p) => p.stats.bestStreak },
  { id: "champion", tier: "hard", icon: "👑", name: "Champion", desc: "Win 10 games.", target: 10, value: (p) => p.stats.wins },
  { id: "arsonist", tier: "hard", icon: "🔥", name: "Arsonist", desc: "Burn the pile 50 times.", target: 50, value: (p) => p.progress.burns },
  { id: "court_jester", tier: "hard", icon: "🃏", name: "Court Jester", desc: "Drop 15 jokers on opponents.", target: 15, value: (p) => p.progress.jokers },
  { id: "bin_man", tier: "medium", icon: "🚮", name: "Bin Man", desc: "Pick up the pile 25 times.", target: 25, value: (p) => p.progress.pickups },
  { id: "perfect_tens", tier: "medium", icon: "💯", name: "Perfect Tens", desc: "Play 25 tens.", target: 25, value: (p) => p.progress.tens },
  { id: "centurion", tier: "hard", icon: "🏛️", name: "Centurion", desc: "Play 100 games.", target: 100, value: (p) => p.stats.games },
  { id: "riposte", tier: "hard", icon: "🤺", name: "Riposte", desc: "Deflect 10 jokers with a 3.", target: 10, value: (p) => p.progress.deflects },
];

const BY_ID = new Map([...ACHIEVEMENTS, ...PROGRESS_ACHIEVEMENTS].map((a) => [a.id, a]));
export function achievementById(id) { return BY_ID.get(id); }

// Total achievements that exist (one-time + lifetime goals) — the denominator
// shown on the gold "Stats & achievements" bar and in the stats panel.
export function totalAchievementCount() {
  return ACHIEVEMENTS.length + PROGRESS_ACHIEVEMENTS.length;
}

// How many a profile has unlocked across both kinds. One-time ids are filtered
// against the live registry so a retired achievement never inflates the count.
export function countUnlocked(profile) {
  if (!profile) return 0;
  const oneTime = (profile.achievements || []).filter((id) => BY_ID.has(id)).length;
  const progress = evaluateProgress(profile).filter((x) => x.unlocked).length;
  return oneTime + progress;
}

// Per-profile progress snapshot: [{ def, value, target, unlocked }] clamped.
export function evaluateProgress(profile) {
  return PROGRESS_ACHIEVEMENTS.map((def) => {
    let value = 0;
    try { value = def.value(profile) || 0; } catch (_) { value = 0; }
    value = Math.max(0, Math.min(def.target, value));
    return { def, value, target: def.target, unlocked: value >= def.target };
  });
}

export function emptySummary() {
  return {
    place: null, isShithead: false, total: 2, difficulty: "normal", eightMode: "reverse",
    burns: 0, tens: 0, twos: 0, eights: 0, fourKinds: 0, jokers: 0, deflects: 0,
    pickups: 0, maxPickup: 0, bigPlay: 0, wonOnBlind: false,
  };
}

// Returns the ids the player earned this match.
export function evaluate(summary) {
  return ACHIEVEMENTS.filter((a) => { try { return a.test(summary); } catch (_) { return false; } }).map((a) => a.id);
}
