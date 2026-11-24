#!/usr/bin/env bash
# Live updater (the hush-update systemd timer runs it every few minutes).
# When a new GitHub release exists and its image is ready on ghcr.io, it:
#   1. moves the repository checkout to the release, so the deploy/ files match it
#   2. waits until no game with human players is running (at most UPDATE_MAX_WAIT_MIN minutes)
#   3. switches HUSH_VERSION in deploy/.env and restarts the server with the new image
# Running games are snapshotted on shutdown anyway: ranked games resume, custom games become saved
# games. Manual use:  deploy/update.sh [--force]
set -euo pipefail

# Everything lives in a function, because the script may check out a new version of itself while it runs.
main() {
  local dir repo env latest current image waited max live force=0
  [ "${1:-}" = "--force" ] && force=1
  dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  repo="$(dirname "$dir")"
  env="$dir/.env"
  [ -f "$env" ] || { echo "missing $env (copy .env.example)"; exit 1; }
  # shellcheck disable=SC1090
  set -a; . "$env"; set +a
  log() { echo "[update $(date -u +%FT%TZ)] $*"; }
  # Pinned on purpose (e.g. after a rollback): only --force updates.
  if [ "${AUTO_UPDATE:-1}" = 0 ] && [ "$force" = 0 ]; then exit 0; fi

  local auth=()
  [ -n "${GITHUB_TOKEN:-}" ] && auth=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
  local body code
  body=$(curl -sSL -w '\n%{http_code}' "${auth[@]}" "https://api.github.com/repos/${GITHUB_REPO:-tangleMesh/hide-n-seek}/releases/latest") \
    || { log "could not reach GitHub"; exit 0; }
  code="${body##*$'\n'}"
  [ "$code" = 404 ] && { log "no published release yet"; exit 0; }
  [ "$code" = 200 ] || { log "GitHub answered $code"; exit 0; }
  latest=$(printf '%s' "$body" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)
  [ -n "$latest" ] || { log "no release tag found"; exit 0; }
  current="${HUSH_VERSION:-}"
  if [ "$latest" = "$current" ] && [ "$force" = 0 ]; then exit 0; fi

  image="${HUSH_IMAGE:-ghcr.io/tanglemesh/hide-n-seek}:${latest}"
  # The release workflow may still be building the image, so try again next time.
  if ! docker pull -q "$image" >/dev/null 2>&1; then log "image $image not available yet"; exit 0; fi
  log "new release $latest (running ${current:-none})"

  # Deployment files of that release (compose file, backup image, this script).
  if [ -d "$repo/.git" ]; then
    git -C "$repo" fetch -q --tags origin && git -C "$repo" checkout -q "$latest" && log "checked out $latest" \
      || log "could not check out $latest (keeping the current deploy files)"
  fi

  # Don't cut running games short: wait until nobody is playing (or give up waiting).
  max=$(( ${UPDATE_MAX_WAIT_MIN:-30} * 60 )); waited=0
  while live=$(curl -fs "http://127.0.0.1:${HOST_PORT:-8081}/api/health" | sed -n 's/.*"liveMatches":\([0-9]*\).*/\1/p') \
        && [ -n "$live" ] && [ "$live" != 0 ] && [ "$waited" -lt "$max" ]; do
    [ $(( waited % 600 )) = 0 ] && log "$live game(s) running: waiting before the update"
    sleep 30; waited=$(( waited + 30 ))
  done

  if grep -q '^HUSH_VERSION=' "$env"; then sed -i "s/^HUSH_VERSION=.*/HUSH_VERSION=${latest}/" "$env"
  else echo "HUSH_VERSION=${latest}" >> "$env"; fi
  cd "$dir"
  HUSH_VERSION="$latest" docker compose up -d --build --remove-orphans
  docker image prune -f >/dev/null || true
  log "now running $latest"
}

main "$@"
