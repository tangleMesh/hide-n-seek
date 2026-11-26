// Pure rating functions.
export const START_RATING = 1000;
// share of a survivor's gain for the last caught hiders (caught last, second to last)
export const LATE_SHARE = [0.25, 0.15];

export function kFactor(games) {
  return games < 10 ? 40 : 24;
}

export function expected(self, opp) {
  return 1 / (1 + 10 ** ((opp - self) / 400));
}

/**
 * players: [{ id, rating, games, startRole, score, caught?, lateRank? }]  (ratings = snapshot taken at match start)
 * Caught hiders: a lateRank (1 = caught last, 2 = second to last, only within the last minutes) earns a small plus
 * (a share of what surviving would have given). Every other caught hider loses at least 1 point: less the longer
 * they survived, never a plus.
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
    const k = kFactor(p.games);
    const exp = expected(p.rating, opp);
    let d = Math.round(k * (p.score - exp));
    if (p.caught) {
      d = p.lateRank ? Math.max(1, Math.round(k * (1 - exp) * LATE_SHARE[p.lateRank - 1])) : Math.min(-1, d);
    }
    out[p.id] = d;
  }
  return out;
}
