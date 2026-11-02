# Catus OS em Docker Compose — homologação privada (G2)

Variante do G2 para um único host Linux (Arch) **sem Node, npm ou PostgreSQL instalados**. Tudo roda em contêineres; o host só publica `127.0.0.1:3443`. Não é produção nem exposição pública. Requisitos de segurança iguais a [HOMOLOGATION.md](HOMOLOGATION.md) e [G2_HOST.md](G2_HOST.md).

## Arquitetura

| Serviço   | Imagem                                    | Rede                           | Segredos montados                      | Função                                                         |
| --------- | ----------------------------------------- | ------------------------------ | -------------------------------------- | -------------------------------------------------------------- |
| `db`      | PostgreSQL 18.3 (digest fixado)           | `backend` (interna, sem porta) | senha do administrador                 | dados no volume `catus_pgdata` em `/var/lib/postgresql` (PG18) |
| `edge`    | `catus-app` (Node fixado)                 | `frontend` + `backend`         | nenhum                                 | encaminhador TCP `IP do contêiner:3443 → 127.0.0.1:3443`       |
| `app`     | `catus-app`                               | namespace de rede do `edge`    | URL runtime, certificado/chave TLS, CA | servidor Catus em `127.0.0.1:3443` com TLS próprio             |
| `cleanup` | `catus-app`                               | `backend`                      | URL manutenção                         | worker de retenção                                             |
| tarefas   | `catus-tools` (cliente PostgreSQL fixado) | `backend` (ou nenhuma)         | só o necessário por tarefa             | `init`, `setup`, `migrate`, `backup`, `restore-test`           |

- **TLS ponta a ponta:** o `edge` copia bytes TCP; não termina TLS nem lê/altera cabeçalhos. `Origin`, `Host` e cookies `__Host-` chegam intactos; o servidor continua em `127.0.0.1` e valida `APP_ORIGIN=https://localhost:3443`. Todas as conexões chegam ao servidor vindas de `127.0.0.1`, então a cota de 300 req/min é compartilhada (igual ao túnel SSH único documentado).
- **Credenciais separadas:** administrador (só `db`, `setup`, `restore-test`), migrator (`migrate`, `backup`), runtime (`app`), manutenção (`cleanup`). Arquivos em `.local/compose/` (0700/0600, fora do Git), montados como Compose secrets; nenhuma credencial em imagem, variável do Compose, `docker inspect` ou log.
- **Migrations** só na tarefa `migrate` (migrator); o runtime recusa credenciais administrativas/migrator.
- **Endurecimento:** todos os contêineres com o UID/GID do operador (não root), `read_only`, `cap_drop: ALL`, `no-new-privileges`, sem `privileged`, sem socket Docker, sem `network_mode: host`, limites de memória/CPU/PIDs, `restart: unless-stopped`, logs `json-file` 10 MB × 5, healthchecks (HTTPS validando a CA no `app`).
- **M2 e M5 desligados** (`LLM_ENABLED=false`, `DELIVERY_ENABLED=false`).
- Ferramentas do projeto aceitam banco apenas em loopback; por isso `setup`/`backup`/`restore-test` usam, dentro do próprio contêiner, um encaminhador privado `127.0.0.1:5432 → db:5432`. O backup usa `pg_dump`/`pg_restore` 18.3 da mesma imagem fixada em `scripts/lib/backup.ts` (um shim interno substitui a chamada `docker run` por execução direta, recusando qualquer outra imagem).

## 1. Preparar o Arch (uma vez)

```sh
sudo pacman -S --needed docker docker-compose docker-buildx git curl openssl iproute2
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"     # sair e entrar na sessão; o grupo docker equivale a root no host
docker compose version && docker buildx version
```

Portas: usa apenas `127.0.0.1:3443`; não toca na 3000 nem no mapeamento `localhost:3006 → VM:3000`. Se a sub-rede `10.89.243.0/29` colidir com outra rede local, ajuste `CATUS_FRONTEND_SUBNET`/`CATUS_EDGE_IP` em `deploy/.env` antes do primeiro `install`.

## 2. Instalar e iniciar

```sh
git clone https://github.com/marcelotaparelli/catus-os.git && cd catus-os
git switch feat/pilot-docker        # ou: git switch --detach <SHA aprovado com CI verde>
deploy/catus.sh install             # build, segredos, banco, papéis, migrations 001–009, serviços
deploy/catus.sh verify --recreate   # evidência G2; deve terminar com 0 FAIL
```

`install` é idempotente: preserva `deploy/.env`, senhas, chave de backup, TLS e dados existentes.

## 3. Confiar na CA (perfil dedicado)

A CA local não tem restrição de nomes: **não** instale como âncora do sistema (`trust anchor`). Use um perfil dedicado do Firefox, que tem repositório de certificados por perfil:

```sh
firefox -CreateProfile catus-homolog
firefox -P catus-homolog -no-remote https://localhost:3443
# Configurações → Privacidade e Segurança → Certificados → Ver certificados → Autoridades → Importar
#   .local/compose/tls/ca.crt  → marcar apenas "identificar sites"
openssl x509 -in .local/compose/tls/ca.crt -noout -fingerprint -sha256   # conferir antes de importar
```

Nunca aceitar exceção de certificado nem usar `curl -k`. O certificado vale **7 dias**: renove com `deploy/catus.sh rotate-tls`, importe a CA nova e remova a antiga.

## 4. Operação diária

```sh
deploy/catus.sh status              # estado e saúde
deploy/catus.sh logs app            # últimas 200 linhas (rotação automática)
deploy/catus.sh stop                # para os contêineres; dados e segredos preservados
deploy/catus.sh start               # sobe novamente e espera os healthchecks
deploy/catus.sh backup              # .local/compose-backups/catus-<UTC>.catus (AES-256-GCM, 0600)
deploy/catus.sh restore-test .local/compose-backups/catus-<UTC>.catus   # banco descartável novo
```

Guarde uma cópia de `.local/compose/backup.key` e de `.local/compose/pg_admin_password` em cofre separado dos backups. Sem a chave, nenhum backup é restaurável. Restores de teste criam bancos `catus_r<UTC>_restore_test`, nunca apagados automaticamente.

## 5. Atualizar

```sh
git fetch origin && git switch --detach <SHA aprovado com CI verde>
deploy/catus.sh update              # backup → build → migrate → reinício com healthchecks
```

## 6. Proibido

`docker compose down -v`, `docker volume rm catus_pgdata`, `docker system/volume prune`, publicar `0.0.0.0`, `network_mode: host`, montar `/var/run/docker.sock`, colocar segredos em `deploy/.env`, imagens, Git ou chat. `deploy/catus.sh stop` (ou `docker compose stop`) é a forma de parar.

## 7. Critério de aprovação G2 (Docker)

No Arch real, com o SHA de CI verde: `deploy/catus.sh verify --recreate` termina com `0 FAIL`; a página abre no perfil dedicado com a CA importada (sem exceção de certificado) mostrando “OIDC não configurado”; `sudo ss -ltnp` mostra `3443` só em `127.0.0.1`; backup e `restore-test` concluídos; senha administrativa e chave de backup em cofre. Registrar data, SHA e a saída do `verify`.

## 8. Login Google (G3)

**Google Cloud** (projeto de homologação) — console.cloud.google.com → _Google Auth Platform_ (APIs e serviços → Tela de consentimento OAuth):

1. _Branding_/_Começar_: nome `Catus OS (homologação)`, e-mail de suporte. _Público_: **Interno** se houver Google Workspace; senão **Externo** e, em _Público → Usuários de teste_, adicionar **cada** e-mail que vai entrar (status “Em teste”).
2. _Acesso a dados_: só `openid`, `email`, `profile` (não sensíveis; nada a adicionar).
3. _Clientes → Criar cliente_ → tipo **Aplicativo da Web** → _URIs de redirecionamento autorizados_: exatamente `https://localhost:3443/api/auth/callback` (origens JavaScript: nenhuma) → Criar → **Baixar JSON** (o segredo só aparece nessa hora).

**No Arch** (relógio sincronizado: `timedatectl` deve mostrar `System clock synchronized: yes`; o ID token é validado sem tolerância):

```sh
deploy/catus.sh google-setup ~/Downloads/client_secret_*.json   # Enter = contas Google comuns
deploy/catus.sh admin-bootstrap seu.email@gmail.com 'Seu Nome'   # uma única vez
shred -u ~/Downloads/client_secret_*.json
```

Sem o JSON, `deploy/catus.sh google-setup` pede client ID e segredo (digitação oculta). O segredo fica só em `.local/compose/oidc_client_secret` (0600, Compose secret do `app`); `oidc.env` guarda issuer, client ID e domínio opcional. `google-check` (também dentro de `verify`) prova: OIDC ativo, redirecionamento PKCE com client ID/redirect exatos e aceitação do client ID/redirect pelo próprio Google; **não** prova o segredo — só o login real.

Acesso: o Google autentica; o Catus só cria sessão para e-mail **previamente provisionado** e ativo (senão 403). O primeiro login fixa o `sub` Google da conta. Contas comuns (gmail.com) funcionam sem domínio; com domínio Workspace configurado, contas fora dele recebem 401. Demais pessoas: convite pela tela de acesso do administrador (e, no modo Externo/Teste, também na lista de usuários de teste do Google).

## 9. Ensaio nesta preparação (VM descartável, 02/11/2026)

Docker Engine 20.10 (overlay2 em disco de loop) + Compose v5.6.1 + buildx v0.38.1, usuário não root no grupo `docker` com UID 1004 (≠ 1000, para exercitar o mapeamento de UID):

- `install` completo: imagens construídas, `init` (senha administrativa de 64 hex, chave de backup, CA/certificado), `setup` (papéis mínimos e arquivos por serviço), `migrate` 001–009, `edge`/`app`/`cleanup` saudáveis.
- `verify --recreate`: **49 PASS, 0 FAIL** — host só em `127.0.0.1:3443`; HTTPS com CA, CA desconhecida recusada (curl 60), Origin forjada 403, escrita sem sessão 503, cabeçalhos de segurança; rede `backend` interna, `db` sem porta e inalcançável a partir da rede `frontend`; SCRAM em todo `pg_hba`; papéis sem privilégios; runtime recusa credenciais de migrator e de administrador; todos os contêineres não root, sem privilégios/capacidades, raiz somente leitura, sem socket Docker, com limites e rotação de logs; segredos 0600 e escopo por serviço; nenhum valor secreto em logs/metadados; mesmo `system_identifier` e histórico de migrations após `--force-recreate` e após `down` (sem `-v`) + `up`.
- Backup criptografado e `restore-test` em banco descartável novo: contagens iguais (9 migrations, 1 organização), sessões invalidadas, nenhum arquivo temporário remanescente.
- `rotate-tls`: novo certificado aceito, CA antiga recusada (curl 60).
- Chromium (Playwright) com a CA importada num banco NSS dedicado abriu `https://localhost:3443` (HTTP 200, tela de login com “OIDC não configurado”); sem a CA: `ERR_CERT_AUTHORITY_INVALID`.
- G3 (commit `feat/pilot-oidc`), com cliente **sintético**: `update` a partir do G2 (backup → build → migrate); `verify` sem OIDC 47 PASS/0 FAIL; JSON com redirect errado e cliente “Desktop” recusados sem tocar no `app`; importação por JSON e por digitação oculta; login redireciona ao Google com PKCE/client/redirect exatos (servidor alcançou o discovery); o Google respondeu `invalid_client` (esperado com ID falso); `verify --recreate` 52 PASS + essa única FAIL; segredo ausente de logs, `docker inspect` e histórico das imagens; configuração parcial (segredo vazio) impede o `app` de subir; `admin-bootstrap` cria o administrador auditado e recusa o segundo.
- Não testado aqui: login Google real (exige o cliente do proprietário), Docker 29 do Arch, Firefox, `update` contra um SHA novo, reinício do host. **G2 não está aprovado** até a execução no Arch real.
