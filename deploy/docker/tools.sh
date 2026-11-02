#!/bin/sh
# Administrative one-shot tasks. Never part of the HTTP runtime.
#   init          create admin DB password, backup key and local TLS (only if absent)
#   setup         create/verify least-privilege roles and per-service secret files
#   migrate       apply db/migrations (migrator role only)
#   backup        encrypted pg_dump to /backups
#   restore-test  <file>  restore into a NEW disposable *_restore_test database
# The project scripts only accept loopback database URLs, so tasks that need
# them run a private forwarder 127.0.0.1:5432 -> db:5432 inside this container.
set -eu
umask 077
cd /app
S=/app/.local                    # host secret directory (bind mount, 0700)
fail() {
  echo "tools: $*" >&2
  exit 1
}
forward_db() {
  FORWARD_LISTEN=127.0.0.1:5432 FORWARD_TARGET=db:5432 bun deploy/docker/tcp-forward.mjs >/dev/null &
  i=0
  until pg_isready -q -h 127.0.0.1 -p 5432 -U catus_admin; do
    i=$((i + 1))
    [ "$i" -lt 30 ] || fail "database not reachable"
    sleep 1
  done
}
admin_url() {
  pw=$(cat /run/secrets/pg_admin_password) || fail "admin password secret unavailable"
  printf 'postgres://catus_admin:%s@127.0.0.1:5432/catus' "$pw"
}
loopback() { sed 's#@db:5432/#@127.0.0.1:5432/#'; }
cmd="${1:-}"
[ $# -gt 0 ] && shift
case "$cmd" in
  init)
    [ -w "$S" ] || fail "secret directory not writable"
    if [ ! -s "$S/pg_admin_password" ]; then
      openssl rand -hex 32 | tr -d '\n' > "$S/pg_admin_password"
      echo "created pg_admin_password (64 hex chars, not printed)"
    else echo "kept existing pg_admin_password"; fi
    if [ ! -e "$S/backup.key" ]; then
      BACKUP_KEY_FILE="$S/backup.key" bun scripts/backup-key.ts
    else echo "kept existing backup.key"; fi
    if [ ! -e "$S/tls/server.crt" ]; then bun scripts/local-tls.ts; else echo "kept existing TLS material"; fi
    ;;
  setup)
    [ -w "$S" ] || fail "secret directory not writable"
    forward_db
    DATABASE_URL=$(admin_url) bun scripts/provision-roles.ts
    for pair in RUNTIME_DATABASE_URL:runtime_database_url MAINTENANCE_DATABASE_URL:maintenance_database_url MIGRATION_DATABASE_URL:migrator_database_url; do
      key=${pair%%:*}
      file="$S/${pair#*:}"
      value=$(sed -n "s/^$key=//p" "$S/database.env" | sed 's#@127.0.0.1:5432/#@db:5432/#')
      [ -n "$value" ] || fail "$key missing in database.env"
      printf '%s' "$value" > "$file.tmp" && mv "$file.tmp" "$file"
      chmod 600 "$file"
    done
    echo "per-service secret files written (0600, values not printed)"
    ;;
  migrate)
    MIGRATION_DATABASE_URL=$(cat /run/secrets/migrator_database_url) \
      DB_RUNTIME_ROLE=catus_runtime DB_MAINTENANCE_ROLE=catus_maintenance DB_AI_WORKER_ROLE=catus_aiworker \
      bun scripts/migrate.ts
    echo "migrations up to date"
    ;;
  backup)
    forward_db
    out="/backups/catus-$(date -u +%Y%m%dT%H%M%SZ).catus"
    MIGRATION_DATABASE_URL=$(loopback < /run/secrets/migrator_database_url) \
      BACKUP_KEY_FILE=/run/secrets/backup_key bun scripts/backup.ts backup "$out"
    ;;
  restore-test)
    file="${1:-}"
    case "$file" in /backups/*.catus) ;; *) fail "usage: restore-test /backups/<file>.catus" ;; esac
    [ -f "$file" ] || fail "backup file not found"
    forward_db
    # Fresh, uniquely named disposable target; restore credentials live only in this container's tmpfs.
    work=/tmp/restore && mkdir -p "$work/.local"
    name="catus_r$(date -u +%Y%m%d%H%M%S)_restore_test"
    (cd "$work" && DATABASE_URL=$(admin_url) RESTORE_DATABASE_NAME="$name" bun /app/scripts/prepare-restore.ts)
    (cd "$work" && BACKUP_KEY_FILE=/run/secrets/backup_key bun --env-file=.local/restore.env /app/scripts/backup.ts restore "$file")
    echo "restored into disposable database $name (never dropped automatically)"
    ;;
  *) fail "unknown command '$cmd' (init|setup|migrate|backup|restore-test)" ;;
esac
