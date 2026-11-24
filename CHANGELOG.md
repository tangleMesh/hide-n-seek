# Changelog

## 0.1.2
- Pick your color and one of 16 hand-drawn faces (happy, grin, wink, cool, in love, silly, shocked, nervous, sleepy, meh, sad, angry, furious, evil, dizzy, smug). Faces show in game, lobby, leaderboard, online list and scoreboard.
- Colors are unique within every lobby and game. Whoever was there first keeps their color, later players with the same color get a free one (with a notice), and taken colors can't be picked in the lobby.

## 0.1.1
- Idle-time bot training only runs in production (`NODE_ENV=production`, set by the Docker image). `TRAINING=on|off` still overrides it, and the dev Docker stack keeps it off.

## 0.1.0
First release of HUSH, a Noise & Shadow hide'n'seek party game for 6–16 players.
- Real-time server-authoritative game: flashlight cones, noise ripples, heartbeats, Final Hush, fixed item pads (4 hider and 4 seeker items).
- Ranked queue with ELO and leaderboard, custom lobbies with invites, pause/save/resume.
- Disconnect grace with AI stand-in, crash snapshots and recovery.
- AI players with their own personalities, learning from human games and idle-time self-play. Owner-only `/admin` dashboard.
- Live deployment: release workflow (image on ghcr.io for amd64 + arm64) and `deploy/` (compose stack, auto-updater, S3 backups). See `docs/deploy.md`.
