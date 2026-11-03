#!/usr/bin/env bash
# Catus OS — G4: validação pós-deploy automatizada, reproduzível e não destrutiva.
#
#   deploy/g4.sh [--repo <checkout>] [--sha <commit>] [--out <dir>]
#                [--skip-real] [--skip-suite] [--skip-disposable]
#
# Um comando, três estágios, um relatório GO/NO-GO (REPORT.md fora do repositório):
#   A. Instalação real (somente leitura): deploy/catus.sh verify (sem --recreate),
#      foto do cluster e das contagens antes/depois, idade do último backup e
#      comparação do frontend servido com o build do SHA testado.
#   B. Suíte isolada: os testes do próprio repositório (Bun, Playwright journeys,
#      quality: visual, a11y, responsivo, teclado, desempenho) num contêiner da
#      imagem Playwright fixada, --network none, PostgreSQL descartável interno,
#      identidades sintéticas e provedor OIDC simulado só do harness de teste.
#   C. Instalação descartável: as imagens de produção do SHA num projeto Compose
#      separado (catus-g4): segredos, dados, rede, sub-rede, porta e tags próprios;
#      segurança HTTP/contêineres, backup cifrado, restauração bit a bit, arquivo
#      adulterado rejeitado, persistência após recriar e recuperação após reinício
#      do PostgreSQL. Ao final: `down` sem -v e remoção do diretório temporário.
#
# Garantias: não altera dados de negócio nem a configuração da instalação real
# (sem update, migrate, backup, restore-test ou admin-bootstrap nela; o verify só
# cria um contêiner temporário de teste e contadores de cota/login transitórios); nunca usa `down -v`, `volume rm` ou
# `prune`; não lê cookies/tokens de usuários; não publica portas fora de
# 127.0.0.1; não instala nada no sistema (só bash, git, Docker Compose v2, curl, ss).
set -euo pipefail
umask 077
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
REPO="" SHA="" OUT_BASE="${CATUS_G4_OUT:-$HOME/catus-g4}" RUN_REAL=1 RUN_SUITE=1 RUN_DISP=1
PW_IMAGE=mcr.microsoft.com/playwright:v1.58.2-noble@sha256:6446946a1d9fd62d9ae501312a2d76a43ee688542b21622056a372959b65d63d
G4_PORT="${CATUS_G4_PORT:-3543}" G4_SUBNET=10.89.244.0/29 G4_EDGE=10.89.244.2
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2" && shift ;;
    --sha) SHA="$2" && shift ;;
    --out) OUT_BASE="$2" && shift ;;
    --skip-real) RUN_REAL=0 ;;
    --skip-suite) RUN_SUITE=0 ;;
    --skip-disposable) RUN_DISP=0 ;;
    -h | --help) sed -n '2,26p' "$SELF" && exit 0 ;;
    *) echo "g4: opção desconhecida: $1" >&2 && exit 2 ;;
  esac
  shift
done
die() {
  echo "g4: $*" >&2
  exit 2
}
[ "$(id -u)" -ne 0 ] || die "execute como o usuário normal do grupo docker, não como root"
if [ -z "$REPO" ]; then
  REPO="$(cd "$(dirname "$SELF")/.." && pwd)"
  [ -f "$REPO/deploy/compose.yaml" ] || die "use --repo <checkout do Catus OS>"
fi
REPO="$(cd "$REPO" && pwd)"
[ -f "$REPO/deploy/compose.yaml" ] && [ -d "$REPO/.git" ] || die "$REPO não é um checkout do Catus OS"
for t in git docker curl ss tar sha256sum; do command -v "$t" >/dev/null || die "ferramenta ausente: $t"; done
docker info >/dev/null 2>&1 || die "Docker não acessível"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 ausente"
DEPLOYED="$(git -C "$REPO" rev-parse HEAD)"
SHA="$(git -C "$REPO" rev-parse --verify --end-of-options "${SHA:-$DEPLOYED}^{commit}" 2>/dev/null)" ||
  die "commit não encontrado; rode antes: git -C $REPO fetch origin"
S7=${SHA:0:7}
OUT="$OUT_BASE/$(date -u +%Y%m%dT%H%M%SZ)-$S7"
[ -d "$OUT_BASE" ] || install -d -m 700 "$OUT_BASE"
install -d -m 700 "$OUT" "$OUT/logs"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/catus-g4.XXXXXXXX")"
RES="$OUT/results.tsv" && : >"$RES"
STARTED=$(date -u +%FT%TZ)
log() { printf '\n== %s\n' "$*"; }
rec() { # stage status check detail
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "${4:-}" >>"$RES"
  printf '%-5s %-4s %s%s\n' "$2" "$1" "$3" "${4:+ — $4}"
}
pass() { rec "$1" PASS "$2" "${3:-}"; }
fail() { rec "$1" FAIL "$2" "${3:-}"; }
warn() { rec "$1" WARN "$2" "${3:-}"; }
skip() { rec "$1" SKIP "$2" "${3:-}"; }
# Runs "$@" with output in logs/<name>.log; records PASS/FAIL with duration.
run() {
  local stage=$1 name=$2 t0 rc=0
  shift 2
  t0=$(date +%s)
  "$@" >"$OUT/logs/$name.log" 2>&1 || rc=$?
  if [ $rc -eq 0 ]; then pass "$stage" "$name" "$(($(date +%s) - t0))s"; else fail "$stage" "$name" "exit $rc em $(($(date +%s) - t0))s, ver logs/$name.log"; fi
  return $rc
}

# ------------------------------------------------- disposable Compose project
DISP_UP=0
# Compose file of the tested commit (extracted by git archive), never the working tree.
# CATUS_* exported in the operator's shell would win over --env-file: drop them all.
dcg() {
  local unset=() v
  for v in $(compgen -e | grep '^CATUS_' || true); do unset+=(-u "$v"); done
  env "${unset[@]}" ${G4_TIMEOUT:+timeout "$G4_TIMEOUT"} docker compose -p catus-g4 -f "$WORK/src/deploy/compose.yaml" -f "$WORK/g4.override.yaml" --env-file "$WORK/g4.env" "$@"
}
cleanup() {
  set +e
  if [ "$DISP_UP" = 1 ]; then
    dcg --profile admin down --remove-orphans >"$OUT/logs/disposable-down.log" 2>&1 # never -v
    docker image rm "catus-g4-app:$S7" "catus-g4-tools:$S7" "catus-g4-postgres:$S7" >/dev/null 2>&1
  fi
  docker rm -f "catus-g4-suite-$S7" >/dev/null 2>&1
  docker image rm "catus-g4-suite:$S7" >/dev/null 2>&1
  # Only our own mktemp directory (synthetic data and disposable secrets).
  case "$WORK" in */catus-g4.????????) rm -rf "$WORK" 2>/dev/null || docker run --rm -v "$WORK:/w" --entrypoint sh "$PW_IMAGE" -c 'rm -rf /w/* /w/.[!.]*' >/dev/null 2>&1 && rm -rf "$WORK" ;; esac
}
trap cleanup EXIT

# From here on every failure is recorded explicitly; never abort before the report.
set +e
echo "Catus OS G4 — SHA testado $SHA (checkout implantado $DEPLOYED)"
echo "Evidências: $OUT"
[ "$SHA" = "$DEPLOYED" ] || warn G4 "SHA testado difere do checkout implantado" "$DEPLOYED"

# =============================================================== A. real (read-only)
REAL_ENV="$REPO/deploy/.env" BEFORE="" SERVED=""
real_sql() {
  docker compose -f "$REPO/deploy/compose.yaml" --env-file "$REAL_ENV" exec -T db sh -c \
    'PGPASSWORD=$(cat /run/secrets/pg_admin_password) psql -XAtq -h 127.0.0.1 -U catus_admin -d catus -c "$0"' "$1"
}
SNAP="SELECT (SELECT system_identifier FROM pg_control_system())||' '||concat_ws(' ','organizations='||(SELECT count(*) FROM organizations),'users='||(SELECT count(*) FROM users),'memberships='||(SELECT count(*) FROM memberships),'clients='||(SELECT count(*) FROM clients),'projects='||(SELECT count(*) FROM projects),'interactions='||(SELECT count(*) FROM interactions),'requests='||(SELECT count(*) FROM requests),'contracts='||(SELECT count(*) FROM contracts),'time_entries='||(SELECT count(*) FROM time_entries),'audit_events='||(SELECT count(*) FROM audit_events))"
if [ $RUN_REAL = 1 ] && [ -f "$REAL_ENV" ]; then
  log "A. Instalação real (somente leitura)"
  (
    set -a && . "$REAL_ENV" && set +a
    printf '%s\n' "$CATUS_SECRETS_DIR" "$CATUS_BACKUP_DIR" "$CATUS_HOST_PORT"
  ) >"$WORK/real.vars"
  { read -r R_S && read -r R_B && read -r R_PORT; } <"$WORK/real.vars"
  if BEFORE=$(real_sql "$SNAP" 2>"$OUT/logs/real-snapshot.log"); then
    pass A "foto do banco real (somente leitura)" "${BEFORE#* }"
  else fail A "foto do banco real" "ver logs/real-snapshot.log"; fi
  # verify is read-only without --recreate; its PASS/FAIL lines become results.
  rc=0 && "$REPO/deploy/catus.sh" verify >"$OUT/logs/real-verify.log" 2>&1 || rc=$?
  while IFS= read -r l; do
    case "$l" in PASS*) pass A "${l#PASS  }" ;; FAIL*) fail A "${l#FAIL  }" ;; esac
  done <"$OUT/logs/real-verify.log"
  grep -q '^Summary:' "$OUT/logs/real-verify.log" || fail A "deploy/catus.sh verify não concluiu" "exit $rc, ver logs/real-verify.log"
  newest=$(find "$R_B" -maxdepth 1 -type f -name '*.catus' -printf '%T@ %f\n' 2>/dev/null | sort -n | tail -1)
  if [ -z "$newest" ]; then
    fail A "backup cifrado no diretório de backups" "nenhum .catus em $R_B"
  else
    age=$((($(date +%s) - ${newest%%.*}) / 3600))
    [ $age -le 26 ] && pass A "último backup com até 26 h" "${newest#* } (${age} h)" ||
      warn A "último backup com mais de 26 h" "${newest#* } (${age} h); agende deploy/catus.sh backup diário"
  fi
  if SERVED=$(curl -sS --max-time 10 --cacert "$R_S/tls/ca.crt" "https://localhost:$R_PORT/" 2>&1); then
    printf '%s' "$SERVED" >"$OUT/served-index.html"
  else fail A "frontend real acessível" "$SERVED" && SERVED=""; fi
elif [ $RUN_REAL = 1 ]; then
  fail A "instalação real encontrada" "$REAL_ENV ausente; use --skip-real em máquinas sem instalação"
else skip A "instalação real" "--skip-real"; fi

# =============================================================== B. isolated suite
SUITE_MARK='G4-SUITE-STEP'
if [ $RUN_SUITE = 1 ]; then
  log "B. Suíte isolada (contêiner sem rede, banco e identidades sintéticos)"
  mkdir -p "$WORK/src"
  git -C "$REPO" archive --format=tar "$SHA" | tar -x -C "$WORK/src"
  cat >"$WORK/src/.g4-suite.sh" <<'SUITE'
#!/usr/bin/env bash
# Runs inside the test container only (no network). Mirrors .github/workflows/ci.yml.
set -u
mkdir -p /home/pwuser/out/logs
step() {
  local name=$1 t0 rc=0
  shift
  t0=$(date +%s)
  "$@" >"/home/pwuser/out/logs/$name.log" 2>&1 || rc=$?
  echo "G4-SUITE-STEP $name $rc $(($(date +%s) - t0))"
}
step env-init npm run env:init
(npm run db >/home/pwuser/out/logs/postgres.log 2>&1 &)
step wait-db node_modules/.bin/bun scripts/wait-db.ts
step db-roles npm run db:roles
step migrate npm run migrate
step test-db npm run test:db
step sdk-contract npm run test:sdk-contract
step typecheck npm run check
step build npm run build
step bundle-budget npm run perf:budget
step tls-local npm run tls:local
# Without a Docker socket (deliberately): M5 runner files and the two pg_dump tests
# need Docker and are reported as SKIP; they stay mandatory in CI `validate`, and
# backup/restore is proven by stage C with the production tools image.
mapfile -t files < <(ls tests/*.test.ts | grep -v '^tests/delivery-' | sed 's#^#./#')
step unit-integration node_modules/.bin/bun test --preload ./tests/setup.ts "${files[@]}" \
  --test-name-pattern '^(?!.*(pg_dump restores|backup/restore preserves M4)).*'
step format npm run format:check
step journeys npm run test:e2e -- --grep-invert 'M5 M2-approved'
mv playwright-report /home/pwuser/out/journeys-report 2>/dev/null
mv test-results /home/pwuser/out/journeys-results 2>/dev/null
step quality npm run test:quality
mv playwright-report /home/pwuser/out/quality-report 2>/dev/null
mv test-results /home/pwuser/out/quality-results 2>/dev/null
cp dist/index.html /home/pwuser/out/dist-index.html 2>/dev/null
exit 0
SUITE
  cat >"$WORK/suite.Dockerfile" <<EOF
FROM $PW_IMAGE
USER pwuser
WORKDIR /home/pwuser/catus
COPY --chown=pwuser package.json package-lock.json ./
COPY --chown=pwuser runner/package.json runner/package-lock.json runner/
RUN npm ci --no-audit --no-fund && npm --prefix runner ci --ignore-scripts --no-audit --no-fund
COPY --chown=pwuser . .
EOF
  if run B suite-image docker build -t "catus-g4-suite:$S7" -f "$WORK/suite.Dockerfile" "$WORK/src"; then
    docker rm -f "catus-g4-suite-$S7" >/dev/null 2>&1 || true
    # No network: database, API, Vite and Chromium talk only over the container loopback.
    docker run --name "catus-g4-suite-$S7" --network none --cap-drop ALL \
      --security-opt no-new-privileges --memory 6g --pids-limit 4096 --shm-size 1g \
      "catus-g4-suite:$S7" bash .g4-suite.sh >"$OUT/logs/suite.log" 2>&1 || true
    docker cp "catus-g4-suite-$S7:/home/pwuser/out/." "$OUT/suite" >/dev/null 2>&1 || mkdir -p "$OUT/suite"
    docker rm -f "catus-g4-suite-$S7" >/dev/null 2>&1 || true
    while read -r mark name rc secs; do
      [ "$mark" = "$SUITE_MARK" ] || continue
      if [ "$rc" = 0 ]; then pass B "$name" "${secs}s"; else fail B "$name" "exit $rc em ${secs}s, ver suite/logs/$name.log"; fi
    done <"$OUT/logs/suite.log"
    grep -q "$SUITE_MARK quality" "$OUT/logs/suite.log" || fail B "suíte concluída" "interrompida; ver logs/suite.log"
    skip B "M5: tests/delivery-*.test.ts e e2e/zz-delivery.spec.ts" "M5 desligado no piloto; exigem Docker; obrigatórios no CI validate"
    skip B "pg_dump em operations/economics-api" "exigem Docker; obrigatórios no CI validate; backup/restore real provado no estágio C"
  fi
else skip B "suíte isolada" "--skip-suite"; fi

# =============================================================== C. disposable stack
digest_sql() { # whole-database fingerprint: per table row count and md5 of its rows
  cat <<'SQL'
SELECT string_agg(c.relname||'='||(xpath('/row/c/text()',q))[1]::text||':'||(xpath('/row/h/text()',q))[1]::text, ' ' ORDER BY c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
 LATERAL query_to_xml(format('SELECT count(*) c, md5(coalesce(string_agg(t::text,%L ORDER BY t::text),%L)) h FROM public.%I t',',','',c.relname),false,true,'') q
WHERE n.nspname='public' AND c.relkind='r' AND c.relname NOT IN ('rate_limits','oidc_transactions')
SQL
}
disp_sql() { # db name, sql
  dcg exec -T db sh -c 'PGPASSWORD=$(cat /run/secrets/pg_admin_password) psql -XAtq -v ON_ERROR_STOP=1 -h 127.0.0.1 -U catus_admin -d "$0" -c "$1"' "$1" "$2"
}
disp_healthy() {
  local svc i cid st
  for svc in "$@"; do
    for i in $(seq 1 60); do
      cid=$(dcg ps -q "$svc")
      st=$([ -n "$cid" ] && docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo none)
      [ "$st" = healthy ] && break
      [ "$i" -eq 60 ] && return 1
      sleep 2
    done
  done
}
DISP_INDEX=""
if [ $RUN_DISP = 1 ]; then
  log "C. Instalação descartável (projeto catus-g4, dados sintéticos)"
  mkdir -p "$WORK/secrets" "$WORK/backups" "$WORK/pgdata" && chmod 700 "$WORK/secrets" "$WORK/backups" "$WORK/pgdata"
  # Empty OIDC files: Compose needs them; empty means login blocked (as in catus.sh).
  : >"$WORK/secrets/oidc.env" && : >"$WORK/secrets/oidc_client_secret"
  cat >"$WORK/g4.env" <<EOF
CATUS_UID=$(id -u)
CATUS_GID=$(id -g)
CATUS_SECRETS_DIR=$WORK/secrets
CATUS_BACKUP_DIR=$WORK/backups
CATUS_HOST_PORT=$G4_PORT
CATUS_FRONTEND_SUBNET=$G4_SUBNET
CATUS_EDGE_IP=$G4_EDGE
CATUS_G4_PGDATA=$WORK/pgdata
CATUS_G4_TAG=$S7
EOF
  # Own images, own bind-mounted data directory; the real volume is not declared at all.
  cat >"$WORK/g4.override.yaml" <<'EOF'
services:
  db:
    image: catus-g4-postgres:${CATUS_G4_TAG}
    volumes: !override
      - type: bind
        source: ${CATUS_G4_PGDATA}
        target: /var/lib/postgresql
  edge: { image: 'catus-g4-app:${CATUS_G4_TAG}' }
  app: { image: 'catus-g4-app:${CATUS_G4_TAG}' }
  cleanup: { image: 'catus-g4-app:${CATUS_G4_TAG}' }
  init: { image: 'catus-g4-tools:${CATUS_G4_TAG}' }
  setup: { image: 'catus-g4-tools:${CATUS_G4_TAG}' }
  migrate: { image: 'catus-g4-tools:${CATUS_G4_TAG}' }
  backup: { image: 'catus-g4-tools:${CATUS_G4_TAG}' }
  restore-test: { image: 'catus-g4-tools:${CATUS_G4_TAG}' }
  google-setup: { image: 'catus-g4-tools:${CATUS_G4_TAG}' }
  bootstrap-admin: { image: 'catus-g4-tools:${CATUS_G4_TAG}' }
volumes: !reset {}
EOF
  # Disposable stack builds from the tested commit, not from the working tree.
  if [ ! -d "$WORK/src" ]; then mkdir -p "$WORK/src" && git -C "$REPO" archive --format=tar "$SHA" | tar -x -C "$WORK/src"; fi
  # Safety gate: the resolved configuration must not reference anything of the real install.
  why=""
  cfg=$(dcg --profile admin config 2>&1) || why="configuração inválida"
  printf '%s\n' "$cfg" >"$OUT/logs/disposable-config.yaml"
  grep -q '^name: catus-g4$' <<<"$cfg" || why="$why; projeto não é catus-g4"
  imgs=$(dcg --profile admin config --images 2>/dev/null | sort -u)
  bad=$(grep -vE '^catus-g4-(app|tools|postgres):' <<<"$imgs" | grep . || true)
  [ -n "$imgs" ] && [ -z "$bad" ] || why="$why; imagens fora de catus-g4-*: ${bad:-nenhuma resolvida}"
  [ -z "$(dcg --profile admin config --volumes 2>/dev/null)" ] || why="$why; declara volumes nomeados"
  grep -qF "source: $WORK/pgdata" <<<"$cfg" && ! grep -q 'catus_pgdata' <<<"$cfg" || why="$why; dados do banco fora do diretório temporário"
  [ -z "${R_S:-}" ] || ! grep -qF "$R_S" <<<"$cfg" || why="$why; referencia o diretório de segredos real"
  [ -z "$(docker ps -aq --filter label=com.docker.compose.project=catus-g4)" ] || why="$why; há contêineres catus-g4 de outra execução (docker compose -p catus-g4 down)"
  ! ss -ltnH "sport = :$G4_PORT" | grep -q . || why="$why; porta $G4_PORT ocupada (CATUS_G4_PORT=<outra>)"
  if [ -n "$why" ]; then
    fail C "isolamento do projeto descartável" "${why#; }; ver logs/disposable-config.yaml"
  else
    pass C "isolamento do projeto descartável" "projeto catus-g4, imagens catus-g4-*:$S7, dados em diretório temporário, porta 127.0.0.1:$G4_PORT"
    DISP_UP=1
    S="$WORK/secrets" CA="$WORK/secrets/tls/ca.crt" BASE="https://localhost:$G4_PORT"
    ok=1
    run C build-images dcg --profile admin build || ok=0
    [ $ok = 1 ] && { run C init-secrets dcg run --rm init || ok=0; }
    [ $ok = 1 ] && { run C start-db dcg up -d db && disp_healthy db || ok=0; }
    [ $ok = 1 ] && { run C least-privilege-roles dcg run --rm setup || ok=0; }
    [ $ok = 1 ] && { run C migrations dcg run --rm migrate || ok=0; }
    [ $ok = 1 ] && { run C start-services dcg up -d || ok=0; }
    if [ $ok = 1 ] && disp_healthy db edge app cleanup; then
      pass C "db, edge, app e cleanup saudáveis"
      c=$(curl -sS --max-time 5 --cacert "$CA" "$BASE/api/auth/config" 2>&1 || true)
      [ "$c" = '{"configured":false}' ] && pass C "HTTPS com CA própria; sem OIDC o login fica bloqueado" "$c" || fail C "HTTPS/auth config" "$c"
      c=0 && curl -s --max-time 5 -o /dev/null "$BASE/api/auth/config" || c=$?
      [ "$c" = 60 ] && pass C "CA desconhecida rejeitada (curl 60)" || fail C "requisição sem CA" "curl exit $c"
      c=$(curl -sI --max-time 5 --cacert "$CA" "$BASE/")
      for h in strict-transport-security content-security-policy x-frame-options x-content-type-options; do
        grep -qi "^$h:" <<<"$c" && pass C "cabeçalho $h" || fail C "cabeçalho $h ausente"
      done
      c=$(curl -s --max-time 5 --cacert "$CA" -o /dev/null -w '%{http_code}' -X POST -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -d '{}' "$BASE/api/clients")
      [ "$c" = 403 ] && pass C "Origin forjada recusada (403)" || fail C "Origin forjada" "HTTP $c"
      c=$(curl -s --max-time 5 --cacert "$CA" -o /dev/null -w '%{http_code}' "$BASE/api/session")
      [ "$c" = 401 ] || [ "$c" = 503 ] && pass C "API sem sessão recusada ($c)" || fail C "API sem sessão" "HTTP $c"
      c=$(ss -ltnH "sport = :$G4_PORT" | awk '{print $4}' | sort -u | tr '\n' ' ')
      [ "$c" = "127.0.0.1:$G4_PORT " ] && pass C "escuta somente em 127.0.0.1:$G4_PORT" || fail C "listeners" "$c"
      [ "$(docker network inspect catus-g4_backend -f '{{.Internal}}')" = true ] && pass C "rede do banco interna (sem saída)" || fail C "rede do banco não é interna"
      [ -z "$(docker inspect "$(dcg ps -q db)" -f '{{range $p,$b := .HostConfig.PortBindings}}{{$p}}{{end}}')" ] && pass C "banco sem porta publicada" || fail C "banco publica porta"
      c=$(disp_sql catus "SELECT string_agg(name,',' ORDER BY name) FROM schema_migrations")
      [ "$c" = "$(cd "$WORK/src/db/migrations" && ls ./*.sql | sed 's#./##' | paste -sd, -)" ] && pass C "todas as migrations aplicadas" "$c" || fail C "migrations" "$c"
      c=$(disp_sql catus "SELECT count(*)||':'||coalesce(string_agg(rolname,','),'') FROM pg_roles WHERE rolname LIKE 'catus\_%' AND rolname<>'catus_admin' AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls)")
      [ "$c" = "0:" ] && pass C "papéis da aplicação sem privilégios elevados" || fail C "papéis privilegiados" "$c"
      tmp=$(mktemp "$S/.refuse.XXXXXX") && cat "$S/migrator_database_url" >"$tmp"
      # Bounded: if the refusal ever regressed, the server would otherwise run forever.
      c=$(G4_TIMEOUT=90 dcg run --rm --no-deps -e PORT=3445 -v "$tmp:/run/secrets/runtime_database_url:ro" app 2>&1 || true) && rm -f "$tmp"
      grep -q 'excessive privileges' <<<"$c" && pass C "runtime recusa credencial do migrator" || fail C "runtime aceitou credencial do migrator"
      for id in $(dcg ps -q); do
        c=$(docker inspect -f '{{.Name}} {{.Config.User}} {{.HostConfig.Privileged}} {{.HostConfig.CapDrop}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.SecurityOpt}}' "$id")
        [[ $c == *" false [ALL] true [no-new-privileges:true]" && $c != *" 0:"* && $c != *" root"* ]] && pass C "contêiner endurecido ${c%% *}" || fail C "endurecimento" "$c"
      done
      c=$(dcg exec -T app sh -c 'tr "\0" "\n" </proc/1/environ | grep -E "^(LLM_ENABLED|DELIVERY_ENABLED)=" || true' | sort | tr '\n' ' ')
      [ "$c" = "DELIVERY_ENABLED=false LLM_ENABLED=false " ] && pass C "M2 e M5 desligados" || fail C "flags M2/M5" "$c"
      DISP_INDEX=$(curl -sS --max-time 5 --cacert "$CA" "$BASE/" || true)
      # ---- persistence, backup and restore with synthetic data
      o=$(cat /proc/sys/kernel/random/uuid) u=$(cat /proc/sys/kernel/random/uuid) cl=$(cat /proc/sys/kernel/random/uuid) pr=$(cat /proc/sys/kernel/random/uuid)
      if disp_sql catus "BEGIN; INSERT INTO organizations(id,name) VALUES('$o','G4 Sintética'); INSERT INTO users(id,issuer,email,display_name) VALUES('$u','https://g4.invalid','g4@example.invalid','Pessoa Sintética'); INSERT INTO memberships(user_id,organization_id,role) VALUES('$u','$o','po'); INSERT INTO clients(id,name,organization_id) VALUES('$cl','Cliente Sintético','$o'); INSERT INTO projects(id,client_id,name,organization_id) VALUES('$pr','$cl','Projeto Sintético','$o'); COMMIT;" >"$OUT/logs/disposable-seed.log" 2>&1; then
        pass C "dados sintéticos inseridos"
      else fail C "dados sintéticos" "ver logs/disposable-seed.log"; fi
      D0=$(disp_sql catus "$(digest_sql)")
      run C backup dcg run --rm backup || true
      bk=$(find "$WORK/backups" -maxdepth 1 -type f -name '*.catus' | head -1)
      if [ -n "$bk" ]; then
        pass C "backup cifrado gerado" "$(stat -c %s "$bk") bytes"
        # pg_dump custom archives start with PGDMP; inside the AES-GCM stream it never appears.
        grep -qa PGDMP "$bk" && fail C "backup contém um arquivo pg_dump em claro" || pass C "backup cifrado (nenhum cabeçalho pg_dump em claro)"
        if run C restore-test dcg run --rm restore-test restore-test "/backups/$(basename "$bk")"; then
          rdb=$(grep -oE 'catus_r[0-9]+_restore_test' "$OUT/logs/restore-test.log" | tail -1)
          D1=$(disp_sql "$rdb" "$(digest_sql)" 2>&1 || true)
          [ -n "$D0" ] && [ "$D0" = "$D1" ] && pass C "restauração idêntica ao original" "$(wc -w <<<"$D0") tabelas comparadas por contagem e md5" ||
            { fail C "restauração difere do original" "ver logs/restore-diff.log" && diff <(tr ' ' '\n' <<<"$D0") <(tr ' ' '\n' <<<"$D1") >"$OUT/logs/restore-diff.log" || true; }
        fi
        cp "$bk" "$WORK/backups/tampered.catus" && printf '\x00' | dd of="$WORK/backups/tampered.catus" bs=1 seek=$(($(stat -c %s "$bk") / 2)) conv=notrunc status=none
        printf '\xff' | dd of="$WORK/backups/tampered.catus" bs=1 seek=$(($(stat -c %s "$bk") / 2 + 1)) conv=notrunc status=none
        # Must fail on GCM authentication, before pg_restore runs (not for an unrelated reason).
        if dcg run --rm restore-test restore-test /backups/tampered.catus >"$OUT/logs/restore-tampered.log" 2>&1; then
          fail C "arquivo de backup adulterado foi aceito"
        elif grep -q 'unable to authenticate' "$OUT/logs/restore-tampered.log"; then
          pass C "arquivo de backup adulterado rejeitado na autenticação (antes do pg_restore)"
        else fail C "restauração do arquivo adulterado falhou por outro motivo" "ver logs/restore-tampered.log"; fi
      else fail C "backup cifrado gerado" "nenhum arquivo"; fi
      run C recreate-containers dcg up -d --force-recreate && { disp_healthy db edge app cleanup || fail C "saudáveis após recriar"; }
      [ -n "$D0" ] && [ "$(disp_sql catus "$(digest_sql)")" = "$D0" ] && pass C "dados preservados após recriar contêineres" || fail C "dados mudaram após recriar contêineres"
      run C down-up dcg down && run C up-again dcg up -d && { disp_healthy db edge app cleanup || fail C "saudáveis após down/up"; }
      [ -n "$D0" ] && [ "$(disp_sql catus "$(digest_sql)")" = "$D0" ] && pass C "dados preservados após down (sem -v) e up" || fail C "dados mudaram após down/up"
      run C restart-db dcg restart db && { disp_healthy db || fail C "banco saudável após reinício"; }
      c=""
      for i in $(seq 1 30); do
        c=$(curl -s --max-time 5 --cacert "$CA" "$BASE/api/auth/config" || true)
        [ "$c" = '{"configured":false}' ] && break
        sleep 2
      done
      [ "$c" = '{"configured":false}' ] && pass C "aplicação se recupera após reinício do PostgreSQL" "${i} tentativa(s)" || fail C "sem recuperação após reinício do PostgreSQL" "$c"
      dcg logs --no-color >"$OUT/logs/disposable-services.log" 2>&1 || true
      leak=0
      for f in pg_admin_password runtime_database_url migrator_database_url maintenance_database_url; do
        v=$(sed -E 's#.*://[^:]+:([^@]+)@.*#\1#' "$S/$f") && grep -qF "$v" "$OUT/logs/disposable-services.log" && leak=1
      done
      [ $leak = 0 ] && pass C "nenhum segredo nos logs dos serviços" || fail C "segredo encontrado nos logs dos serviços"
    elif [ $ok = 1 ]; then
      fail C "serviços saudáveis" "ver logs/disposable-services.log" && dcg logs --no-color >"$OUT/logs/disposable-services.log" 2>&1 || true
    fi
  fi
else skip C "instalação descartável" "--skip-disposable"; fi

# =============================================================== cross checks
if [ -n "$SERVED" ]; then
  ref="$DISP_INDEX"
  [ -n "$ref" ] || ref=$(cat "$OUT/suite/dist-index.html" 2>/dev/null || true)
  if [ -z "$ref" ]; then
    skip A "frontend servido = build do SHA testado" "sem build de referência"
  elif [ "$SHA" != "$DEPLOYED" ]; then
    skip A "frontend servido = build do SHA testado" "SHA testado não é o implantado"
  elif [ "$(sha256sum <<<"$SERVED")" = "$(sha256sum <<<"$ref")" ]; then
    pass A "frontend servido = build do SHA testado" "$(grep -oE '/assets/index-[^"]+\.js' <<<"$SERVED" | head -1)"
  else fail A "frontend servido difere do build do SHA testado" "rode deploy/catus.sh update no SHA testado"; fi
fi
if [ -n "$BEFORE" ]; then
  AFTER=$(real_sql "$SNAP" 2>/dev/null || true)
  read -r CB RB <<<"$BEFORE"
  read -r CA_ RA <<<"$AFTER"
  dec=""
  for kv in $RB; do
    k=${kv%%=*} v=${kv#*=} n=$(tr ' ' '\n' <<<"$RA" | sed -n "s/^$k=//p")
    [ -n "$n" ] && [ "$n" -ge "$v" ] || dec="$dec $k:$v->${n:-?}"
  done
  [ "$CB" = "$CA_" ] && [ -z "$dec" ] && pass A "banco real intacto após o G4" "mesmo cluster; nenhuma contagem diminuiu" ||
    fail A "banco real mudou durante o G4" "cluster ${CB:0:8}->${CA_:0:8}$dec"
fi

# =============================================================== report
NP=$(grep -c $'\tPASS\t' "$RES" || true) NF=$(grep -c $'\tFAIL\t' "$RES" || true)
NW=$(grep -c $'\tWARN\t' "$RES" || true) NS=$(grep -c $'\tSKIP\t' "$RES" || true)
VERDICT=GO
[ "$NF" -eq 0 ] || VERDICT=NO-GO
[ $RUN_REAL = 1 ] && [ $RUN_SUITE = 1 ] && [ $RUN_DISP = 1 ] || VERDICT="$VERDICT (parcial: estágios ignorados)"
counts() { # log file → "N passed/failed" summary from Bun or Playwright
  [ -f "$1" ] || return 0
  grep -hE '^\s*[0-9]+ (pass|fail|passed|failed|flaky|skipped)$' "$1" | sed 's/^ *//' | paste -sd, - || true
}
PERF=$(grep -ohE 'perf runtime \{.*\}' "$OUT/suite/logs/quality.log" 2>/dev/null | tail -1 | sed 's/^perf runtime //')
BUNDLE=$(grep -vE '^\s*$|^>' "$OUT/suite/logs/bundle-budget.log" 2>/dev/null | tail -8)
{
  echo "# Catus OS — relatório G4: **$VERDICT**"
  echo
  echo "| Item | Valor |"
  echo "| --- | --- |"
  echo "| SHA testado | \`$SHA\` |"
  echo "| Checkout implantado | \`$DEPLOYED\` |"
  echo "| Início / fim (UTC) | $STARTED / $(date -u +%FT%TZ) |"
  echo "| Host | $(uname -sr), Docker $(docker version -f '{{.Server.Version}}' 2>/dev/null), Compose $(docker compose version --short 2>/dev/null) |"
  echo "| Resultado | $NP PASS, $NF FAIL, $NW WARN, $NS SKIP |"
  echo
  echo "Critério: GO somente com 0 FAIL nos três estágios. WARN não bloqueia, mas exige ação."
  echo
  echo "## Bloqueios (FAIL)"
  echo
  if [ "$NF" -eq 0 ]; then echo "Nenhum."; else awk -F'\t' '$2=="FAIL"{printf "- [%s] %s — %s\n",$1,$3,$4}' "$RES"; fi
  echo
  echo "## Avisos (WARN)"
  echo
  if [ "$NW" -eq 0 ]; then echo "Nenhum."; else awk -F'\t' '$2=="WARN"{printf "- [%s] %s — %s\n",$1,$3,$4}' "$RES"; fi
  echo
  echo "## Testes automatizados (estágio B)"
  echo
  echo "| Suíte | Resultado |"
  echo "| --- | --- |"
  echo "| Bun (unidade + integração, banco descartável) | $(counts "$OUT/suite/logs/unit-integration.log") |"
  echo "| Playwright journeys (4 papéis, OIDC simulado) | $(counts "$OUT/suite/logs/journeys.log") |"
  echo "| Playwright quality (visual, a11y, responsivo, teclado, estados, desempenho) | $(counts "$OUT/suite/logs/quality.log") |"
  echo
  echo "Desempenho em execução (mediana de 3, orçamento em perf-budget.json): \`${PERF:-n/d}\`"
  echo
  echo '```'
  echo "${BUNDLE:-orçamento de bundle: n/d}"
  echo '```'
  echo
  echo "## Fluxos verificados"
  echo
  echo "| # | Fluxo | Evidência |"
  echo "| --- | --- | --- |"
  echo "| 1 | Saúde dos contêineres e PostgreSQL | A: verify; C: healthchecks, recuperação após reinício do banco |"
  echo "| 2 | HTTPS, OIDC e configurações de segurança | A: verify + Google; C: CA, cabeçalhos, Origin, sessão, papéis, endurecimento |"
  echo "| 3 | Login e autorização dos quatro papéis | B: tests/api.test.ts, google-pilot.test.ts, journeys, quality/navigation (OIDC simulado, só no harness) |"
  echo "| 4 | Cliente → projeto → atendimento → solicitação | B: workflow.spec.ts, pilot-journey.spec.ts, api.test.ts |"
  echo "| 5 | Triagem, atribuição, estados e bloqueios | B: workflow.spec.ts, operations.test.ts, domain.test.ts |"
  echo "| 6 | Contratos, escopos, alçadas e cobertura comercial | B: commercial.test.ts, commercial.spec.ts, zz-states.spec.ts |"
  echo "| 7 | Execução e apontamento de horas | B: economics-api.test.ts, economics.spec.ts |"
  echo "| 8 | Premissas, custos, capacidade e rentabilidade | B: economics-engine.test.ts, economics-api.test.ts, economics.spec.ts |"
  echo "| 9 | Auditoria, integridade e isolamento entre organizações | B: api/commercial/economics tests (outra organização), a11y auditoria; C: restauração bit a bit |"
  echo "| 10 | Navegação, UX, acessibilidade, responsividade, regressão visual | B: quality (axe WCAG 2.2 AA, 5 larguras, teclado, baselines exatas) |"
  echo "| 11 | Erros, conflitos concorrentes e recuperação | B: versões/idempotência/429 nos testes Bun, zz-states.spec.ts; C: reinício do banco |"
  echo "| 12 | Persistência, backup e restauração | C: backup cifrado, restauração idêntica, adulteração rejeitada, recriar e down/up |"
  echo
  echo "## Todas as verificações"
  echo
  echo "| Estágio | Status | Verificação | Detalhe |"
  echo "| --- | --- | --- | --- |"
  awk -F'\t' '{gsub(/\|/,"/",$4); printf "| %s | %s | %s | %s |\n",$1,$2,$3,$4}' "$RES"
  echo
  echo "## Evidências"
  echo
  echo "- Logs: \`logs/\` (real-verify, suite, disposable-*), \`suite/logs/\` (um por etapa)"
  echo "- Relatórios Playwright: \`suite/journeys-report/\`, \`suite/quality-report/\` (diffs, traces, axe e desempenho em \`suite/*-results/\`)"
  echo "- Nenhum cookie, token ou segredo é coletado; dados apenas sintéticos fora do estágio A (somente leitura, contagens agregadas)."
  echo
  echo "## Aprovação humana (não automatizável)"
  echo
  echo "- [ ] Login Google real de cada pessoa da equipe com a conta autorizada (o G4 só prova o OIDC até a tela do Google)."
  echo "- [ ] Cada papel real vê somente seus módulos (desenvolvedor: \`#/auditoria\` mostra **Acesso restrito**)."
  echo "- [ ] Leitura do relatório e decisão GO/NO-GO pelo responsável."
} >"$OUT/REPORT.md"
echo
echo "Resultado: $VERDICT — $NP PASS, $NF FAIL, $NW WARN, $NS SKIP"
echo "Relatório: $OUT/REPORT.md"
[ "$NF" -eq 0 ]
