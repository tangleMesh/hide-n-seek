# HUSH: hide in the dark, every step makes noise

A browser hide'n'seek party game for **6–16 players**. It uses a Node.js + WebSocket backend, a Canvas 2D client and MongoDB.

> Seekers can only see what their flashlight shows. Hiders are invisible in the dark, but every move makes noise, and noise shows up for the seekers.

## Quick start

```bash
npm install
docker compose up -d mongo                 # MongoDB 8 on :27017
ADMIN_USERS=yourname npm start             # http://localhost:3000
```

If you don't have MongoDB, `npm run dev` uses the in-memory driver (set `MEMORY_FILE=dev.memory.json` to keep data between restarts).

Open the page in a few browser tabs, or click **Play ranked**. If not enough people are online, the matchmaker fills the match.

## Rules

| | |
|---|---|
| **Setup** | 1 starting seeker (2 with 12 or more players). Hiders get a 30 s head start while seekers are blind. |
| **Round** | 5:00. Caught hiders become seekers ("Shades"). Seekers win if everyone is caught. Hiders win if anyone survives. |
| **Movement** | `WASD` move · `Shift` sneak (55 % speed, silent on quiet floors) · `Space` sprint (150 %, loud). Both use **stamina**: sprint drains it fast, sneaking slowly (~10 s of continuous sneaking). Walking and standing regenerate it, so nobody can creep forever. |
| **Noise** | Steps create **ripples** that only the other side sees. Gravel and water are loud, carpet and grass quiet, doors creak, bushes rustle. |
| **Vision** | Seekers: 70° flashlight cone. Hiders: small circle of vision. Walls, bushes and smoke block sight. **Lamps** expose anyone standing in them. |
| **Heartbeat** | If you stand within 2 tiles of the same spot for 20 s, your heartbeat pulses every 5 s. During the last 60 s (**Final Hush**), every hider pulses every 10 s. |
| **Items** | Fixed pads with fixed, visible respawn timers, so there's no luck involved. `E` or click to use. |
| **Seekers' team** | Right-click places a marker that only seekers can see. |

**Hider items:** 👣 Decoy (fake ripples) · 💨 Smoke (blocks flashlights) · 🥿 Soft shoes (silent sprint) · 💤 Calm (hides your heartbeat)
**Seeker items:** 🔥 Flare (lights an area) · 🪤 Noise trap (hidden mine) · 🔦 Wide beam (140° cone) · 📡 Echo (reveals nearby heartbeats)

**Your look:** click *Edit look* (home) or *Change look* (lobby) to pick a color and one of 16 hand-drawn faces. Colors are unique in every game. If someone in the lobby already has your color, you get a free one for that game (the earlier player keeps theirs) and the lobby tells you. Taken colors can't be picked there.

Picking up an item shows what it does (press `I` in game to see it again). The **Guide** button on the start page and in the game menu explains every item.

Quick-chat: keys `1`–`8` in game, or the buttons in the lobby. `Tab` shows the scoreboard, `I` the item info. `Esc` opens the menu (leave, or pause in custom games).

## Ranked & ELO

- Everyone starts at 1000. K = 40 for the first 10 games, 24 after that. Your opponent strength is the average rating of the side you started against.
- Starting seekers score the share of hiders caught. Hiders who survive score 1.
- **Caught hiders lose points, less the longer they survived.** Catches as a Shade soften the loss, but it is always at least −1.
- **The last 2 hiders caught get a small plus** (25 % and 15 % of what surviving would give, e.g. +3 / +2 at equal ratings), but only if they were caught in the **last 2 minutes** of the round. Caught earlier, they lose points like everyone else.
- **Groups:** up to 4 players can queue for ranked together from a lobby (*🏆 Ranked as group*). A group is matched at a rating between its average and its best player, always plays in the same match, and solo players start as seekers before group members.
- Leaving a ranked match gives you the worst score for it. After 3 leaves in 24 h you get a 10-minute queue cooldown.

## Connection & persistence

- **Disconnects:** you have a 60 s grace window, and the AI holds your avatar until you return. The client reconnects automatically.
- **Crash safety:** every game is snapshotted every 2 s and on key events. After a restart:
  - ranked games resume if the snapshot is less than 2 min old, otherwise they're voided
  - custom games turn into saved games
- **Save & resume (custom only):** the host pauses, and a majority vote saves the game. It can be resumed later from *Saved games*, but only once all original human players are back (the host can choose AI stand-ins for missing players). Ranked games can't be paused.
- **Invites:** share the room code or `/?join=CODE` link, or invite online players by name.

## AI players ("personas")

To keep lobbies full at every rating, the server runs **personas**. These are AI-driven player accounts with their own names, personalities (tactic, aggression, patience, tilt, chattiness), ratings, history and leaderboard spots. Clients receive exactly the same data for personas as for humans.

- **Fairness:** bots get the same filtered view a human client gets (`server/observe.js`), so they never see through walls.
- **Brain:** a heuristic prior plus a small learned residual MLP, trained by
  1. **imitation** of human players (samples recorded at 2 Hz in real games)
  2. **evolution strategies** in headless self-play
  3. a **league** of checkpoints with internal ratings, mapped to persona ratings (lower-rated personas get earlier brains, more mistakes and slower reactions)
- **Idle training (production only):** when no human game is running, a worker thread plays learning games one after another. It pauses within one tick as soon as people play.
- **Admin dashboard:** `/admin` (also `/api/admin/stats`), only for accounts listed in `ADMIN_USERS`. Everyone else gets a 404. It shows training progress, fitness, league ratings, imitation loss, idle-time use, persona population and win rates per rating band.
- **Manual training:** `npm run train -- --generations 10 --games 3`

## Deployment

Releases deploy themselves. Publishing a GitHub release builds `ghcr.io/tanglemesh/hide-n-seek:<tag>`, and the Mac mini's updater installs it once no game is running. It runs as its own compose stack on port 8081, next to castle-defense. Setup, tunnel, backups and rollback are in **[docs/deploy.md](docs/deploy.md)**.

## Architecture

```
shared/        constants, map model (collision, LOS, visibility polygons), movement physics; used by server, bots and client
server/
  game.js      pure deterministic simulation (serializable state → snapshots, save/resume)
  observe.js   per-player filtered view (anti wall-hack; also the bots' only input)
  session.js   real-time loop, reconnect grace + AI takeover, snapshots, pause/save, ELO
  hub.js       presence, message routing, crash recovery
  lobby.js     custom lobbies, invites, host migration, "find players"
  matchmaker.js ranked queue with widening rating window + persona fill
  data/        repository layer over a swappable DocumentStore (mongo/ or memory/)
ai/            features, brain, bot controller, personas, training (ES, imitation, league), idle scheduler
admin/         owner-only stats dashboard
client/        vanilla ES modules + Canvas 2D (fog of war, prediction/reconciliation, WebAudio cues)
maps/          tile maps (generated by scripts/buildMap.js)
```

### Replacing the database

Game code only uses the repositories in `server/data/index.js`. These sit on a small **DocumentStore** contract: `collection(name)` with `insertOne/insertMany/findOne/find/count/updateOne/updateMany/bulkUpdate/deleteOne/deleteMany/ensureIndex`, using a Mongo-style filter/update subset (see `server/data/memory/query.js`).

To add another document database, implement that contract in `server/data/<driver>/store.js` and register it in `createStore()`. The repository contract tests in `test/data.test.js` run against every adapter.

## Configuration

| Env | Default | |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | |
| `DB_DRIVER` | `mongo` | `mongo` or `memory` |
| `MONGO_URL` / `MONGO_DB` | `mongodb://127.0.0.1:27017` / `hush` | |
| `MEMORY_FILE` | – | JSON persistence for the memory driver |
| `ADMIN_USERS` | – | comma-separated account names allowed to see `/admin` |
| `TRAINING` | on in production (`NODE_ENV=production`, set by the Docker image), off otherwise | `on` / `off` forces idle-time training on or off |
| `MIN_PERSONAS` | `24` | starting persona population |
| `TRAINING_MAX_MB` | – | heap cap for the training worker (it restarts on its own) |
| `RECORD_SAMPLES` | on | `off` stops recording imitation samples from human games |
| `ROUND_SECONDS`, `HEADSTART_SECONDS`, `MM_FILL_AFTER=lo,hi` | – | testing overrides |

## Tests

```bash
npm test                 # unit tests (repository contract runs on memory + MongoDB if reachable)
npm run simulate         # end-to-end: ranked + persona fill, disconnect/reconnect, crash/restart recovery,
                         # custom save/resume, no persona markers in client traffic
DB_DRIVER=memory npm run simulate
```
