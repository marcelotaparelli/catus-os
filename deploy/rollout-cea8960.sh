#!/usr/bin/env bash
# Catus OS: atualização controlada da homologação de 75a9c14 para cea8960.
#
#   bash ~/catus-rollout-cea8960.sh check                       somente leitura; nada muda
#   bash ~/catus-rollout-cea8960.sh run AUTORIZO-cea8960        executa, se houver autorização
#   bash ~/catus-rollout-cea8960.sh rollback AUTORIZO-ROLLBACK-cea8960
#                                                               volta a aplicação; não toca no banco
#
# Roda de fora do checkout, porque o checkout muda de commit e o arquivo não existe em cea8960.
# Para no primeiro problema. Nunca usa reset --hard, clean, stash pop, down -v, volume rm,
# prune ou admin-bootstrap, e não apaga nada.
# Critérios para autorizar e plano: docs/ROLLOUT_FOLLOWUP.md.
set -Eeuo pipefail
umask 077
SHA=cea89601399c2d272f9761ac6fbbf1524e4c89c9
TREE=ea3be74aeae4580d99744fdc1d1ac3cf33b756c9
PREV=75a9c149cb8fa1613849ed8fce69b8741e3015a6
PREV_TREE=e18993b90a1e4af15c0d56957bdf519e3f12b644
BRANCH=feat/pilot-oidc
ORIGIN=https://github.com/marcelotaparelli/catus-os.git
NEW_MIGRATION=010_demand_followup.sql
EXPECTED_DIFF='db/migrations/010_demand_followup.sql
deploy/g4.sh'
RUN_TOKEN=AUTORIZO-cea8960
ROLLBACK_TOKEN=AUTORIZO-ROLLBACK-cea8960
REPO="${CATUS_REPO:-$HOME/sandboxes/agent/projects/catus-os-m5}"
NEED_KB=$((8 * 1024 * 1024))
SWEEP_WAIT_S=480
TS="$(date -u +%Y%m%dT%H%M%SZ)"
MODE="${1:-}"
TOKEN="${2:-}"
case "$MODE" in
check) ;;
run) [ "$TOKEN" = "$RUN_TOKEN" ] || { echo "PARADO: run exige a autorização explícita. Nada foi alterado."; exit 2; } ;;
rollback) [ "$TOKEN" = "$ROLLBACK_TOKEN" ] || { echo "PARADO: rollback exige a autorização explícita. Nada foi alterado."; exit 2; } ;;
*) echo "uso: $0 check | run $RUN_TOKEN | rollback $ROLLBACK_TOKEN"; exit 2 ;;
esac
OUT="$HOME/catus-rollout-$TS"
mkdir -p "$OUT"
LOG="$OUT/log.txt"
exec > >(tee -a "$LOG") 2>&1
step() { printf '\n=== %s\n' "$*"; }
ok() { echo "OK  $*"; }
STAGE="antes de qualquer alteração"
AFTER_STOP=""
stop() {
  printf '\nPARADO: %s\nEstado: %s\nLog: %s\nNada foi apagado.\n%s\n' "$*" "$STAGE" "$LOG" "$AFTER_STOP"
  exit 2
}
trap 'stop "comando falhou na linha $LINENO"' ERR
case "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/" in
"$(cd "$REPO" 2>/dev/null && pwd -P)"/*) stop "copie o script para fora do checkout antes de executar" ;;
esac
[ -d "$REPO/.git" ] || stop "checkout não encontrado em $REPO"
cd "$REPO"
ENV_FILE="$REPO/deploy/.env"
dc() { docker compose -f "$REPO/deploy/compose.yaml" --env-file "$ENV_FILE" "$@"; }
sql_in() {
  dc exec -T db sh -c 'PGPASSWORD=$(cat /run/secrets/pg_admin_password) psql -XAtq -v ON_ERROR_STOP=1 -h 127.0.0.1 -U catus_admin -d "$1" -c "$0"' "$2" "$1"
}
sql() { sql_in catus "$1"; }

# SQL-BEGIN
TRANSIENT_TABLES="'sessions','oidc_transactions','rate_limits','idempotency_keys'"
# Written by the running automation; compared by their invariants, as deploy/g4.sh does.
NEW_TABLES="'request_events','automation_jobs','demand_alerts'"
# The columns of requests before migration 010. New columns are checked on their own.
REQUESTS_OLD="id,interaction_id,title,description,status,owner,next_action,version,created_at,updated_at,organization_id,owner_user_id,origin_proposal_id,suggested_acceptance_criteria,scope_item_id"
# Content of every business table: rows and md5, no data leaves the database.
DIGEST="SELECT * FROM (SELECT table_name||'='||(xpath('/row/d/text()',query_to_xml(format('SELECT count(*)||'':''||coalesce(md5(string_agg(t::text,''|'' ORDER BY t::text)),''-'') d FROM %I t',table_name),false,true,'')))[1]::text FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name NOT IN ($TRANSIENT_TABLES,$NEW_TABLES,'requests','schema_migrations') UNION ALL SELECT 'requests='||count(*)||':'||coalesce(md5(string_agg(t::text,'|' ORDER BY t::text)),'-') FROM (SELECT $REQUESTS_OLD FROM requests) t) d ORDER BY 1"
COUNTS="SELECT table_name||'='||(xpath('/row/c/text()',query_to_xml(format('SELECT count(*) c FROM %I',table_name),false,true,'')))[1]::text FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1"
# Cluster identity and the history that existed before this rollout: never rewritten.
IDENTITY="SELECT (SELECT system_identifier FROM pg_control_system())||'|'||(SELECT string_agg(name||'@'||applied_at,',' ORDER BY name) FROM schema_migrations WHERE name<>'010_demand_followup.sql')"
MIGRATIONS="SELECT string_agg(name,',' ORDER BY name) FROM schema_migrations"
# restore-test leaves its *_restore_test database by design; any other new one is a parallel database.
DATABASES="SELECT string_agg(datname,',' ORDER BY datname) FROM pg_database WHERE datname !~ '_restore_test\$'"
NOT_MIGRATED="SELECT (to_regclass('public.request_events') IS NULL AND to_regclass('public.automation_jobs') IS NULL AND to_regclass('public.demand_alerts') IS NULL AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='requests' AND column_name IN ('template','follow_up_on','blocked_reason','waiting_on')))"
OPEN_WITHOUT="SELECT count(*) FILTER (WHERE owner_user_id IS NULL)||' sem responsável; '||count(*)||' abertas' FROM requests WHERE status<>'done'"
OPEN_DEMANDS="SELECT count(*) FROM requests WHERE status<>'done'"
ACTIVE_SESSIONS="SELECT count(*) FROM sessions WHERE revoked_at IS NULL AND expires_at>now() AND last_seen_at>now()-interval '30 minutes'"
# Nothing may be filled in by the migration, and nobody may have used the system meanwhile.
FILLED="SELECT count(*) FROM requests WHERE template IS NOT NULL OR follow_up_on IS NOT NULL OR blocked_reason IS NOT NULL OR waiting_on IS NOT NULL"
EVENTS="SELECT count(*) FROM request_events"
REQUEST_JOBS="SELECT count(*) FROM automation_jobs WHERE kind='evaluate_request'"
FAILED_JOBS="SELECT count(*) FROM automation_jobs WHERE state='failed'"
ORGS_PENDING="SELECT count(*) FROM organizations o WHERE NOT EXISTS(SELECT 1 FROM automation_jobs j WHERE j.organization_id=o.id AND j.kind='sweep' AND j.state='done')"
ORGS_PENDING_AFTER() { echo "SELECT count(*) FROM organizations o WHERE NOT EXISTS(SELECT 1 FROM automation_jobs j WHERE j.organization_id=o.id AND j.kind='sweep' AND j.state='done' AND j.created_at>'$1')"; }
NOW="SELECT clock_timestamp()"
NO_FOLLOW_UP_ALERTS="SELECT count(*) FROM demand_alerts WHERE kind='no_follow_up' AND resolved_at IS NULL"
ALERTS_ON_DONE="SELECT count(*) FROM demand_alerts a JOIN requests r ON r.id=a.request_id WHERE a.resolved_at IS NULL AND r.status='done'"
OPEN_ALERTS="SELECT id||' '||request_id||' '||kind FROM demand_alerts WHERE resolved_at IS NULL ORDER BY id"
ALERTS_BY_KIND="SELECT kind||'='||count(*) FROM demand_alerts WHERE resolved_at IS NULL GROUP BY kind ORDER BY kind"
# Same invariants as deploy/g4.sh: must be 0.
DERIVED_BROKEN="SELECT (SELECT count(*) FROM (SELECT 1 FROM demand_alerts WHERE resolved_at IS NULL GROUP BY request_id,kind HAVING count(*)>1) d)+(SELECT count(*) FROM demand_alerts WHERE resolved_at<opened_at OR acknowledged_at<opened_at)+(SELECT count(*) FROM automation_jobs WHERE (state='done' AND finished_at IS NULL) OR attempts<0)+(SELECT count(*) FROM (SELECT 1 FROM automation_jobs GROUP BY organization_id,dedupe_key HAVING count(*)>1) d)+(2-(SELECT count(*) FROM pg_index i WHERE i.indisvalid AND i.indisunique AND i.indexrelid IN ('demand_alerts_one_open'::regclass,'automation_jobs_organization_id_dedupe_key_key'::regclass)))"
TRIGGER_ON="SELECT count(*) FROM pg_trigger WHERE tgname='request_change_events' AND tgenabled='O'"
M2_ON="SELECT count(*) FROM ai_policies WHERE enabled"
M5_ON="SELECT count(*) FROM delivery_policies WHERE enabled"
# SQL-END

SERVICES='db edge app cleanup'
LABEL=com.docker.compose
label() { docker inspect --format "{{index .Config.Labels \"$LABEL.$2\"}}" "$1"; }
secret_sources() {
  docker inspect --format '{{range .Mounts}}{{.Destination}}={{.Source}}{{println}}{{end}}' "$1" | grep '^/run/secrets/' | cut -d= -f2- || true
}
secrets_fingerprint() {
  (cd "$CATUS_SECRETS_DIR" && find . -type f | LC_ALL=C sort | xargs -r sha256sum | sha256sum | cut -d' ' -f1)
}
# Everything that must not change, in one comparable file. Hashes only, never a secret.
install_state() {
  echo "cluster+migrations=$(sql "$IDENTITY")"
  echo "databases=$(sql "$DATABASES")"
  echo "secrets=$(secrets_fingerprint)"
  echo "env=$(sha256sum "$ENV_FILE" | cut -d' ' -f1)"
  echo "compose-config=$(dc config | sha256sum | cut -d' ' -f1)"
  echo "edge-port=$(docker port "$(dc ps -q edge)" | LC_ALL=C sort | tr '\n' ' ')"
  echo "volumes=$(docker volume ls --quiet --filter "label=$LABEL.project=catus" | LC_ALL=C sort | tr '\n' ' ')"
  echo "networks=$(docker network ls --format '{{.Name}}' --filter "label=$LABEL.project=catus" | LC_ALL=C sort | tr '\n' ' ')"
  echo "volume-users=$(docker ps -a --filter volume=catus_pgdata --format '{{.Label "'"$LABEL"'.project"}}/{{.Label "'"$LABEL"'.service"}}' | LC_ALL=C sort | tr '\n' ' ')"
}
baseline() {
  install_state >"$OUT/state-before.txt"
  sql "$DIGEST" >"$OUT/digest-before.txt"
}
check_unchanged() { # moment
  install_state >"$OUT/state-$1.txt"
  diff "$OUT/state-before.txt" "$OUT/state-$1.txt" || stop "a identidade, os segredos, a configuração ou os recursos da instalação mudaram ($1)"
  sql "$DIGEST" >"$OUT/digest-$1.txt"
  diff "$OUT/digest-before.txt" "$OUT/digest-$1.txt" >/dev/null || {
    diff "$OUT/digest-before.txt" "$OUT/digest-$1.txt" | cut -d= -f1 || true
    stop "o conteúdo de tabelas de negócio mudou ($1)"
  }
  sql "$COUNTS" >"$OUT/counts-$1.txt"
  ok "cluster, histórico de migrations, conteúdo, segredos, configuração e recursos idênticos ($1)"
}
all_healthy() {
  local svc id state
  for svc in $SERVICES; do
    id="$(dc ps -q "$svc")"
    [ -n "$id" ] || { echo "sem container: $svc"; return 1; }
    state="$(docker inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}sem-healthcheck{{end}}' "$id")"
    echo "$svc: $state"
    [ "$state" = running/healthy ] || return 1
  done
}
wait_healthy() {
  local until_s=$((SECONDS + ${HEALTH_WAIT_S:-300}))
  until all_healthy; do
    [ "$SECONDS" -lt "$until_s" ] || return 1
    sleep 5
  done
}
tree_of() { git rev-parse "$1^{tree}" 2>/dev/null || true; }
migrations_at() { git ls-tree --name-only "$1" db/migrations/ | xargs -n1 basename | LC_ALL=C sort | paste -sd, -; }

# Read-only. Proves the same invariants as the last rollout: one project, one volume, the
# original database, the existing secrets, and a checkout that resolves to that installation.
inspect_installation() {
  [ "$(id -u)" -ne 0 ] || stop "execute com seu usuário normal do grupo docker, não como root"
  local t dir FREE svc id name src
  for t in git docker curl sha256sum; do command -v "$t" >/dev/null || stop "ferramenta ausente: $t"; done
  docker info >/dev/null 2>&1 || stop "Docker inacessível"
  docker compose version >/dev/null 2>&1 || stop "Docker Compose v2 ausente"
  [ -f "$ENV_FILE" ] || stop "deploy/.env ausente: esta instalação não é a esperada"
  set -a && . "$ENV_FILE" && set +a
  [ -d "$CATUS_SECRETS_DIR" ] || stop "segredos não encontrados em $CATUS_SECRETS_DIR"
  [ -s "$CATUS_SECRETS_DIR/backup.key" ] || stop "chave de backup ausente"
  [ -s "$CATUS_SECRETS_DIR/tls/ca.crt" ] || stop "CA local ausente"
  [ -d "$CATUS_BACKUP_DIR" ] || stop "pasta de backups ausente"
  DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}')"
  for dir in "$REPO" "$DOCKER_ROOT" "$HOME"; do
    FREE=$(df -Pk "$dir" | awk 'NR==2{print $4}')
    [ "$FREE" -ge "$NEED_KB" ] || stop "menos de 8 GB livres em $dir"
  done
  ok "ferramentas, chave de backup, CA e espaço em disco"
  docker volume inspect catus_pgdata >/dev/null 2>&1 || stop "volume catus_pgdata não encontrado"
  dc ps
  all_healthy || stop "instalação atual não está saudável; investigue antes"
  ok "$SERVICES saudáveis"
  DB_ID="$(dc ps -q db)"
  DB_DIR="$(label "$DB_ID" project.working_dir)"
  INSTALL_ROOT="${DB_DIR%/deploy}"
  for svc in $SERVICES; do
    id="$(dc ps -q "$svc")"
    [ "$(echo "$id" | wc -l)" = 1 ] || stop "mais de um container para $svc"
    name="$(label "$id" project)"
    dir="$(label "$id" project.working_dir)"
    echo "ativo: $svc → projeto $name, origem $dir"
    [ "$name" = catus ] || stop "$svc pertence ao projeto '$name', não a catus"
    if [ "$svc" != db ]; then
      [ "$dir" = "$REPO/deploy" ] || stop "$svc veio de $dir, não deste checkout ($REPO/deploy)"
      [ "$(label "$id" project.config_files)" = "$REPO/deploy/compose.yaml" ] || stop "$svc usa outro arquivo Compose"
    fi
    for src in $(secret_sources "$id"); do
      case "$src" in
      "$CATUS_SECRETS_DIR"/*) ;;
      *) stop "$svc usa o segredo $src, fora de $CATUS_SECRETS_DIR" ;;
      esac
    done
  done
  ok "os quatro serviços estão no projeto catus, com os segredos da instalação"
  if [ "$INSTALL_ROOT" != "$REPO" ]; then
    [ "$(basename "$INSTALL_ROOT")" = catus-os-g2 ] && [ "$(basename "$REPO")" = catus-os-m5 ] &&
      [ "$(dirname "$INSTALL_ROOT")" = "$(dirname "$REPO")" ] ||
      stop "origem do PostgreSQL inesperada: $DB_DIR (aceitos: este checkout ou catus-os-g2 ao lado de catus-os-m5)"
    echo "PostgreSQL criado por catus-os-g2; aplicação por catus-os-m5: aceito só com as provas abaixo"
  fi
  DB_VOLUME="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{.Type}}:{{.Name}}{{end}}{{end}}' "$DB_ID")"
  [ "$DB_VOLUME" = volume:catus_pgdata ] || stop "o banco ativo usa '$DB_VOLUME', não o volume catus_pgdata"
  [ "$(docker volume inspect --format "{{index .Labels \"$LABEL.project\"}}" catus_pgdata)" = catus ] || stop "catus_pgdata não pertence ao projeto catus"
  [ "$(docker ps -a --filter volume=catus_pgdata --format '{{.ID}}' | wc -l)" = 1 ] || stop "há outro container usando catus_pgdata"
  ok "PostgreSQL no volume existente catus_pgdata, sem outro container nele"
  [ "$CATUS_SECRETS_DIR" = "$INSTALL_ROOT/.local/compose" ] || stop "deploy/.env aponta segredos para $CATUS_SECRETS_DIR, não para $INSTALL_ROOT/.local/compose"
  [ "$CATUS_BACKUP_DIR" = "$INSTALL_ROOT/.local/compose-backups" ] || stop "deploy/.env aponta backups para $CATUS_BACKUP_DIR, não para $INSTALL_ROOT/.local/compose-backups"
  if [ "$INSTALL_ROOT" != "$REPO" ] && [ -f "$INSTALL_ROOT/deploy/.env" ]; then
    cmp -s "$INSTALL_ROOT/deploy/.env" "$ENV_FILE" || stop "deploy/.env difere entre $INSTALL_ROOT e este checkout"
  fi
  EDGE_PORT="$(docker port "$(dc ps -q edge)" | LC_ALL=C sort -u | tr '\n' ' ')"
  case "$EDGE_PORT" in
  *"127.0.0.1:$CATUS_HOST_PORT "*) ;;
  *) stop "edge não está em 127.0.0.1:$CATUS_HOST_PORT: $EDGE_PORT" ;;
  esac
  if docker port "$(dc ps -q edge)" | grep -Eq '0\.0\.0\.0|\[::\]'; then stop "edge publicado fora do loopback: $EDGE_PORT"; fi
  ok "segredos e configuração da instalação existente em $INSTALL_ROOT; porta só no loopback"
  CONFIG="$(dc config)"
  echo "$CONFIG" | grep -qx 'name: catus' || stop "o Compose deste checkout não resolve para o projeto catus"
  echo "$CONFIG" | grep -q '^ *name: catus_pgdata$' || stop "o Compose deste checkout não resolve para catus_pgdata"
  UNEXPECTED_SECRET="$(echo "$CONFIG" | sed -n 's/^ *file: //p' | grep -v "^$CATUS_SECRETS_DIR/" || true)"
  [ -z "$UNEXPECTED_SECRET" ] || stop "o Compose deste checkout usa segredos fora da instalação: $UNEXPECTED_SECRET"
  [ "$(git remote get-url origin)" = "$ORIGIN" ] || stop "origin inesperado"
  if [ "$(label "$DB_ID" config-hash)" = "$(dc config --hash db | awk '{print $2}')" ]; then
    echo "PostgreSQL não deve ser recriado: configuração igual"
  else
    echo "AVISO: o update pode recriar o container do PostgreSQL, sobre o mesmo volume"
  fi
  [ -z "$(git status --porcelain --untracked-files=all)" ] || {
    git status --porcelain --untracked-files=all
    stop "há alterações locais no checkout; preserve-as antes de continuar"
  }
  ok "checkout sem alterações locais"
  STASH="$(git rev-parse -q --verify refs/stash || echo none)"
  sql "SELECT 1" >/dev/null || stop "banco inacessível"
  [ "$(sql "$M2_ON")" = 0 ] || stop "política M2 habilitada: a homologação aprovada tem M2 desligado"
  [ "$(sql "$M5_ON")" = 0 ] || stop "política M5 habilitada: a homologação aprovada tem M5 desligado"
  ok "M2 e M5 desligados"
}

check_versions() {
  [ "$(tree_of "$SHA")" = "$TREE" ] || stop "cea8960 ausente ou com conteúdo diferente do aprovado; rode git fetch origin $BRANCH"
  [ "$(tree_of "$PREV")" = "$PREV_TREE" ] || stop "75a9c14 ausente ou com conteúdo diferente do esperado"
  git merge-base --is-ancestor "$PREV" "$SHA" || stop "75a9c14 não é anterior a cea8960"
  [ "$(git diff --name-only "$PREV" "$SHA" -- deploy db/migrations | LC_ALL=C sort)" = "$EXPECTED_DIFF" ] ||
    stop "a infraestrutura muda mais do que o aprovado (só g4.sh e a migration 010)"
  ok "versões conferidas por conteúdo; infraestrutura muda só em g4.sh e na migration 010"
}

inspect_database_before() {
  local table n
  [ "$(git rev-parse HEAD)" = "$PREV" ] || stop "o checkout não está em 75a9c14 (está em $(git rev-parse --short HEAD))"
  ok "checkout em 75a9c14"
  sql "$COUNTS" >"$OUT/counts-before.txt"
  echo "contagens antes:"; cat "$OUT/counts-before.txt"
  for table in organizations users projects; do
    n="$(grep "^$table=" "$OUT/counts-before.txt" | cut -d= -f2 || true)"
    [ "${n:-0}" -gt 0 ] 2>/dev/null || stop "o banco ativo não tem registros em $table: não parece a homologação existente"
  done
  ok "banco original com organizações, usuários e projetos"
  HAVE="$(sql "$MIGRATIONS")"
  [ "$HAVE" = "$(migrations_at "$PREV")" ] || stop "migrations do banco ($HAVE) diferem das de 75a9c14"
  [ "$(sql "$NOT_MIGRATED")" = t ] || stop "o banco já tem objetos da migration 010"
  [ "$(migrations_at "$SHA")" = "$HAVE,$NEW_MIGRATION" ] || stop "a atualização traria outra migration além da 010"
  ok "pendente: só a migration $NEW_MIGRATION"
  OPEN_BEFORE="$(sql "$OPEN_DEMANDS")"
  echo "primeira varredura vai sinalizar: $(sql "$OPEN_WITHOUT")"
  n="$(sql "$ACTIVE_SESSIONS")"
  [ "$n" = 0 ] || echo "AVISO: $n sessão(ões) ativa(s). Uso do sistema durante a atualização muda dados e para o script."
}

check_fonts_and_https() {
  local base="https://localhost:$CATUS_HOST_PORT" ca="$CATUS_SECRETS_DIR/tls/ca.crt" code css font headers
  code="$(curl -sS -o "$OUT/index.html" -w '%{http_code}' --cacert "$ca" "$base/")"
  [ "$code" = 200 ] || stop "$base/ respondeu $code"
  ok "HTTPS 200 em $base/"
  [ "${1:-}" = fonts ] || return 0
  css="$(grep -o '/assets/[A-Za-z0-9._-]*\.css' "$OUT/index.html" | head -1 || true)"
  [ -n "$css" ] || stop "página sem folha de estilo"
  font="$(grep -o '/assets/[A-Za-z0-9._-]*\.woff2' "$OUT/index.html" | head -1 || true)"
  [ -n "$font" ] || font="$(curl -sS --cacert "$ca" "$base$css" | grep -o '/assets/[A-Za-z0-9._-]*\.woff2' | head -1 || true)"
  [ -n "$font" ] || stop "build sem fonte WOFF2: não é a versão esperada"
  headers="$(curl -sS -o "$OUT/font.bin" -D - --cacert "$ca" "$base$font" | tr -d '\r')"
  echo "$headers" | grep -qi '^content-type: font/woff2$' || stop "fonte servida sem font/woff2"
  echo "$headers" | grep -qi '^x-content-type-options: nosniff$' || stop "fonte servida sem nosniff"
  [ "$(head -c4 "$OUT/font.bin")" = wOF2 ] || stop "o arquivo de fonte não é WOFF2"
  ok "fontes pela instalação real, com font/woff2 e nosniff"
}

check_after_migration() {
  local until_s n t1
  [ "$(sql "$MIGRATIONS")" = "$(migrations_at "$SHA")" ] || stop "migrations inesperadas após a atualização: $(sql "$MIGRATIONS")"
  ok "aplicada só a migration $NEW_MIGRATION"
  [ "$(sql "$TRIGGER_ON")" = 1 ] || stop "gatilho de eventos ausente ou desativado"
  n="$(sql "$FILLED")"
  [ "$n" = 0 ] || stop "$n demanda(s) com campos novos preenchidos; a migration não preenche nada, e ninguém devia usar o sistema agora"
  [ "$(sql "$EVENTS")" = 0 ] || stop "há eventos de demanda: alguém usou o sistema durante a atualização"
  [ "$(sql "$REQUEST_JOBS")" = 0 ] || stop "há trabalhos de demanda: alguém usou o sistema durante a atualização"
  ok "colunas novas vazias, sem eventos e sem uso durante a atualização"
  until_s=$((SECONDS + SWEEP_WAIT_S))
  until [ "$(sql "$ORGS_PENDING")" = 0 ]; do
    [ "$SECONDS" -lt "$until_s" ] || stop "a automação não concluiu a primeira varredura"
    sleep 5
  done
  [ "$(sql "$FAILED_JOBS")" = 0 ] || stop "há trabalhos de automação com falha"
  [ "$(sql "$DERIVED_BROKEN")" = 0 ] || stop "automação e alertas com violação de integridade"
  [ "$(sql "$ALERTS_ON_DONE")" = 0 ] || stop "há alerta aberto em demanda concluída"
  [ "$(sql "$NO_FOLLOW_UP_ALERTS")" = "$OPEN_BEFORE" ] ||
    stop "esperados $OPEN_BEFORE avisos de sem compromisso; há $(sql "$NO_FOLLOW_UP_ALERTS")"
  ok "primeira varredura concluída; cada uma das $OPEN_BEFORE demandas abertas sinalizada uma vez"
  sql "$ALERTS_BY_KIND"
  sql "$OPEN_ALERTS" >"$OUT/alerts-first.txt"
  t1="$(sql "$NOW")"
  until_s=$((SECONDS + SWEEP_WAIT_S))
  until [ "$(sql "$(ORGS_PENDING_AFTER "$t1")")" = 0 ]; do
    [ "$SECONDS" -lt "$until_s" ] || stop "a automação não concluiu a segunda varredura"
    sleep 5
  done
  sql "$OPEN_ALERTS" >"$OUT/alerts-second.txt"
  diff "$OUT/alerts-first.txt" "$OUT/alerts-second.txt" >/dev/null || stop "os alertas mudaram sem mudança nas demandas"
  [ "$(sql "$FAILED_JOBS")" = 0 ] || stop "há trabalhos de automação com falha"
  ok "alertas estáveis entre duas varreduras"
}

run_g4() {
  local g4_out="${CATUS_G4_OUT:-$HOME/catus-g4}" report
  deploy/g4.sh --out "$g4_out" || stop "G4 não deu GO"
  report="$(ls -t "$g4_out"/*/REPORT.md | head -1)"
  grep -q 'relatório G4: \*\*GO\*\*' "$report" || stop "relatório sem GO: $report"
  ok "G4 GO: $report"
  G4_REPORT="$report"
}

do_check() {
  step "Inspeção (somente leitura)"
  inspect_installation
  check_versions
  inspect_database_before
  baseline
  ok "identidade, conteúdo, segredos e configuração registrados em $OUT"
  trap - ERR
  cat <<RESUMO

================ CHECK OK: nada foi alterado ================
Atual:     75a9c14
Destino:   cea8960, com a migration $NEW_MIGRATION
Cluster:   $(sql "SELECT system_identifier FROM pg_control_system()")
Instalação: $INSTALL_ROOT (segredos) e $REPO (aplicação)
Log:       $LOG
=============================================================
RESUMO
}

do_run() {
  step "1/8 Inspeção (somente leitura)"
  inspect_installation
  check_versions
  inspect_database_before
  git fetch -q origin "$BRANCH"
  git merge-base --is-ancestor "$SHA" "origin/$BRANCH" || stop "cea8960 não está em origin/$BRANCH"
  baseline
  ok "identidade, conteúdo, segredos e configuração registrados"

  step "2/8 Backup cifrado"
  local old_backups backup restore_log restored
  list_backups() { find "$CATUS_BACKUP_DIR" -maxdepth 1 -name '*.catus' | sort; }
  old_backups="$(list_backups)"
  deploy/catus.sh backup
  backup="$(comm -13 <(echo "$old_backups") <(list_backups) | tail -1)"
  [ -n "$backup" ] && [ -s "$backup" ] || stop "o backup não gerou arquivo novo"
  grep -qa PGDMP "$backup" && stop "o backup contém um arquivo pg_dump em claro"
  ok "backup: $backup ($(stat -c %s "$backup") bytes), cifrado"

  step "3/8 Restauração em banco descartável"
  restore_log="$(deploy/catus.sh restore-test "$backup")"
  echo "$restore_log"
  restored="$(echo "$restore_log" | sed -n 's/^restored into disposable database \([a-z0-9_]*_restore_test\).*/\1/p' | tail -1)"
  [ -n "$restored" ] || stop "a restauração não informou o banco descartável"
  sql_in "$restored" "$DIGEST" >"$OUT/digest-restored.txt"
  diff "$OUT/digest-before.txt" "$OUT/digest-restored.txt" >/dev/null || {
    diff "$OUT/digest-before.txt" "$OUT/digest-restored.txt" | cut -d= -f1 || true
    stop "o banco restaurado difere do original"
  }
  ok "restauração verificada: conteúdo de $restored igual ao original"
  check_unchanged restore

  step "4/8 Checkout em cea8960"
  STAGE="backup verificado; banco e serviços ainda intocados; checkout em 75a9c14"
  git switch --detach "$SHA"
  [ "$(git rev-parse HEAD)" = "$SHA" ] || stop "checkout não ficou em cea8960"
  [ -z "$(git status --porcelain)" ] || stop "checkout ficou com alterações inesperadas"
  ok "checkout em $SHA"

  step "5/8 deploy/catus.sh update (backup, build, migration, reinício)"
  STAGE="atualização iniciada; volume e segredos preservados; backup $backup"
  AFTER_STOP="Para voltar a aplicação, sem tocar no banco: bash $0 rollback $ROLLBACK_TOKEN"
  deploy/catus.sh update
  dc ps
  wait_healthy || stop "containers não ficaram saudáveis em 5 minutos"
  ok "$SERVICES saudáveis"

  step "6/8 Integridade dos dados e da automação"
  STAGE="atualização aplicada; backup $backup"
  check_unchanged update
  check_after_migration
  check_unchanged sweeps
  [ "$(git rev-parse -q --verify refs/stash || echo none)" = "$STASH" ] || stop "stash mudou"
  [ "$(sql "$M2_ON")" = 0 ] || stop "política M2 habilitada"
  [ "$(sql "$M5_ON")" = 0 ] || stop "política M5 habilitada"
  ok "stash preservado; M2 e M5 desligados"

  step "7/8 G4 no host"
  STAGE="atualização aplicada e dados conferidos; G4 sem GO"
  run_g4
  [ "$(git rev-parse HEAD)" = "$SHA" ] || stop "checkout mudou durante o G4"
  all_healthy || stop "containers não saudáveis após o G4"
  check_unchanged g4
  [ "$(sql "$DERIVED_BROKEN")" = 0 ] || stop "automação e alertas com violação de integridade após o G4"

  step "8/8 HTTPS, fontes e Google (sem alterar credenciais)"
  STAGE="atualização aplicada, G4 GO; falta confirmar HTTPS, fontes e Google"
  check_fonts_and_https fonts
  deploy/catus.sh google-check

  trap - ERR
  cat <<RESUMO

================ RESUMO: copie e envie ================
SHA instalado:  $(git rev-parse HEAD)
Migration:      só $NEW_MIGRATION
Backup:         $backup (restauração verificada, conteúdo igual)
Banco de teste: $restored (descartável, fica no cluster; não foi apagado)
G4:             GO ($G4_REPORT)
Comparação:     cluster, histórico, conteúdo, segredos e configuração idênticos
Alertas:        $(sql "$ALERTS_BY_KIND" | tr '\n' ' ')
Log e provas:   $OUT
URL:            https://localhost:$CATUS_HOST_PORT/
Rollback:       bash $0 rollback $ROLLBACK_TOKEN
=======================================================
Falta a validação humana: login Google, permissões de cada papel e a fila de cada papel.
RESUMO
}

do_rollback() {
  step "1/4 Inspeção (somente leitura)"
  inspect_installation
  # 75a9c14 with the migration applied means an earlier rollback stopped halfway: it resumes.
  case "$(git rev-parse HEAD)" in
  "$SHA") ;;
  "$PREV")
    [ "$(sql "$MIGRATIONS")" = "$(migrations_at "$SHA")" ] || stop "o checkout já está em 75a9c14 e a migration 010 não foi aplicada: não há o que voltar"
    echo "retomando um rollback interrompido"
    ;;
  *) stop "rollback só vale a partir de cea8960; o checkout está em $(git rev-parse --short HEAD)" ;;
  esac
  [ "$(tree_of "$PREV")" = "$PREV_TREE" ] || stop "75a9c14 ausente ou com conteúdo diferente do esperado"
  [ "$(git diff --name-only "$PREV" "$SHA" -- deploy db/migrations | LC_ALL=C sort)" = "$EXPECTED_DIFF" ] || stop "a infraestrutura difere do aprovado"
  [ "$(sql "$MIGRATIONS")" = "$(migrations_at "$SHA")" ] || stop "migrations inesperadas: $(sql "$MIGRATIONS")"
  baseline
  sql "$MIGRATIONS" >"$OUT/migrations-before.txt"
  sql "$COUNTS" >"$OUT/counts-before.txt"
  ok "estado atual registrado"

  step "2/4 Checkout em 75a9c14"
  STAGE="rollback iniciado; banco intocado; checkout em cea8960"
  [ "$(git rev-parse HEAD)" = "$PREV" ] || git switch --detach "$PREV"
  [ "$(git rev-parse HEAD)" = "$PREV" ] || stop "checkout não ficou em 75a9c14"

  step "3/4 deploy/catus.sh update, com a versão anterior"
  STAGE="rollback em andamento; banco com a migration 010, que a versão anterior ignora"
  AFTER_STOP="O banco não foi revertido nem deve ser, salvo perda de dados comprovada. Corrigido o problema, repita: bash $0 rollback $ROLLBACK_TOKEN"
  deploy/catus.sh update
  dc ps
  wait_healthy || stop "containers não ficaram saudáveis em 5 minutos"
  ok "$SERVICES saudáveis"

  step "4/4 Integridade"
  check_unchanged rollback
  [ "$(sql "$MIGRATIONS")" = "$(cat "$OUT/migrations-before.txt")" ] || stop "o histórico de migrations mudou no rollback"
  check_fonts_and_https
  run_g4
  check_unchanged g4

  trap - ERR
  cat <<RESUMO

================ ROLLBACK DA APLICAÇÃO CONCLUÍDO ================
SHA instalado: $(git rev-parse HEAD)
Banco:         mesmo cluster e mesmo conteúdo; a migration 010 continua aplicada, sem uso
G4:            GO ($G4_REPORT)
Log e provas:  $OUT
=================================================================
RESUMO
}

case "$MODE" in
check) do_check ;;
run) do_run ;;
rollback) do_rollback ;;
esac
