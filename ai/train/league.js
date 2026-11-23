// League evaluation: candidate vs champion on fixed seeds, compared with champion vs champion on the same seeds.
import { fitness, ES_DEFAULTS } from './es.js';

export async function evaluate({ map, candidate, champion, games = 4, seedBase = 900_000, opts = {}, shouldPause, onGame = () => {} }) {
  opts = { ...ES_DEFAULTS, ...opts };
  let cand = 0, base = 0;
  for (let i = 0; i < games; i++) {
    const seed = seedBase + i * 2;
    cand += (await fitness({ map, brain: candidate, opponent: champion, seed, opts, shouldPause })).total;
    base += (await fitness({ map, brain: champion, opponent: champion, seed, opts, shouldPause })).total;
    onGame(4);
  }
  const advantage = (cand - base) / games; // > 0 => candidate beats the champion
  return { advantage, candidate: cand / games, baseline: base / games };
}

export function nextLeagueRating(championRating, advantage) {
  return Math.round(championRating + Math.max(-200, Math.min(200, advantage * 400)));
}
