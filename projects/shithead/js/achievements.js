// Achievement registry + pure evaluators. main.js tallies the human's match
// stats into a `summary` object during play, then runs evaluate() at game end.

export const ACHIEVEMENTS = [
  { id: "first_blood", icon: "🥇", name: "First Win", desc: "Win your first game (finish first).", test: (s) => s.place === 1 },
  { id: "clean_hands", icon: "🧼", name: "Clean Hands", desc: "Win without ever picking up the pile.", test: (s) => s.place === 1 && s.pickups === 0 },
  { id: "pyromaniac", icon: "🔥", name: "Pyromaniac", desc: "Burn the pile 3+ times in one game.", test: (s) => s.burns >= 3 },
  { id: "ten_outta_ten", icon: "🔟", name: "Ten Outta Ten", desc: "Win a game where you played a 10.", test: (s) => s.place === 1 && s.tens >= 1 },
  { id: "four_play", icon: "🍀", name: "Four Play", desc: "Burn with a four-of-a-kind.", test: (s) => s.fourKinds >= 1 },
  { id: "garbage_day", icon: "🗑️", name: "Garbage Day", desc: "Pick up a pile of 8+ cards and still not be the Sh!thead.", test: (s) => s.maxPickup >= 8 && !s.isShithead },
  { id: "blind_luck", icon: "🙈", name: "Blind Luck", desc: "Win by playing your last face-down card.", test: (s) => s.place === 1 && s.wonOnBlind },
  { id: "reset_button", icon: "♻️", name: "Reset Button", desc: "Play a 2 to reset the pile.", test: (s) => s.twos >= 1 },
  { id: "jokers_wild", icon: "🃏", name: "Joker's Wild", desc: "Drop a joker on an opponent.", test: (s) => s.jokers >= 1 },
  { id: "no_laughing", icon: "🛡️", name: "No Laughing Matter", desc: "Deflect a joker with a 3.", test: (s) => s.deflects >= 1 },
  { id: "the_shithead", icon: "💩", name: "The Sh!thead", desc: "Lose a game. It happens to everyone.", test: (s) => s.isShithead },
  { id: "hard_mode", icon: "😈", name: "No Mercy", desc: "Win a game against a Hard CPU.", test: (s) => s.place === 1 && s.difficulty === "hard" },
  { id: "table_for_four", icon: "🪑", name: "Table for Four", desc: "Win a 4-player game.", test: (s) => s.place === 1 && s.total === 4 },
];

// Lifetime "progress" achievements — fill a bar over many games. `value(prof)`
// reads the player's accumulated stats/progress (see profiles.accrueProgress).
export const PROGRESS_ACHIEVEMENTS = [
  { id: "veteran", icon: "🎖️", name: "Veteran", desc: "Play 25 games.", target: 25, value: (p) => p.stats.games },
  { id: "champion", icon: "👑", name: "Champion", desc: "Win 10 games.", target: 10, value: (p) => p.stats.wins },
  { id: "arsonist", icon: "🔥", name: "Arsonist", desc: "Burn the pile 50 times.", target: 50, value: (p) => p.progress.burns },
  { id: "court_jester", icon: "🃏", name: "Court Jester", desc: "Drop 15 jokers on opponents.", target: 15, value: (p) => p.progress.jokers },
  { id: "hot_streak", icon: "🌶️", name: "Hot Streak", desc: "Win 3 games in a row.", target: 3, value: (p) => p.stats.bestStreak },
];

const BY_ID = new Map([...ACHIEVEMENTS, ...PROGRESS_ACHIEVEMENTS].map((a) => [a.id, a]));
export function achievementById(id) { return BY_ID.get(id); }

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
    burns: 0, tens: 0, twos: 0, fourKinds: 0, jokers: 0, deflects: 0, pickups: 0, maxPickup: 0, wonOnBlind: false,
  };
}

// Returns the ids the player earned this match.
export function evaluate(summary) {
  return ACHIEVEMENTS.filter((a) => { try { return a.test(summary); } catch (_) { return false; } }).map((a) => a.id);
}
