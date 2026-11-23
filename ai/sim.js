// Headless, faster-than-realtime games between bots (training, league evaluation, tests).
import { Game } from '../server/game.js';
import { observe } from '../server/observe.js';
import { BotController } from './botController.js';

/**
 * players: [{ id, brain, traits?, seed? }], seekerIds: [id]
 * shouldPause: optional () => boolean checked between ticks (cooperative pause for idle training)
 */
export async function runHeadlessGame({ map, players, seekerIds, roundSeconds = 150, headstart = 10, shouldPause, maxTicks }) {
  const game = new Game(map, { id: 'sim', playerIds: players.map((p) => p.id), seekerIds, roundSeconds, headstart });
  const bots = new Map(players.map((p, i) => [p.id, new BotController(map, p.id, p.brain, { traits: p.traits, seed: p.seed ?? i + 1 })]));
  let ticks = 0;
  const limit = maxTicks ?? Math.ceil((roundSeconds + headstart + 1) * 20);
  while (game.state.phase !== 'ended' && ticks < limit) {
    if (shouldPause) while (shouldPause()) await new Promise((r) => setTimeout(r, 50));
    for (const [id, bot] of bots) {
      const { input, actions } = bot.act(observe(game, id));
      game.setInput(id, input);
      for (const a of actions) game.queueAction(id, a);
    }
    game.step();
    ticks++;
    if (ticks % 200 === 0) await new Promise((r) => setImmediate(r));
  }
  return { scores: game.scores(), winner: game.state.winner, game, ticks };
}
