#!/usr/bin/env bash
# G2 preflight — read-only verification of a private homologation host.
# Never modifies the system, never prints secrets. Run as the OPERATOR user
# from the application checkout, with the administrative DATABASE_URL in the
# operator's environment (not in Git). Exit 0 only when every check passes.
#
#   EXPECTED_SHA=<sha> RUNTIME_USER=catus-run ./scripts/g2-preflight.sh
#
# Optional: PORT (3443), TLS_CERT_FILE/TLS_KEY_FILE (.local/tls/server.*),
# CA_FILE (.local/tls/ca.crt), RUNTIME_ENV_FILE (runtime service env file).
set -u
# Git must not read another user's config (e.g. sudo/su keeping HOME).
export HOME="$(getent passwd "$(id -un)" | cut -d: -f6)"
unset XDG_CONFIG_HOME
PORT="${PORT:-3443}"
TLS_CERT_FILE="${TLS_CERT_FILE:-.local/tls/server.crt}"
TLS_KEY_FILE="${TLS_KEY_FILE:-.local/tls/server.key}"
CA_FILE="${CA_FILE:-.local/tls/ca.crt}"
ROLES_FILE=.local/database.env
fails=0
human=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() {
  printf 'FAIL  %s\n' "$1"
  fails=$((fails + 1))
}
todo() {
  printf 'HUMAN %s\n' "$1"
  human=$((human + 1))
}
have() { command -v "$1" >/dev/null 2>&1; }
mode() { stat -c '%a' "$1" 2>/dev/null; }
# URL helpers run in Node so passwords never reach argv of other tools or stdout.
url_field() { node -e 'const u=new URL(process.env.U);const f=process.argv[1];console.log(f==="db"?decodeURIComponent(u.pathname.slice(1)):decodeURIComponent(u[f]))' "$2" 2>/dev/null; }
roles_value() { node -e 'const {parseEnv}=require("node:util");const e=parseEnv(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(e[process.argv[2]]||"")' "$ROLES_FILE" "$1" 2>/dev/null; }

echo "== 1. Host"
if [ -f /.dockerenv ] || [ -f /run/.containerenv ] || grep -qs ' / overlay ' /proc/mounts; then
  fail "root filesystem is an overlay/container layer; G2 requires a persistent host"
else pass "root filesystem is not a container overlay"; fi
if have systemctl && [ "$(systemctl is-system-running 2>/dev/null)" != offline ]; then
  pass "systemd available for supervised services"
else fail "no running systemd; services cannot be supervised persistently"; fi
avail_kb=$(df -Pk . | awk 'NR==2{print $4}')
[ "${avail_kb:-0}" -ge 10485760 ] && pass "free disk >= 10 GiB" || fail "free disk < 10 GiB in checkout volume"
mem_kb=$(awk '/MemTotal/{print $2}' /proc/meminfo)
[ "${mem_kb:-0}" -ge 3500000 ] && pass "RAM >= 3.5 GiB" || fail "RAM < 3.5 GiB"
[ "$(id -u)" -ne 0 ] && pass "running as non-root operator ($(id -un))" || fail "run as the operator user, not root"

echo "== 2. Dependencies"
if have node && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)'; then
  pass "Node $(node -v) >= 22.12"
else fail "Node >= 22.12 missing"; fi
for t in npm git openssl curl psql ss; do have "$t" && pass "$t present" || fail "$t missing"; done
[ -x node_modules/.bin/bun ] && pass "npm ci done (bun available)" || fail "node_modules missing; run npm ci"
if [ -S /var/run/docker.sock ]; then pass "Docker socket present (needed for G5 pg_dump clients)"; else todo "Docker not present: required before G5, not for G2"; fi

echo "== 3. Source and secrets in Git"
head=$(git rev-parse HEAD 2>/dev/null)
if [ -n "${EXPECTED_SHA:-}" ] && [ "${head#"$EXPECTED_SHA"}" != "$head" ]; then
  pass "HEAD $head matches expected $EXPECTED_SHA"
else fail "HEAD ${head:-?} does not match EXPECTED_SHA=${EXPECTED_SHA:-unset}"; fi
[ -z "$(git status --porcelain)" ] && pass "working tree clean" || fail "working tree has local changes"
if git ls-files | grep -qE '^\.local/|(^|/)\.env$'; then fail ".env or .local tracked by Git"; else pass ".env and .local not tracked"; fi
if git check-ignore -q .local/x && git check-ignore -q .env; then pass ".env and .local ignored"; else fail ".env/.local not ignored"; fi
if git grep -qE 'gh[opsu]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{30,}|GOCSPX-|-----BEGIN [A-Z ]*PRIVATE KEY' -- . ':!scripts/g2-preflight.sh'; then
  fail "secret-like material in tracked files"
else pass "no secret-like material in tracked files"; fi
n=$(ls db/migrations/*.sql 2>/dev/null | wc -l)
[ "$n" -eq 9 ] && pass "migration files 001-009 present ($n)" || fail "expected 9 migration files, found $n"

echo "== 4. Build"
if [ -f dist/index.html ]; then pass "dist built"; else fail "dist missing; run npm run build"; fi

echo "== 5. PostgreSQL (administrative URL from operator environment)"
if [ -z "${DATABASE_URL:-}" ]; then
  fail "DATABASE_URL (admin) not set in operator environment"
else
  host=$(U="$DATABASE_URL" url_field x hostname)
  case "$host" in 127.0.0.1 | localhost) pass "admin URL targets loopback" ;; *) fail "admin URL is not loopback" ;; esac
  [ "$(U="$DATABASE_URL" url_field x db)" = catus ] && pass "database name is catus" || fail "database name must be catus"
  pw=$(U="$DATABASE_URL" url_field x password)
  if [ -z "$pw" ] || [ "$pw" = catus_local_only ]; then
    fail "admin password is empty or the public development password"
  elif [ "${#pw}" -lt 24 ]; then
    fail "admin password shorter than 24 characters"
  else pass "admin password is not the development password and has >= 24 characters"; fi
  unset pw
  q() { PGCONNECT_TIMEOUT=5 psql "$DATABASE_URL" -XAtqc "$1" 2>/dev/null; }
  ver=$(q 'SHOW server_version_num')
  if [ -n "$ver" ]; then
    pass "connected (server_version_num $ver)"
    [ "$ver" -ge 180000 ] 2>/dev/null && pass "PostgreSQL >= 18" || fail "PostgreSQL < 18 (pinned clients are 18.3)"
    [ "$(q 'SHOW password_encryption')" = scram-sha-256 ] && pass "password_encryption scram-sha-256" || fail "password_encryption is not scram-sha-256"
    la=$(q 'SHOW listen_addresses')
    case "$la" in localhost | 127.0.0.1 | "127.0.0.1,::1" | "localhost,127.0.0.1" | "") pass "listen_addresses loopback ($la)" ;; *) fail "listen_addresses not loopback-only ($la)" ;; esac
    weak=$(q "SELECT count(*) FROM pg_hba_file_rules WHERE auth_method IN ('trust','password','md5')")
    if [ -z "$weak" ]; then todo "cannot read pg_hba_file_rules; confirm host rules use scram-sha-256 and no trust"
    elif [ "$weak" = 0 ]; then pass "pg_hba has no trust/md5/password network rules"
    else fail "pg_hba has $weak weak rules (trust/md5/password)"; fi
    sl=$(q 'SHOW ssl'); [ -n "$sl" ] && pass "server ssl=$sl (loopback only; TLS to clients is terminated by the app)"
    applied=$(q "SELECT string_agg(name,',' ORDER BY name) FROM schema_migrations")
    expected=$(ls db/migrations | paste -sd, -)
    [ "$applied" = "$expected" ] && pass "schema_migrations matches files 001-009" || fail "schema_migrations differs from db/migrations"
    rr=$(q "SELECT string_agg(rolname||':'||rolsuper::int||rolcreatedb::int||rolcreaterole::int||rolbypassrls::int,',' ORDER BY rolname) FROM pg_roles WHERE rolname IN ('catus_runtime','catus_migrator','catus_maintenance')")
    case "$rr" in *catus_maintenance:0000*catus_migrator:0000*catus_runtime:0000*) pass "application roles exist without superuser/createdb/createrole/bypassrls" ;; *) fail "application roles missing or over-privileged ($rr)" ;; esac
  else fail "cannot connect with admin DATABASE_URL"; fi
fi

echo "== 6. Role credentials and runtime isolation"
if [ -f "$ROLES_FILE" ]; then
  [ "$(mode "$ROLES_FILE")" = 600 ] && pass "$ROLES_FILE mode 0600" || fail "$ROLES_FILE mode $(mode "$ROLES_FILE") (expected 600)"
  [ "$(stat -c %U "$ROLES_FILE")" = "$(id -un)" ] && pass "$ROLES_FILE owned by operator" || fail "$ROLES_FILE not owned by operator"
  RUNTIME_URL=$(roles_value RUNTIME_DATABASE_URL)
  if [ -n "$RUNTIME_URL" ] && RUNTIME_DATABASE_URL="$RUNTIME_URL" node_modules/.bin/bun -e 'import pg from "pg";import {assertRuntimePrivileges} from "./scripts/lib/privileges";const p=new pg.Pool({connectionString:process.env.RUNTIME_DATABASE_URL});try{await assertRuntimePrivileges(p)}finally{await p.end()}' >/dev/null 2>&1; then
    pass "runtime role passes assertRuntimePrivileges (least privilege)"
  else fail "runtime role privilege check failed"; fi
  unset RUNTIME_URL
else fail "$ROLES_FILE missing; run npm run db:roles"; fi
if [ -n "${RUNTIME_USER:-}" ] && id "$RUNTIME_USER" >/dev/null 2>&1; then
  [ "$RUNTIME_USER" != "$(id -un)" ] && pass "runtime user $RUNTIME_USER differs from operator" || fail "runtime user equals operator"
  [ "$(id -u "$RUNTIME_USER")" -ne 0 ] && pass "runtime user is not root" || fail "runtime user is root"
  for f in "$ROLES_FILE" .env .local/backup.key .local/tls/ca.key; do
    [ -e "$f" ] || continue
    o=$(stat -c '%U %a' "$f")
    case "$o" in "$(id -un) 600" | "$(id -un) 400") pass "$f private to operator (runtime cannot read)" ;; *) fail "$f readable beyond operator ($o)" ;; esac
  done
  if [ -n "${RUNTIME_ENV_FILE:-}" ]; then
    if [ -f "$RUNTIME_ENV_FILE" ]; then
      [ "$(mode "$RUNTIME_ENV_FILE")" = 600 ] || [ "$(mode "$RUNTIME_ENV_FILE")" = 640 ] && pass "runtime env file restricted" || fail "runtime env file mode $(mode "$RUNTIME_ENV_FILE")"
      grep -qE '^(DATABASE_URL|MIGRATION_DATABASE_URL|MAINTENANCE_DATABASE_URL|BACKUP_KEY_FILE)=' "$RUNTIME_ENV_FILE" && fail "runtime env file contains privileged URLs/keys" || pass "runtime env file has no admin/migrator/maintenance/backup secrets"
      grep -qE '^LLM_ENABLED=true' "$RUNTIME_ENV_FILE" && fail "LLM_ENABLED=true in runtime env" || pass "M2 off in runtime env"
      grep -qE '^DELIVERY_ENABLED=true' "$RUNTIME_ENV_FILE" && fail "DELIVERY_ENABLED=true in runtime env" || pass "M5 off in runtime env"
    else todo "RUNTIME_ENV_FILE not readable by operator; verify mode and content manually"; fi
  else todo "set RUNTIME_ENV_FILE to verify the runtime service environment"; fi
else fail "RUNTIME_USER unset or does not exist (dedicated non-root OS user required)"; fi
for f in .env; do [ -f "$f" ] && { grep -qE '^LLM_ENABLED=true' "$f" && fail "LLM_ENABLED=true in .env" || pass "M2 off in .env"; grep -qE '^DELIVERY_ENABLED=true' "$f" && fail "DELIVERY_ENABLED=true in .env" || pass "M5 off in .env"; }; done

echo "== 7. TLS material"
if [ -f "$TLS_CERT_FILE" ] && [ -f "$TLS_KEY_FILE" ] && [ -f "$CA_FILE" ]; then
  openssl verify -CAfile "$CA_FILE" "$TLS_CERT_FILE" >/dev/null 2>&1 && pass "server certificate chains to local CA" || fail "certificate does not verify against CA"
  openssl x509 -in "$TLS_CERT_FILE" -noout -checkend 86400 >/dev/null && pass "certificate valid for > 24h" || fail "certificate expires within 24h; rotate explicitly"
  openssl x509 -in "$TLS_CERT_FILE" -noout -ext subjectAltName 2>/dev/null | grep -q 'DNS:localhost' && pass "SAN includes localhost" || fail "SAN lacks localhost"
  km=$(mode "$TLS_KEY_FILE")
  case "$km" in 600 | 400 | 640 | 440) pass "server key mode $km" ;; *) fail "server key mode $km too open" ;; esac
  printf 'INFO  CA fingerprint (share via separate channel): %s\n' "$(openssl x509 -in "$CA_FILE" -noout -fingerprint -sha256 | cut -d= -f2)"
else fail "TLS files missing; run npm run tls:local"; fi

echo "== 8. Running application (loopback, HTTPS, guards)"
listen=$(ss -ltnH "sport = :$PORT" 2>/dev/null | awk '{print $4}')
if [ -z "$listen" ]; then
  fail "nothing listening on port $PORT (start the runtime service)"
else
  if echo "$listen" | grep -qvE '^(127\.0\.0\.1|\[::1\]):'; then fail "port $PORT bound beyond loopback: $(echo $listen)"; else pass "port $PORT bound only to loopback"; fi
  base="https://localhost:$PORT"
  cfg=$(curl -sS --max-time 5 --cacert "$CA_FILE" "$base/api/auth/config" 2>/dev/null)
  [ -n "$cfg" ] && pass "HTTPS verified with local CA: /api/auth/config -> $cfg" || fail "HTTPS request with local CA failed"
  curl -s --max-time 5 -o /dev/null "$base/api/auth/config"
  rc=$?
  [ "$rc" -eq 60 ] && pass "unknown CA rejected (curl exit 60)" || fail "request without the CA did not fail with certificate error (exit $rc)"
  code=$(curl -s --max-time 5 --cacert "$CA_FILE" -o /dev/null -w '%{http_code}' -X POST -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -d '{}' "$base/api/clients")
  case "$code" in 401 | 403) pass "forged-origin POST refused ($code)" ;; *) fail "forged-origin POST returned $code" ;; esac
  code=$(curl -s --max-time 5 --cacert "$CA_FILE" -o /dev/null -w '%{http_code}' "$base/api/mission-control")
  case "$code" in 401 | 403 | 503) pass "unauthenticated API refused ($code)" ;; *) fail "unauthenticated API returned $code" ;; esac
  hdr=$(curl -sI --max-time 5 --cacert "$CA_FILE" "$base/")
  for h in strict-transport-security content-security-policy x-frame-options x-content-type-options; do
    echo "$hdr" | grep -qi "^$h:" && pass "header $h present" || fail "header $h missing"
  done
  # ss cannot show other users' pids without root; ps shows every server process owner.
  owners=$(ps -eo user:32=,args= | awk '/src\/server\/index\.ts/ && !/awk/ {print $1}' | sort -u | paste -sd, -)
  if [ -z "${RUNTIME_USER:-}" ] || [ -z "$owners" ]; then
    todo "confirm the listener process runs as the runtime user (ps -eo user=,args=)"
  elif [ "$owners" = "$RUNTIME_USER" ]; then
    pass "server process runs only as $RUNTIME_USER"
  else fail "server process owners: $owners (expected only $RUNTIME_USER)"; fi
fi

echo "== 9. Public exposure"
pub=$(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -vE '^(127\.|\[::1\]|\[::ffff:127\.)' | grep -vE ':22$' | tr '\n' ' ')
[ -z "$pub" ] && pass "no non-loopback listeners except SSH" || fail "non-loopback listeners: $pub"
todo "confirm host firewall/cloud security group blocks inbound except authorized SSH"

echo
echo "Summary: $fails FAIL, $human HUMAN"
[ "$fails" -eq 0 ] && exit 0 || exit 1
