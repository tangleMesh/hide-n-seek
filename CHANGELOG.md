# Changelog

## 0.2.0
- Live deployment: release workflow (image on ghcr.io for amd64 + arm64) and `deploy/` (compose stack, auto-updater, S3 backups) for the Mac mini next to castle-defense. See `docs/deploy.md`.
- `/api/health` reports `version` and `liveMatches`. The version is shown in the corner of the menus.
- Shutdown snapshots every running game first, so ranked games resume and custom games become saved games after an update.
- The training worker has a heap cap (`TRAINING_MAX_MB`) and restarts on its own if it dies.

## 0.1.1
- Closer camera, quieter footsteps, and sneaking now costs stamina.

## 0.1.0
- First version of HUSH.
