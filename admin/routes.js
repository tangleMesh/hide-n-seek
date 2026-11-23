// Owner-only admin endpoints. Anyone not listed in ADMIN_USERS gets a plain 404 (route appears not to exist).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { userFromToken, tokenFromRequest } from '../server/auth.js';

const PAGE = fileURLToPath(new URL('./page.html', import.meta.url));

export function adminNames() {
  return new Set((process.env.ADMIN_USERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

async function isAdmin(req, repos) {
  const user = await userFromToken(repos, tokenFromRequest(req));
  return !!user && user.kind === 'human' && adminNames().has(user.nameLower);
}

export async function handleAdmin(req, res, { repos, scheduler, personas }) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/admin' && url.pathname !== '/api/admin/stats') return false;
  if (!(await isAdmin(req, repos))) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return true;
  }
  if (url.pathname === '/admin') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(readFileSync(PAGE));
    return true;
  }
  const stats = await collectStats({ repos, scheduler, personas });
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(stats));
  return true;
}

export async function collectStats({ repos, scheduler, personas }) {
  const [gens, imit, league, models, sampleCount, personaUsers, humanCount, ranked] = await Promise.all([
    repos.training.recent('generation', 300),
    repos.training.recent('imitation', 100),
    repos.training.recent('league', 100),
    repos.botModels.all(),
    repos.samples.count(),
    repos.users.all({ kind: 'persona' }),
    repos.users.count({ kind: 'human' }),
    repos.matches.recent(1000, { ranked: true }),
  ]);
  const hist = {};
  for (const u of personaUsers) {
    const b = Math.floor(u.rating / 100) * 100;
    hist[b] = (hist[b] || 0) + 1;
  }
  // human-vs-persona win rates per rating band (only real, non-synthetic matches that included personas)
  const bands = {};
  let filled = 0, realRanked = 0;
  for (const m of ranked) {
    if (m.synthetic) continue;
    realRanked++;
    if (m.filled) filled++;
    if (!m.personaIds?.length) continue;
    const pset = new Set(m.personaIds);
    for (const p of m.players) {
      const side = pset.has(p.userId) ? 'persona' : 'human';
      const band = Math.floor((p.ratingBefore ?? 1000) / 200) * 200;
      bands[band] ??= { human: { games: 0, wins: 0 }, persona: { games: 0, wins: 0 } };
      bands[band][side].games++;
      if (p.win) bands[band][side].wins++;
    }
  }
  return {
    now: Date.now(),
    training: scheduler ? scheduler.status() : { state: 'disabled' },
    generations: gens.reverse().map((g) => ({ gen: g.gen, at: g.at, mean: g.fitnessMean, max: g.fitnessMax, min: g.fitnessMin, ms: g.ms })),
    imitation: imit.reverse().map((g) => ({ gen: g.gen, at: g.at, loss: g.loss, n: g.n })),
    league: models.map((m) => ({ version: m.version, leagueRating: m.leagueRating, champion: !!m.champion, source: m.source, createdAt: m.createdAt })),
    promotions: league.filter((l) => l.promoted).length,
    samples: sampleCount,
    personas: { count: personaUsers.length, online: personas.onlineList().length, ratingHistogram: hist, fills: personas.stats },
    humans: humanCount,
    matches: { ranked: realRanked, filledWithPersonas: filled },
    winRatesByBand: bands,
  };
}
