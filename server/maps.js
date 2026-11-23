import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GameMap } from '../shared/map.js';

const cache = new Map();

export function loadMap(id = 'manor') {
  if (!/^[a-z0-9_-]+$/.test(id)) throw new Error('bad map id');
  if (!cache.has(id)) {
    const file = fileURLToPath(new URL(`../maps/${id}.json`, import.meta.url));
    cache.set(id, new GameMap(JSON.parse(readFileSync(file, 'utf8'))));
  }
  return cache.get(id);
}
