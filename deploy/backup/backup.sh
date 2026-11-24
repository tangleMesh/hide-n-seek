#!/usr/bin/env bash
# Database backups to S3.
#   backup.sh loop   (default) checks every hour and backs up once BACKUP_INTERVAL_HOURS have passed
#                    since the last successful backup. The time is kept in /state, so restarts don't
#                    trigger extra backups.
#   backup.sh now    one backup right away (docker compose run --rm backup now)
#   backup.sh list   the backups in S3
set -euo pipefail

: "${MONGO_URL:=mongodb://mongo:27017}"
: "${MONGO_DB:=hush}"
: "${BACKUP_INTERVAL_HOURS:=168}"
: "${BACKUP_KEEP:=12}"
: "${S3_PREFIX:=hush}"
STATE=/state/last-success

log() { echo "[backup $(date -u +%FT%TZ)] $*"; }

check_config() {
  if [ -z "${S3_BUCKET:-}" ] || [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
    log "S3_BUCKET / AWS credentials not set in deploy/.env: backups are disabled"
    return 1
  fi
}

backup() {
  local key="${S3_PREFIX}/${MONGO_DB}-$(date -u +%Y%m%dT%H%M%SZ).archive.gz"
  log "dumping ${MONGO_DB} to s3://${S3_BUCKET}/${key}"
  mongodump --uri "${MONGO_URL}" --db "${MONGO_DB}" --archive --gzip --quiet \
    | aws s3 cp - "s3://${S3_BUCKET}/${key}" --only-show-errors
  date +%s > "${STATE}"
  log "done"
  prune
}

# Keep only the newest BACKUP_KEEP backups (0 = keep everything).
prune() {
  [ "${BACKUP_KEEP}" -gt 0 ] || return 0
  local old
  old=$(aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}/" | awk '{print $4}' | grep -E "^${MONGO_DB}-.*\.archive\.gz$" | sort | head -n -"${BACKUP_KEEP}" || true)
  for f in ${old}; do
    log "removing old backup ${f}"
    aws s3 rm "s3://${S3_BUCKET}/${S3_PREFIX}/${f}" --only-show-errors
  done
}

case "${1:-loop}" in
  now) check_config && backup ;;
  list) check_config && aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}/" ;;
  loop)
    mkdir -p /state
    log "every ${BACKUP_INTERVAL_HOURS} h to s3://${S3_BUCKET:-?}/${S3_PREFIX}/ (keeping ${BACKUP_KEEP})"
    while true; do
      if check_config; then
        last=$(cat "${STATE}" 2>/dev/null || echo 0)
        if [ $(( $(date +%s) - last )) -ge $(( BACKUP_INTERVAL_HOURS * 3600 )) ]; then
          backup || log "backup FAILED (retrying in an hour)"
        fi
      fi
      sleep 3600
    done
    ;;
  *) echo "usage: backup.sh [loop|now|list]"; exit 2 ;;
esac
