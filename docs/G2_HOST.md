# G2 — Host privado de homologação

Procedimento reproduzível para o portão G2 de [PILOT.md](PILOT.md), coerente com [HOMOLOGATION.md](HOMOLOGATION.md) §1–2. Resultado esperado: PostgreSQL persistente com administrador forte e contas mínimas, aplicação **somente em loopback** com HTTPS verificável, build reproduzível, migrations 001–009, M2/M5 desligados, nenhum segredo no Git e nenhuma exposição pública. G3 (Google), G4, G5 e M6 **não** fazem parte deste passo.

Este procedimento foi ensaiado de ponta a ponta numa VM descartável (ver §8). O ensaio valida os comandos e o verificador, **não aprova G2**: a aprovação exige executar no host persistente do piloto.

## 1. Pré-requisitos do host (proprietário)

- Linux persistente (VM ou servidor) com systemd, sem IP/porta pública para a aplicação; firewall/security group bloqueando entrada exceto SSH autorizado.
- ≥ 2 vCPU, ≥ 4 GiB RAM, ≥ 10 GiB livres para checkout, banco e backups.
- Node ≥ 22.12, npm, git, OpenSSL, curl, `iproute2` (`ss`), cliente `psql`; PostgreSQL **18** (pacotes PGDG). Docker local só será exigido no G5.
- Três usuários de SO, nenhum com sudo para o serviço:
  - `catus-op` — operador: checkout, `npm ci`, build, migrations, CA, backups; detém `.local/`.
  - `catus-run` — runtime HTTP: lê o código e **apenas** `/etc/catus/runtime.env` e `/etc/catus/tls/`.
  - `postgres` (ou equivalente) — servidor PostgreSQL.

## 2. PostgreSQL de homologação

1. Gerar a senha do administrador **no host**, sem exibi-la, e guardá-la em cofre:
   ```sh
   sudo -u catus-op bash -c 'umask 077; head -c 32 /dev/urandom | base64 | tr -d "/+=" | head -c 40 > ~/.pg-admin-password'
   ```
   Nunca usar `catus_local_only` (senha pública de desenvolvimento) nem colar a senha em chat/ticket.
2. `postgresql.conf`: `listen_addresses = '127.0.0.1'`, `password_encryption = 'scram-sha-256'`. `pg_hba.conf`: somente `scram-sha-256` (nenhum `trust`, `md5` ou `password`), somente `127.0.0.1/32`, `::1/128` e socket local.
3. Criar o administrador da aplicação `catus` com a senha gerada (por exemplo, `initdb -U catus --auth=scram-sha-256 --pwfile=…` em cluster dedicado, ou `CREATE ROLE catus LOGIN SUPERUSER PASSWORD …` via `psql` local do superusuário do sistema, sem registrar em histórico) e o banco `catus`.
4. URL administrativa somente no ambiente do operador:
   ```sh
   sudo -u catus-op bash -c 'umask 077; printf "DATABASE_URL=postgres://catus:%s@127.0.0.1:5432/catus\n" "$(cat ~/.pg-admin-password)" > ~/.catus-admin.env'
   ```

## 3. Código, build e contas mínimas (como `catus-op`, `umask 022`)

```sh
sudo install -d -o catus-op -g catus-op -m 755 /opt/catus-os
sudo -iu catus-op
umask 022
git clone https://github.com/marcelotaparelli/catus-os.git /opt/catus-os && cd /opt/catus-os
git switch --detach <SHA-aprovado>        # ex.: HEAD do PR #5 com CI verde
npm ci && npm run build
set -a; . ~/.catus-admin.env; set +a      # só nesta sessão do operador
npm run db:roles                          # .local/database.env 0600; senhas aleatórias, nunca impressas
npm run migrate                           # 001–009, idempotente
test -f .local/tls/server.crt || npm run tls:local
```

- Não executar `npm run env:init` no host: o `.env` de exemplo contém a URL de desenvolvimento. O runtime recebe tudo por arquivo de ambiente próprio (§4).
- `umask 022` é obrigatório no `npm ci`: com `077` o binário `bun` fica 0700 e o runtime falha com `execve … EACCES` (observado no ensaio). Conferir: `cd /opt/catus-os && find . -path ./.local -prune -o -path ./.git -prune -o ! -perm -o=r -print | wc -l` deve resultar 0.
- Build reproduzível: o hash do conteúdo de `dist/` deve coincidir com o de outro build do mesmo SHA e `package-lock.json`:
  `cd dist && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum`.

## 4. Ambiente isolado do runtime (como root)

```sh
install -d -o root -g catus-run -m 750 /etc/catus
install -d -o catus-run -g catus-run -m 700 /etc/catus/tls
install -o catus-run -g catus-run -m 644 /opt/catus-os/.local/tls/server.crt /etc/catus/tls/server.crt
install -o catus-run -g catus-run -m 600 /opt/catus-os/.local/tls/server.key /etc/catus/tls/server.key
```

`/etc/catus/runtime.env` (dono `catus-run`, modo 0600), com a `RUNTIME_DATABASE_URL` copiada de `.local/database.env` sem exibi-la:

```dotenv
RUNTIME_DATABASE_URL=<copiada de .local/database.env>
NODE_ENV=production
APP_ORIGIN=https://localhost:3443
PORT=3443
TLS_CERT_FILE=/etc/catus/tls/server.crt
TLS_KEY_FILE=/etc/catus/tls/server.key
LLM_ENABLED=false
DELIVERY_ENABLED=false
```

Proibido nesse arquivo: `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `MAINTENANCE_DATABASE_URL`, `BACKUP_KEY_FILE`, tokens GitHub/OpenAI/Codex. As variáveis `OIDC_*` só entram no G3.

## 5. Serviços supervisionados (modelos systemd)

O systemd entrega ambiente limpo ao processo. **Não** iniciar o runtime com `su` a partir de um shell com variáveis herdadas: no ensaio, `su` repassou ao processo um token do shell de origem; com ambiente limpo (`env -i` + `runuser`), restaram apenas as chaves de `runtime.env`.

`/etc/systemd/system/catus-runtime.service`:

```ini
[Unit]
Description=Catus OS runtime (loopback HTTPS)
After=network.target postgresql.service
Requires=postgresql.service

[Service]
User=catus-run
Group=catus-run
WorkingDirectory=/opt/catus-os
EnvironmentFile=/etc/catus/runtime.env
ExecStart=/usr/bin/node scripts/runtime.mjs
Restart=on-failure
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=full

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/catus-cleanup.service` (worker de retenção com a conta de manutenção, lida de `.local/database.env` pelo script):

```ini
[Unit]
Description=Catus OS retention worker
After=postgresql.service
Requires=postgresql.service

[Service]
User=catus-op
Group=catus-op
WorkingDirectory=/opt/catus-os
ExecStart=/usr/bin/npm run cleanup
Restart=on-failure
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

```sh
systemctl daemon-reload && systemctl enable --now catus-runtime catus-cleanup
journalctl -u catus-runtime -n 5   # "Catus listening on loopback port 3443; TLS enabled"
```

Os modelos systemd **não foram executados no ensaio** (VM sem systemd); validar no host e ajustar o caminho do `node`/`npm` (`command -v node`).

## 6. Verificação G2 (como `catus-op`)

```sh
cd /opt/catus-os
set -a; . ~/.catus-admin.env; set +a
EXPECTED_SHA=<SHA-aprovado> RUNTIME_USER=catus-run RUNTIME_ENV_FILE=/etc/catus/runtime.env \
  ./scripts/g2-preflight.sh | tee ~/g2-preflight-$(date +%Y%m%d).txt
```

Somente leitura; não imprime segredos. Sai com 0 apenas sem `FAIL`. Verifica: host persistente (sem overlay, systemd ativo, disco, RAM, operador não root); dependências; SHA esperado, árvore limpa, `.env`/`.local` fora do Git, ausência de material com aparência de segredo; `dist`; PostgreSQL ≥ 18 em loopback, SCRAM, `pg_hba` sem regras fracas, senha administrativa ≠ desenvolvimento e ≥ 24 caracteres, `schema_migrations` = 001–009, contas da aplicação sem superuser/CREATEDB/CREATEROLE/BYPASSRLS, `assertRuntimePrivileges` da conta runtime; permissões de `.local/database.env`, `ca.key` e arquivo de backup; arquivo de ambiente do runtime sem URLs privilegiadas e com M2/M5 desligados; certificado encadeado na CA local, SAN `localhost`, validade > 24h; porta 3443 só em loopback; HTTPS aceito com a CA e recusado sem ela (curl 60); POST com `Origin` forjada recusado; API sem sessão recusada; cabeçalhos HSTS/CSP/X-Frame-Options/nosniff; processo servidor executando apenas como `catus-run`; nenhum listener fora de loopback além do SSH.

Itens `HUMAN` que o verificador não pode provar e devem ser conferidos pelo proprietário/root:

1. Firewall/security group: entrada bloqueada exceto SSH autorizado (inclusive IPv6).
2. `/etc/catus/runtime.env` (ilegível ao operador por desenho): como root, `stat` mostra `catus-run 600`; `sed -E 's/=.*/=<set>/'` lista só as chaves permitidas; `LLM_ENABLED=false` e `DELIVERY_ENABLED=false`.
3. Ambiente do processo: como root, `tr '\0' '\n' < /proc/$(pgrep -u catus-run -f src/server/index.ts)/environ | sed 's/=.*//'` não contém chaves além das de `runtime.env` e as padrão do systemd.
4. Senha administrativa e cópia guardadas em cofre; backup da CA (`ca.key`) fora do host.

Testes negativos obrigatórios (registrar a saída):

- Runtime com a URL administrativa recusa iniciar: `Runtime PostgreSQL role has excessive privileges; run db:roles and use RUNTIME_DATABASE_URL`.
- Verificador com `DATABASE_URL` contendo `catus_local_only` falha em “admin password is empty or the public development password”.
- `curl https://localhost:3443/api/auth/config` sem `--cacert` falha com código 60.

## 7. Critério de aprovação G2

G2 aprovado quando, no host persistente e no SHA com CI verde: `g2-preflight.sh` termina com `0 FAIL`; os quatro itens `HUMAN` e os três testes negativos estão registrados; `/api/auth/config` retorna `{"configured":false}` (OIDC ainda não configurado). Registrar data, SHA, executor e o arquivo de saída do verificador. Só então iniciar G3.

## 8. Evidência do ensaio (VM descartável, 02/11/2026)

Ambiente: microVM efêmera (raiz em overlay, sem systemd, 3,9 GiB de disco), SHA `3d28213`. PostgreSQL 18.3 em `127.0.0.1:5433`, SCRAM em todas as regras, administrador com senha aleatória de 40 caracteres; usuários `catus-op`/`catus-run`/`catus-pg`.

- `npm ci`, `build`, `db:roles`, `migrate` (001–009) e `tls:local` concluídos como operador; build com hash de `dist/` idêntico ao de outro checkout do mesmo SHA (`6566d7dd38f6db8e…`) e `package-lock.json` idêntico.
- `catus-run` sem leitura de `.local/database.env`, `ca.key`, URL e senha administrativas.
- Runtime como `catus-run`, ambiente limpo: `Catus listening on loopback port 3443; TLS enabled`.
- `g2-preflight.sh`: **50 PASS, 3 FAIL, 3 HUMAN**. As 3 falhas são exatamente do host (overlay, sem systemd, disco < 10 GiB): resultado correto para ambiente efêmero.
- Negativos: runtime com URL administrativa recusado com a mensagem esperada; verificador detecta a senha de desenvolvimento; CA desconhecida rejeitada (curl 60); POST com Origin forjada 403; API sem sessão 503.
- `npm run cleanup -- --once` com a conta de manutenção concluído.
- Achados incorporados a este procedimento: `umask 022` no `npm ci`; iniciar o runtime com ambiente limpo (systemd/`env -i`), nunca via `su` de shell com segredos.
