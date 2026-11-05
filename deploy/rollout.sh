#!/usr/bin/env bash
# Catus OS — implantação assistida no host de homologação (um comando):
#
#   bash deploy/rollout.sh <SHA aprovado de 40 caracteres> [checkout]
#
# 1. Confere host, Docker, Compose, espaço livre, deploy/.env, segredos e backups.
# 2. Preserva alterações locais (patch + cópia + git stash) em ~/catus-preserved/<data>/,
#    compara com a versão aprovada e nunca descarta nada (sem reset --hard nem clean).
# 3. Fixa o checkout no SHA aprovado (precisa estar em origin/feat/pilot-oidc).
# 4. deploy/catus.sh update (backup cifrado antes, mesmos volumes, segredos e certificados;
#    nunca admin-bootstrap) e foto das contagens do banco antes/depois.
# 5. deploy/g4.sh no SHA implantado (banco real somente leitura) → REPORT.md GO/NO-GO.
# 6. Só com GO: timers systemd do usuário (backup 19:00, smoke 08:00), sem sobrescrever
#    unidades existentes.
# Log completo: ~/catus-rollout-<data>.log. Código de saída 0 somente com GO.
set -euo pipefail
umask 077
SHA="${1:-}" REPO="${2:-$HOME/sandboxes/agent/projects/catus-os-m5}" BRANCH="${CATUS_BRANCH:-feat/pilot-oidc}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
KEEP="$HOME/catus-preserved/$TS" LOG="$HOME/catus-rollout-$TS.log"
NEED_KB=$((8 * 1024 * 1024))
die() {
  echo "rollout: PARADO — $*" >&2
  exit 2
}
step() { printf '\n== %s\n' "$*"; }
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "uso: bash deploy/rollout.sh <SHA de 40 caracteres> [checkout]"
[ "$(id -u)" -ne 0 ] || die "execute como o usuário normal do grupo docker, não como root"
exec > >(tee -a "$LOG") 2>&1
cd "$REPO" 2>/dev/null && [ -f deploy/compose.yaml ] && [ -d .git ] || die "$REPO não é o checkout do Catus OS"

step "1. Host e pré-requisitos"
echo "host=$(hostname) usuário=$(id -un) checkout=$REPO $(. /etc/os-release && echo "so=$ID")"
for t in git docker curl ss tar sha256sum df; do command -v "$t" >/dev/null || die "ferramenta ausente: $t"; done
docker info >/dev/null 2>&1 || die "Docker não acessível (daemon parado ou usuário fora do grupo docker)"
echo "docker=$(docker version --format '{{.Server.Version}}') compose=$(docker compose version --short)"
docker buildx version >/dev/null 2>&1 || die "docker buildx ausente"
[ -f deploy/.env ] || die "deploy/.env ausente: esta não é a instalação existente"
ENVV=$(set -a && . deploy/.env && printf '%s\n%s\n%s' "$CATUS_SECRETS_DIR" "$CATUS_BACKUP_DIR" "${CATUS_HOST_PORT:-3443}")
{ read -r S_DIR && read -r B_DIR && read -r PORT; } <<<"$ENVV"
for f in tls/ca.crt backup.key oidc.env oidc_client_secret; do [ -s "$S_DIR/$f" ] || die "segredo ausente ou vazio: $S_DIR/$f"; done
echo "segredos: tls, backup.key e Google OAuth presentes (conteúdo não lido)"
LAST_BK=$(ls -1t "$B_DIR"/*.catus 2>/dev/null | head -1 || true)
echo "último backup: ${LAST_BK:-nenhum} ($(ls -1 "$B_DIR"/*.catus 2>/dev/null | wc -l) arquivos)"
DROOT=$(docker info --format '{{.DockerRootDir}}')
FREE=$(df -Pk "$DROOT" 2>/dev/null | awk 'NR==2{print $4}')
echo "livre no Docker ($DROOT): $((${FREE:-0} / 1024 / 1024)) GB"
[ "${FREE:-0}" -ge "$NEED_KB" ] || die "menos de 8 GB livres para o Docker. Libere espaço (sem apagar volumes) e rode de novo; nada foi alterado"
OLD=$(git rev-parse HEAD)
echo "versão atual: $OLD"
docker compose -f deploy/compose.yaml --env-file deploy/.env ps --format '{{.Service}} {{.Status}}' || true

step "2. Alterações locais"
if [ -n "$(git status --porcelain)" ]; then
  install -d -m 700 "$KEEP"
  git status --porcelain=v1 | tee "$KEEP/status.txt"
  echo "$OLD" >"$KEEP/HEAD"
  git diff --binary HEAD >"$KEEP/local.patch"
  git diff --summary --stat HEAD | tee "$KEEP/summary.txt"
  git ls-files -m -z | tar --null -T - -czf "$KEEP/modified-files.tgz"
  git ls-files -o --exclude-standard | grep . && die "há arquivos não rastreados (listados acima); não vou movê-los. Cópia das alterações em $KEEP"
  git stash push -q -m "catus-rollout $TS (antes de $SHA)"
  git rev-parse 'stash@{0}' | tee "$KEEP/stash-commit"
  echo "preservado em $KEEP e em git stash (recuperar: git stash apply \$(cat $KEEP/stash-commit))"
else
  echo "nenhuma"
fi

step "3. Checkout do SHA aprovado"
git fetch -q origin "$BRANCH"
git merge-base --is-ancestor "$SHA" FETCH_HEAD 2>/dev/null || die "$SHA não pertence a origin/$BRANCH"
if [ -s "$KEEP/local.patch" ]; then
  git diff --binary "$SHA" -- $(git diff --name-only HEAD "stash@{0}") >"$KEEP/vs-approved.patch" 2>/dev/null || true
  git diff --quiet "$SHA" "stash@{0}" -- $(git diff --name-only HEAD "stash@{0}") &&
    echo "a alteração local é idêntica à versão aprovada: nada se perde" ||
    echo "a alteração local difere da versão aprovada; diferença em $KEEP/vs-approved.patch"
fi
git checkout -q --detach "$SHA"
[ "$(git rev-parse HEAD)" = "$SHA" ] && [ -z "$(git status --porcelain)" ] || die "checkout não ficou limpo em $SHA"
echo "checkout limpo em $SHA (anterior: $OLD)"

step "4. Atualização (deploy/catus.sh update)"
snap() {
  docker compose -f deploy/compose.yaml --env-file deploy/.env exec -T db sh -c \
    'PGPASSWORD=$(cat /run/secrets/pg_admin_password) psql -XAtq -h 127.0.0.1 -U catus_admin -d catus -c "$0"' \
    "SELECT (SELECT system_identifier FROM pg_control_system())||' '||concat_ws(' ','organizations='||(SELECT count(*) FROM organizations),'users='||(SELECT count(*) FROM users),'memberships='||(SELECT count(*) FROM memberships),'clients='||(SELECT count(*) FROM clients),'projects='||(SELECT count(*) FROM projects),'interactions='||(SELECT count(*) FROM interactions),'requests='||(SELECT count(*) FROM requests),'contracts='||(SELECT count(*) FROM contracts),'time_entries='||(SELECT count(*) FROM time_entries),'audit_events='||(SELECT count(*) FROM audit_events))"
}
BEFORE=$(snap) || die "não consegui ler as contagens do banco antes da atualização"
echo "antes:  $BEFORE"
if ! deploy/catus.sh update; then
  echo "rollout: a atualização falhou. Dados e volume intactos; backup feito no início do update."
  echo "Voltar à versão anterior: git checkout -q --detach $OLD && deploy/catus.sh update"
  exit 1
fi
AFTER=$(snap) || die "banco inacessível depois da atualização"
echo "depois: $AFTER"
read -r CL_B _ <<<"$BEFORE" && read -r CL_A _ <<<"$AFTER"
[ "$CL_B" = "$CL_A" ] || die "o cluster PostgreSQL mudou ($CL_B → $CL_A): investigar antes de usar"
for kv in ${BEFORE#* }; do
  k=${kv%=*} b=${kv#*=} a=$(tr ' ' '\n' <<<"${AFTER#* }" | sed -n "s/^$k=//p")
  [ "${a:-0}" -ge "$b" ] || die "contagem de $k diminuiu ($b → ${a:-0})"
done
echo "dados preservados: mesmo cluster, nenhuma contagem diminuiu"

step "5. Homologação (deploy/g4.sh)"
set +e
deploy/g4.sh
G4=$?
set -e
REPORT=$(ls -1td "$HOME"/catus-g4/*-"${SHA:0:7}" 2>/dev/null | head -1)/REPORT.md
echo "relatório: $REPORT"
grep -m1 '^# Catus OS' "$REPORT" 2>/dev/null || true

if [ "$G4" -ne 0 ]; then
  echo "rollout: G4 = NO-GO. A versão está instalada; envie $REPORT para análise."
  echo "Voltar à versão anterior: git checkout -q --detach $OLD && deploy/catus.sh update"
  exit 1
fi

step "6. Rotina diária (systemd do usuário)"
U="$HOME/.config/systemd/user" && install -d -m 700 "$U"
unit() { # nome descrição comando horário
  [ -e "$U/$1.service" ] || printf '[Unit]\nDescription=%s\n\n[Service]\nType=oneshot\nWorkingDirectory=%s\nExecStart=%s\n' "$2" "$REPO" "$3" >"$U/$1.service"
  [ -e "$U/$1.timer" ] || printf '[Unit]\nDescription=%s (agendamento)\n\n[Timer]\nOnCalendar=*-*-* %s\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n' "$2" "$4" >"$U/$1.timer"
}
unit catus-backup "Catus OS backup cifrado diário" "$REPO/deploy/catus.sh backup" 19:00
unit catus-smoke "Catus OS smoke G4 diário (somente leitura)" "$REPO/deploy/g4.sh --skip-suite --skip-disposable" 08:00
if systemctl --user daemon-reload && systemctl --user enable --now catus-backup.timer catus-smoke.timer; then
  loginctl enable-linger "$(id -un)" 2>/dev/null || echo "aviso: linger não ativado; os timers só rodam com sessão aberta"
  systemctl --user list-timers 'catus-*' --no-pager || true
else
  echo "aviso: não consegui ativar os timers do usuário (unidades em $U)"
fi

step "RESULTADO: GO"
echo "versão implantada: $SHA (anterior $OLD)"
echo "dados: $AFTER"
echo "último backup: $(ls -1t "$B_DIR"/*.catus | head -1)"
echo "relatório: $REPORT"
echo "log: $LOG"
