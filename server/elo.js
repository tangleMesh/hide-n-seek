// Pure rating functions.
export const START_RATING = 1000;

export function kFactor(games) {
  return games < 10 ? 40 : 24;
}

export function expected(self, opp) {
  return 1 / (1 + 10 ** ((opp - self) / 400));
}

/**
 * players: [{ id, rating, games, startRole, score }]  (ratings = snapshot taken at match start)
 * Returns { [id]: delta } (rounded integers).
 */
export function ratingChanges(players) {
  const avg = (role) => {
    const ps = players.filter((p) => p.startRole === role);
    return ps.length ? ps.reduce((a, p) => a + p.rating, 0) / ps.length : START_RATING;
  };
  const seekAvg = avg('seeker');
  const hideAvg = avg('hider');
  const out = {};
  for (const p of players) {
    const opp = p.startRole === 'seeker' ? hideAvg : seekAvg;
    out[p.id] = Math.round(kFactor(p.games) * (p.score - expected(p.rating, opp)));
  }
  return out;
}
