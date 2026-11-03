#!/usr/bin/env bash
# Catus OS — private homologation with Docker Compose (G2).
# Host needs only: bash, Docker Engine + Compose v2 (+ buildx), git, curl,
# openssl, iproute2 (ss). No Node/npm/PostgreSQL on the host.
#
#   deploy/catus.sh install        build, create secrets, DB, roles, migrations, start
#   deploy/catus.sh start | stop | status | logs [service]
#   deploy/catus.sh update         backup, rebuild current checkout, migrate, restart
#   deploy/catus.sh backup         encrypted backup into CATUS_BACKUP_DIR
#   deploy/catus.sh restore-test <file.catus>   restore into a new disposable DB
#   deploy/catus.sh rotate-tls     archive TLS material, issue new 7-day CA/cert
#   deploy/catus.sh verify [--recreate]         G2 checks (read-only unless --recreate)
#   deploy/catus.sh google-setup [client.json]  G3: store Google OAuth client, enable login
#   deploy/catus.sh google-check                G3: offline+Google endpoint checks (no login)
#   deploy/catus.sh admin-bootstrap <email> <name>   G3: first administrator (once)
#
# Never runs `down -v`, `volume rm` or `prune`. Data: volume catus_pgdata.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/deploy/.env"
dc() { docker compose -f "$ROOT/deploy/compose.yaml" --env-file "$ENV_FILE" "$@"; }
die() {
  echo "catus: $*" >&2
  exit 1
}
load_env() {
  [ -f "$ENV_FILE" ] || die "missing deploy/.env; run: deploy/catus.sh install"
  # shellcheck disable=SC1090
  set -a && . "$ENV_FILE" && set +a
  [ ! -d "${CATUS_SECRETS_DIR:-}" ] || ensure_oidc_files
}
# Origin users type in the browser. Default: loopback only. A private network
# name (e.g. https://catus.<tailnet>.ts.net) needs CATUS_ORIGIN in deploy/.env and
# that exact redirect URI in the Google client (docs/PILOT_READINESS.md).
origin() { printf '%s' "${CATUS_ORIGIN:-https://localhost:$CATUS_HOST_PORT}"; }
# Compose needs both files to exist; empty means "OIDC not configured" (login blocked).
ensure_oidc_files() {
  local f
  for f in oidc.env oidc_client_secret; do
    [ -e "$CATUS_SECRETS_DIR/$f" ] || (umask 077 && : >"$CATUS_SECRETS_DIR/$f")
  done
}
preflight() {
  [ "$(id -u)" -ne 0 ] || die "run as your normal (non-root) user in the docker group"
  docker info >/dev/null 2>&1 || die "Docker daemon not reachable (sudo systemctl start docker)"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 plugin missing"
  docker buildx version >/dev/null 2>&1 || die "docker buildx plugin missing"
}
wait_healthy() {
  local svc i cid st
  for svc in "$@"; do
    for i in $(seq 1 60); do
      cid=$(dc ps -q "$svc")
      st=$([ -n "$cid" ] && docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo none)
      [ "$st" = healthy ] && break
      [ "$i" -eq 60 ] && die "$svc not healthy (status: $st); see deploy/catus.sh logs $svc"
      sleep 2
    done
    echo "$svc: healthy"
  done
}
write_env() {
  [ -f "$ENV_FILE" ] && {
    echo "kept existing deploy/.env"
    return
  }
  umask 077
  cat >"$ENV_FILE" <<EOF
# Host-specific, not secret, ignored by Git. Created by deploy/catus.sh install.
CATUS_UID=$(id -u)
CATUS_GID=$(id -g)
CATUS_SECRETS_DIR=$ROOT/.local/compose
CATUS_BACKUP_DIR=$ROOT/.local/compose-backups
CATUS_HOST_PORT=3443
CATUS_FRONTEND_SUBNET=10.89.243.0/29
CATUS_EDGE_IP=10.89.243.2
EOF
  echo "created deploy/.env"
}

cmd_install() {
  preflight
  write_env
  load_env
  install -d -m 700 "$CATUS_SECRETS_DIR" "$CATUS_BACKUP_DIR"
  ensure_oidc_files
  dc --profile admin build
  dc run --rm init
  dc up -d db
  wait_healthy db
  dc run --rm setup
  dc run --rm migrate
  dc up -d
  wait_healthy edge app cleanup
  echo
  echo "Catus OS running at https://localhost:${CATUS_HOST_PORT}"
  echo "Trust only in a dedicated browser profile: $CATUS_SECRETS_DIR/tls/ca.crt"
  openssl x509 -in "$CATUS_SECRETS_DIR/tls/ca.crt" -noout -fingerprint -sha256
}
cmd_start() {
  preflight
  load_env
  dc up -d
  wait_healthy db edge app cleanup
}
cmd_stop() {
  load_env
  dc stop
}
cmd_update() {
  preflight
  load_env
  [ -z "$(git -C "$ROOT" status --porcelain)" ] || die "working tree has local changes"
  echo "checkout: $(git -C "$ROOT" rev-parse HEAD)"
  dc run --rm backup
  dc --profile admin build
  dc up -d db
  wait_healthy db
  dc run --rm migrate
  dc up -d
  wait_healthy edge app cleanup
}
cmd_rotate_tls() {
  preflight
  load_env
  local old
  old="$CATUS_SECRETS_DIR/tls.$(date -u +%Y%m%dT%H%M%SZ)"
  mv "$CATUS_SECRETS_DIR/tls" "$old"
  echo "archived previous TLS material in $old"
  dc run --rm init
  dc up -d --force-recreate app
  wait_healthy app
  openssl x509 -in "$CATUS_SECRETS_DIR/tls/ca.crt" -noout -fingerprint -sha256
  echo "Import the NEW ca.crt in the dedicated browser profile and remove the old one."
}

P=0 F=0
ok() {
  echo "PASS  $*"
  P=$((P + 1))
}
ko() {
  echo "FAIL  $*"
  F=$((F + 1))
}

# ---------------------------------------------------------------- Google (G3)
cmd_google_setup() {
  preflight
  load_env
  local json="${1:-}" id secret hd
  if [ -n "$json" ]; then
    [ -f "$json" ] && [ -r "$json" ] || die "cannot read $json"
    read -rp "Domínio Google Workspace para restringir (Enter = contas Google comuns): " hd
    dc run --rm -e "OIDC_HOSTED_DOMAIN=$hd" -v "$(realpath "$json"):/run/oidc/client.json:ro" google-setup
  else
    read -rp "Client ID (….apps.googleusercontent.com): " id
    read -rsp "Client secret (não aparece na tela): " secret
    echo
    read -rp "Domínio Google Workspace para restringir (Enter = contas Google comuns): " hd
    # printf is a shell builtin: the secret never appears in process arguments.
    printf '%s\n%s\n%s\n' "$id" "$secret" "$hd" | dc run --rm -T google-setup
    unset secret
  fi
  dc up -d --force-recreate app
  wait_healthy app
  cmd_google_check
  [ -z "$json" ] || echo "Apague o JSON baixado após confirmar o login: shred -u '$json'"
}
# Proves configuration, discovery and Google's acceptance of client ID + redirect URI.
# Does not prove the client secret: only a real login exchanges the code.
google_checks() {
  local base="https://localhost:$CATUS_HOST_PORT" CA="$CATUS_SECRETS_DIR/tls/ca.crt" c loc id redirect
  id=$(sed -n 's/^OIDC_CLIENT_ID=//p' "$CATUS_SECRETS_DIR/oidc.env")
  # Requests go to the loopback port; the redirect URI follows the public origin.
  redirect=$(printf '%s/api/auth/callback' "$(origin)" | sed 's#:#%3A#g; s#/#%2F#g')
  c=$(curl -sS --max-time 10 --cacert "$CA" "$base/api/auth/config" 2>&1 || true)
  [ "$c" = '{"configured":true}' ] && ok "OIDC configured ($c)" || ko "auth config: $c"
  [ "$(stat -c '%a %u' "$CATUS_SECRETS_DIR/oidc_client_secret")" = "600 $(id -u)" ] && [ -s "$CATUS_SECRETS_DIR/oidc_client_secret" ] &&
    ok "client secret file present, 0600" || ko "client secret file missing or mode $(stat -c %a "$CATUS_SECRETS_DIR/oidc_client_secret")"
  loc=$(curl -sS --max-time 15 --cacert "$CA" -o /dev/null -w '%{http_code} %{redirect_url}' "$base/api/auth/login" 2>&1 || true)
  c="$loc&"
  if [[ $c == "303 https://accounts.google.com/"* && $c == *"client_id=$id&"* && $c == *"redirect_uri=$redirect&"* && $c == *"code_challenge_method=S256&"* && $c == *"scope=openid+email+profile&"* ]]; then
    ok "login redirects to Google with PKCE, exact client ID and redirect URI (server reached Google discovery)"
  else
    ko "login redirect: ${loc%%\?*}"
    return
  fi
  # Google validates client_id and redirect_uri before showing its sign-in page.
  c=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code} %{redirect_url}' "${loc#303 }" 2>&1 || true)
  if [[ $c == "302 https://accounts.google.com/"* && $c != *error* ]]; then
    ok "Google accepted client ID and redirect URI (sign-in page)"
  else
    # authError is base64 protobuf carrying a readable code (invalid_client, redirect_uri_mismatch…).
    loc=$(sed -n 's/.*authError=\([^&]*\).*/\1/p' <<<"$c" | tr '_-' '/+' | base64 -d 2>/dev/null | tr -c '[:print:]' ' ' | grep -oE '[a-z_]{6,}' | head -1 || true)
    ko "Google rejected the authorization request: ${loc:-${c%%\?*}} (check client ID, Web client type, redirect URI and test users)"
  fi
}
cmd_google_check() {
  [ -n "${CATUS_SECRETS_DIR:-}" ] || {
    preflight
    load_env
  }
  [ -s "$CATUS_SECRETS_DIR/oidc.env" ] || die "Google OIDC not configured; run: deploy/catus.sh google-setup"
  google_checks
  echo "Summary: $P PASS, $F FAIL (the client secret is only proven by a real login)"
  [ "$F" -eq 0 ]
}
cmd_admin_bootstrap() {
  preflight
  load_env
  [ $# -eq 2 ] || die "usage: admin-bootstrap <email> '<Nome Completo>'"
  dc run --rm bootstrap-admin bootstrap-admin --email "$1" --name "$2"
}

# ---------------------------------------------------------------- verify (G2)
check() { if eval "$2" >/dev/null 2>&1; then ok "$1"; else ko "$1"; fi; }
db_sql() { dc exec -T db sh -c 'PGPASSWORD=$(cat /run/secrets/pg_admin_password) psql -XAtq -h 127.0.0.1 -U catus_admin -d catus -c "$0"' "$1"; }
state_fingerprint() { db_sql "SELECT (SELECT system_identifier FROM pg_control_system())||'|'||(SELECT string_agg(name||'@'||applied_at,',' ORDER BY name) FROM schema_migrations)"; }

cmd_verify() {
  preflight
  load_env
  local S="$CATUS_SECRETS_DIR" CA="$CATUS_SECRETS_DIR/tls/ca.crt" port="${CATUS_HOST_PORT}" base c
  base="https://localhost:$port"
  echo "== services"
  wait_healthy db edge app cleanup
  echo "== host exposure"
  c=$(ss -ltnH "sport = :$port" | awk '{print $4}' | sort -u | tr '\n' ' ')
  [ "$c" = "127.0.0.1:$port " ] && ok "host listens on 127.0.0.1:$port only" || ko "host listeners on :$port: $c"
  c=$(docker ps --filter label=com.docker.compose.project=catus --format '{{.Ports}}' | tr ',' '\n' | grep -- '->' | sed 's/^ *//' | sort -u | tr '\n' ' ')
  [ "$c" = "127.0.0.1:$port->3443/tcp " ] && ok "only published port: 127.0.0.1:$port->3443" || ko "published ports: $c"
  echo "== HTTPS and origin"
  c=$(curl -sS --max-time 5 --cacert "$CA" "$base/api/auth/config" 2>&1) && ok "HTTPS verified with local CA: $c" || ko "HTTPS with local CA failed: $c"
  curl -s --max-time 5 -o /dev/null "$base/api/auth/config" && ko "request without CA accepted" || { [ $? -eq 60 ] && ok "unknown CA rejected (curl 60)" || ko "unexpected error without CA"; }
  c=$(curl -s --max-time 5 --cacert "$CA" -o /dev/null -w '%{http_code}' -X POST -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -d '{}' "$base/api/clients")
  [ "$c" = 403 ] && ok "forged Origin refused (403)" || ko "forged Origin returned $c"
  c=$(curl -s --max-time 5 --cacert "$CA" -o /dev/null -w '%{http_code}' -X POST -H "Origin: $(origin)" -H 'Content-Type: application/json' -d '{}' "$base/api/clients")
  case "$c" in 401 | 403 | 503) ok "same-origin write without session refused ($c)" ;; *) ko "same-origin write without session returned $c" ;; esac
  c=$(curl -sI --max-time 5 --cacert "$CA" "$base/")
  for h in strict-transport-security content-security-policy x-frame-options x-content-type-options; do
    grep -qi "^$h:" <<<"$c" && ok "header $h" || ko "header $h missing"
  done
  echo "== database isolation"
  [ "$(docker network inspect catus_backend -f '{{.Internal}}')" = true ] && ok "backend network is internal (no egress)" || ko "backend network not internal"
  [ -z "$(docker inspect "$(dc ps -q db)" -f '{{range $p,$b := .HostConfig.PortBindings}}{{$p}}{{end}}')" ] && ok "db has no published port" || ko "db publishes a port"
  # pg_isready exit 2 = no response; 0/1 would mean the server answered.
  c=0
  docker run --rm --network catus_frontend --entrypoint pg_isready catus-tools:local -h db -U catus_admin -t 3 >/dev/null 2>&1 || c=$?
  [ "$c" = 2 ] && ok "db unreachable from frontend network" || ko "db reachability from frontend network: pg_isready exit $c"
  c=$(db_sql "SELECT setting FROM pg_settings WHERE name='password_encryption'")
  [ "$c" = scram-sha-256 ] && ok "password_encryption scram-sha-256" || ko "password_encryption=$c"
  c=$(db_sql "SELECT count(*) FROM pg_hba_file_rules WHERE auth_method NOT IN ('scram-sha-256','reject')")
  [ "$c" = 0 ] && ok "pg_hba: only scram-sha-256 rules" || ko "pg_hba has $c non-SCRAM rules"
  c=$(db_sql "SELECT string_agg(name,',' ORDER BY name) FROM schema_migrations")
  [ "$c" = "$(cd "$ROOT/db/migrations" && ls ./*.sql | sed 's#./##' | paste -sd, -)" ] && ok "migrations 001-009 applied" || ko "schema_migrations: $c"
  c=$(db_sql "SELECT string_agg(rolname||':'||rolsuper::int||rolcreatedb::int||rolcreaterole::int||rolbypassrls::int,',' ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'catus\_%' AND rolname<>'catus_admin'")
  grep -q ':1' <<<"$c" && ko "privileged application role: $c" || ok "application roles without superuser/createdb/createrole/bypassrls"
  echo "== privileged credentials refused by the HTTP runtime"
  local tmp
  for role in migrator admin; do
    tmp=$(mktemp "$S/.refuse.XXXXXX")
    if [ $role = migrator ]; then cat "$S/migrator_database_url" >"$tmp"; else printf 'postgres://catus_admin:%s@db:5432/catus' "$(cat "$S/pg_admin_password")" >"$tmp"; fi
    c=$(dc run --rm --no-deps -e PORT=3445 -v "$tmp:/run/secrets/runtime_database_url:ro" app 2>&1 || true)
    rm -f "$tmp"
    grep -q 'excessive privileges' <<<"$c" && ok "runtime refuses $role credentials" || ko "runtime did not refuse $role credentials"
  done
  echo "== containers"
  local id name
  for id in $(dc ps -q); do
    name=$(docker inspect -f '{{.Name}}' "$id")
    c=$(docker inspect -f '{{.Config.User}}|{{.HostConfig.Privileged}}|{{.HostConfig.CapDrop}}|{{.HostConfig.CapAdd}}|{{.HostConfig.ReadonlyRootfs}}|{{.HostConfig.SecurityOpt}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.RestartPolicy.Name}}|{{index .HostConfig.LogConfig.Config "max-size"}}|{{.HostConfig.Memory}}|{{.HostConfig.PidsLimit}}' "$id")
    IFS='|' read -r u priv drop add ro sec net rs logmax mem pids <<<"$c"
    [[ -n $u && $u != 0* && $u != root* ]] && ok "$name user $u (non-root)" || ko "$name user '$u'"
    [[ $priv == false && $drop == *ALL* && $add == "[]" && $ro == true && $sec == *no-new-privileges* ]] && ok "$name unprivileged, caps dropped, read-only, no-new-privileges" || ko "$name hardening: $c"
    [[ $net != host ]] && ok "$name network_mode $net" || ko "$name uses host network"
    [[ $rs == unless-stopped && -n $logmax && $mem -gt 0 && $pids -gt 0 ]] && ok "$name restart/log rotation/limits" || ko "$name restart=$rs log=$logmax mem=$mem pids=$pids"
    docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' "$id" | grep -q docker.sock && ko "$name mounts the Docker socket" || ok "$name has no Docker socket"
  done
  echo "== files and secrets"
  [ "$(stat -c %a "$S")" = 700 ] && ok "secret directory 0700" || ko "secret directory mode $(stat -c %a "$S")"
  local f bad=0
  for f in pg_admin_password runtime_database_url maintenance_database_url migrator_database_url database.env backup.key tls/server.key tls/ca.key oidc.env oidc_client_secret; do
    [ "$(stat -c '%a %u' "$S/$f")" = "600 $(id -u)" ] || {
      ko "$f mode/owner $(stat -c '%a %u' "$S/$f")"
      bad=1
    }
  done
  [ $bad = 0 ] && ok "secret files 0600, owned by operator"
  c=$(dc exec -T app sh -c 'ls /run/secrets | tr "\n" " "; touch /app/x 2>/dev/null && echo WRITABLE; true')
  [ "$c" = "oidc_client_secret runtime_database_url tls_ca_crt tls_server_crt tls_server_key " ] && ok "app sees only its secrets; /app read-only" || ko "app secrets/fs: $c"
  c=$(dc exec -T app sh -c 'cat /proc/1/environ | tr "\0" "\n" | cut -d= -f1 | sort | tr "\n" " "')
  grep -qE ' (DATABASE_URL|MIGRATION_DATABASE_URL|MAINTENANCE_DATABASE_URL|PGPASSWORD|BACKUP_KEY_FILE) ' <<<" $c" && ko "app process env has privileged variables: $c" || ok "app process env without admin/migrator/maintenance credentials"
  c=$(dc exec -T app sh -c 'tr "\0" "\n" </proc/1/environ | grep -E "^(LLM_ENABLED|DELIVERY_ENABLED)=" || true' | sort | tr '\n' ' ')
  [ "$c" = "DELIVERY_ENABLED=false LLM_ENABLED=false " ] && ok "M2 and M5 disabled" || ko "flags: $c"
  local leak=0 logs inspect
  logs=$(dc logs --no-color 2>&1)
  inspect=$(docker inspect $(dc ps -q) $(docker images -q 'catus-*') 2>/dev/null)
  for f in pg_admin_password runtime_database_url maintenance_database_url migrator_database_url; do
    v=$(cat "$S/$f")
    grep -qF "$v" <<<"$logs$inspect" && leak=1
    v=$(sed -E 's#.*://[^:]+:([^@]+)@.*#\1#' "$S/$f")
    grep -qF "$v" <<<"$logs$inspect" && leak=1
  done
  if [ -s "$S/oidc_client_secret" ]; then grep -qF "$(cat "$S/oidc_client_secret")" <<<"$logs$inspect" && leak=1; fi
  [ $leak = 0 ] && ok "no secret value in logs, container or image metadata" || ko "secret value found in logs/metadata"
  echo "== Google OIDC (G3)"
  if [ -s "$S/oidc.env" ]; then
    google_checks
  else
    c=$(curl -sS --max-time 5 --cacert "$CA" "$base/api/auth/config" 2>&1 || true)
    [ "$c" = '{"configured":false}' ] && ok "OIDC not configured: login blocked ($c)" || ko "auth config without OIDC: $c"
  fi
  git -C "$ROOT" ls-files --error-unmatch deploy/.env .local >/dev/null 2>&1 && ko "deploy/.env or .local tracked by Git" || ok "deploy/.env and .local not tracked by Git"
  if [ "${1:-}" = --recreate ]; then
    echo "== persistence after recreating containers"
    local before after
    before=$(state_fingerprint)
    dc up -d --force-recreate
    wait_healthy db edge app cleanup
    after=$(state_fingerprint)
    [ -n "$before" ] && [ "$before" = "$after" ] && ok "same cluster id and migration history after --force-recreate" || ko "state changed after recreate"
    dc down
    dc up -d
    wait_healthy db edge app cleanup
    after=$(state_fingerprint)
    [ "$before" = "$after" ] && ok "same state after down (without -v) and up" || ko "state changed after down/up"
    c=$(curl -sS --max-time 5 --cacert "$CA" "$base/api/auth/config" 2>&1) && ok "HTTPS after recreate: $c" || ko "HTTPS after recreate failed"
  fi
  echo
  echo "Summary: $P PASS, $F FAIL (host firewall and browser CA trust remain manual checks)"
  [ "$F" -eq 0 ]
}

case "${1:-}" in
  install) cmd_install ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) load_env && dc ps ;;
  logs) load_env && dc logs --tail 200 "${@:2}" ;;
  update) cmd_update ;;
  backup) preflight && load_env && dc run --rm backup ;;
  restore-test)
    preflight && load_env
    [ -n "${2:-}" ] || die "usage: restore-test <file.catus in CATUS_BACKUP_DIR>"
    dc run --rm restore-test restore-test "/backups/$(basename "$2")"
    ;;
  rotate-tls) cmd_rotate_tls ;;
  verify) cmd_verify "${2:-}" ;;
  google-setup) cmd_google_setup "${2:-}" ;;
  google-check) cmd_google_check ;;
  admin-bootstrap) cmd_admin_bootstrap "${@:2}" ;;
  *) sed -n '2,18p' "$0" ;;
esac
