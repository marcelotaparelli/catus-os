# M1.1 — Homologação segura e reproduzível

Este procedimento prepara **homologação local com dados sintéticos**, não produção. Não inicia M2 nem autoriza exposição à Internet. A aplicação sempre escuta em `127.0.0.1`; funcionários remotos usam túnel SSH autorizado ou executam o ambiente em sua máquina. Não usar `--host 0.0.0.0`, ngrok, publicação de porta pública ou certificados aceitos com erro ignorado.

## 1. Preparação independente do Google

No checkout `feat/m1-identity-security`, preservar `.env` e dados existentes. Requisitos: Node >=22.12, npm, OpenSSL, Docker local no socket `/var/run/docker.sock`. Docker é usado somente como ferramenta para os clientes oficiais PostgreSQL 18.3 (sem servidor de banco/porta de container publicada).

```sh
npm ci
npm run env:init
npm run db
```

Com PostgreSQL em terminal separado:

```sh
npm run db:roles
npm run migrate
npm run build
npm run tls:local
```

`db:roles` usa o `DATABASE_URL` administrativo local, recusa destinos externos/desconhecidos e gera `.local/database.env` 0600. Não altera `.env` nem reseta senhas existentes. Para banco `catus`, cria `catus_runtime`, `catus_migrator` e `catus_maintenance`. Uma segunda execução preserva credenciais. Se papéis existirem sem arquivo de credenciais, interrompe para recuperação, sem adivinhar/resetar senha. Se aparecer tabela pública desconhecida, interrompe a transferência de ownership.

| Conta       | Uso                            | Restrições verificadas                                                                                                                                                     |
| ----------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| runtime     | Somente servidor web/API       | Sem superuser/CREATEDB/CREATEROLE/membership privilegiada/DDL; sem UPDATE/DELETE da auditoria; sem acesso a schema_migrations; grants de tabelas/colunas necessários ao M1 |
| migrator    | Migrations e bootstrap offline | Dona apenas do banco/schema/objetos da aplicação; sem superuser/CREATEDB/CREATEROLE                                                                                        |
| maintenance | Worker de retenção             | SELECT/DELETE somente em sessões, states, rate limits e idempotência; sem leitura de clientes/projetos/solicitações/auditoria                                              |

`npm run start`/`dev` usa launcher com `--no-env-file`: o processo que serve HTTP recebe somente a URL runtime, nunca as URLs administrativas/migrations/manutenção/backup. O entrypoint recusa ambiente privilegiado e verifica privilégios no PostgreSQL antes de escutar. A conta de teste administrativa só existe nos fixtures descartáveis; testes adicionais percorrem o aplicativo com runtime limitado real.

**Antes de usuários reais em host compartilhado:** o cluster `npm run db` mantém a senha pública `catus_local_only` herdada do bootstrap para fixtures/desenvolvimento descartável. Não o reutilizar como fronteira de segurança compartilhada. O proprietário deve fornecer PostgreSQL local de homologação com administrador SCRAM de senha forte/inédita e protegida (ou rotacionar a conta por procedimento administrativo revisado), atualizar a URL administrativa somente no contexto do operador e então executar `db:roles`/migrations nessa instância. Os grants mínimos não compensam uma senha administrativa conhecida. Nenhum segredo administrativo real foi solicitado ou usado aqui.

**Fronteira do sistema operacional:** a conveniência `.local/database.env` é para desenvolvimento por um operador confiável. Para homologação compartilhada em host persistente, usar usuário/serviço de SO separado: runtime recebe apenas `RUNTIME_DATABASE_URL` e configuração OIDC/TLS, sem permissão de ler `.env` administrativo, arquivos de migrations/backup/role secrets ou chave CA. A geração/armazenamento dos segredos operacionais fica com o operador. Não alegamos isolamento de arquivos entre processos executados pelo mesmo usuário de SO. O launcher aceita `RUNTIME_DATABASE_URL` já injetado e não precisa ler o arquivo de papéis nesse modo.

## 2. HTTPS local com verificação ativa

`tls:local` cria CA e certificado SAN `localhost`/`127.0.0.1` válidos por 7 dias em `.local/tls`, com chaves privadas 0600. Recusa sobrescrever arquivos existentes. Rotação é explícita: arquivar material anterior em local protegido, gerar novamente e renovar a confiança. Não enviar `ca.key` ou `server.key` a funcionários; apenas o certificado público `ca.crt`.

```sh
APP_ORIGIN=https://localhost:3443 PORT=3443 \
TLS_CERT_FILE=.local/tls/server.crt TLS_KEY_FILE=.local/tls/server.key npm run start
```

Antes do Google, deve carregar a página de login com OIDC indisponível. Validar do cliente:

```sh
curl --cacert .local/tls/ca.crt https://localhost:3443/api/auth/config
curl --cacert .local/tls/ca.crt -I https://localhost:3443/
openssl x509 -in .local/tls/server.crt -noout -dates -ext subjectAltName
openssl x509 -in .local/tls/ca.crt -noout -fingerprint -sha256
```

Sem configurar OIDC, resposta esperada: `configured:false`; login/APIs protegidas bloqueados, sem token compartilhado ou identidade simulada. Trust do navegador é uma ação do proprietário: importar `ca.crt` num perfil dedicado de teste, comparar fingerprint por canal seguro e remover após homologação. Não clicar em “continuar mesmo assim”, não usar `curl -k`, `NODE_TLS_REJECT_UNAUTHORIZED=0` ou `ignoreHTTPSErrors`. O teste automatizado rejeita a CA desconhecida e aceita somente a CA fornecida explicitamente.

O servidor entrega `dist` diretamente pela mesma origem HTTPS, com CSP self-only, `nosniff`, bloqueio de frames e HSTS curto. Não usar Vite para homologação compartilhada. Para túnel autorizado, manter a mesma porta/origem:

```sh
ssh -N -L 3443:127.0.0.1:3443 usuario@host-de-desenvolvimento
```

Esse comando documenta uma opção de acesso; nenhum túnel/host externo foi criado nesta tarefa.

## 3. Configuração Google Workspace — proprietário

Não foi solicitado nem usado nenhum segredo real. O proprietário deve usar projeto OAuth **de desenvolvimento/homologação**, consentimento interno do Workspace quando disponível e tipo de cliente **Web application**. Configurar no processo runtime/arquivo protegido do ambiente:

```dotenv
APP_ORIGIN=https://localhost:3443
PORT=3443
TLS_CERT_FILE=.local/tls/server.crt
TLS_KEY_FILE=.local/tls/server.key
OIDC_ISSUER=https://accounts.google.com
OIDC_CLIENT_ID=<id-do-cliente-de-homologacao>.apps.googleusercontent.com
OIDC_CLIENT_SECRET=<segredo-injetado-por-meio-seguro>
OIDC_HOSTED_DOMAIN=<dominio-workspace-autorizado>
```

Não copiar placeholders como credenciais; não versionar esse arquivo ou escrever valores em tickets/chat/logs. Redirect URI no Google deve ser **exatamente** `https://localhost:3443/api/auth/callback`. HTTP e HTTPS, porta, hostname e path não são intercambiáveis. Scopes: `openid email profile`; não há acesso a Chat, Meet, Drive ou processamento de IA. O `hd` enviado ao Google é dica; o claim assinado é validado no retorno. Estar no domínio **não** substitui convite/vínculo no banco.

Rede: discovery/authorization em `accounts.google.com`, troca em `oauth2.googleapis.com`, JWKS em `www.googleapis.com` conforme metadata oficial. Adicionar apenas os domínios exigidos às configurações de egress; não remover proxy nem desabilitar TLS. O navegador dos funcionários precisa acessar a tela Google; o servidor precisa alcançar discovery/token/JWKS. Respostas 403 de rede devem ser diagnosticadas antes de mudar credenciais. Essas permissões e o cliente Google real ainda dependem do proprietário.

```sh
npm run homologation:check
```

Esse check é **offline**: exige HTTPS, issuer Google exato, formato de client ID, domínio `hd`, presença dos arquivos TLS e runtime restrito. Sucesso não prova segredo válido, consentimento, registro de redirect, trust do navegador ou login no Google. Sem configuração, retorna código 2 com a exigência faltante, sem imprimir segredo. Validar o certificado com os comandos da seção 2.

Primeiro administrador, com configuração OIDC pronta e credenciais de migrations mantidas fora do runtime:

```sh
npm run bootstrap:admin -- --email admin@dominio-da-catus.example --name 'Administrador de homologação'
```

O script é offline, auditado como bootstrap, recusa criar outro primeiro administrador e ainda exige autenticação Google para entrar. Criar/autorizar demais funcionários pela UI de acesso.

## 4. Checklist de aceite — A, B e C

Registrar evidência com SHA, data, versão de migration, papel, ação, resultado esperado/observado e ID do evento de auditoria. Nunca incluir cookies, tokens, client secret ou chave privada nas capturas. Somente dados de cliente/projeto sintéticos.

| Passo | Identidade/ação                                                                          | Resultado esperado                                                                                                |
| ----- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1     | A: administrador previamente provisionado; login Google em perfil próprio                | Nome/email/organização corretos; cookie `__Host-catus_session`, HttpOnly, Secure, SameSite=Lax; sessão individual |
| 2     | A autoriza B como desenvolvedor                                                          | B pertence somente à organização permitida; evento identifica A                                                   |
| 3     | A registra cliente, projeto, reunião e solicitação atribuída a B                         | Fluxo M0 íntegro; título/responsável/estado/próxima ação corretos                                                 |
| 4     | A tria e marca `ready`; B entra em perfil separado                                       | B lê operação da sua organização e vê somente ações permitidas                                                    |
| 5     | B executa a solicitação atribuída, altera próxima ação e conclui conforme transições     | Mudanças persistidas e autoria de B na auditoria; reload conserva sessão válida                                   |
| 6     | B tenta criar cliente/gerenciar membros ou reatribuir solicitação                        | 403, nenhuma escrita/evento de sucesso                                                                            |
| 7     | A ou B tenta alterar seus papéis/organização via payload/headers                         | Recusa; IDs/papéis do frontend não viram autoridade                                                               |
| 8     | C: usuário do mesmo domínio Workspace, **não convidado**, em perfil separado             | Google pode autenticar, mas Catus nega acesso com 403 e não emite sessão válida                                   |
| 9     | Duas organizações nos testes automáticos; IDs estrangeiros em vínculos/updates/auditoria | Sem vazamento; recursos externos inexistentes/recusados, conforme testes negativos                                |
| 10    | A revoga B; B tenta atualizar/recarregar                                                 | 401; nenhuma nova alteração de negócio                                                                            |
| 11    | A/B saem; repetir requisição com sessão antiga em teste controlado                       | Sessão revogada no banco, não apenas cookie removido                                                              |
| 12    | POST repetido com mesma Idempotency-Key UUID e mesmo corpo                               | Mesmo ID/resposta, um único registro e evento; corpo diferente com mesma chave: 409                               |
| 13    | Testar limite de forma controlada em ambiente descartável                                | 429 com Retry-After; spoof de X-Forwarded-For não renova cota; limites não somem ao reiniciar                     |
| 14    | Worker ativo; sessões vencidas/revogadas e states expirados                              | Limpeza em lotes sem remover sessões ativas, negócio ou auditoria                                                 |
| 15    | Backup/restauração descartável da seção abaixo                                           | Conteúdo de negócio/auditoria conferido; sessões restauradas invalidadas                                          |

A exerce operações de PO como administrador. Se for necessário homologar o papel PO literal, o administrador autoriza uma conta PO adicional; ninguém deve demover a si mesmo para contornar a proteção do último administrador. Os testes automatizados já exercitam PO e desenvolvedor explicitamente.

Não coletar cookies reais para provar cenários negativos: preferir fixtures automáticos e inspeção de atributos no browser. A homologação corporativa só pode ser marcada aceita quando as etapas Google reais forem executadas pelo proprietário.

## 5. Limites, idempotência e manutenção

- Cotas padrão por **peer TCP real**: 20 requisições de autenticação/config/callback por minuto, 300 de API por minuto. Persistência e incremento atômico no PostgreSQL, antes da transação operacional; tentativas negadas/rollback contam. Uma origem/túnel/NAT compartilhada divide a cota. Não confiar em Forwarded/X-Forwarded-For, não configurar proxy remoto implicitamente.
- Criações de clientes, projetos, atendimentos e solicitações exigem header `Idempotency-Key` UUID. Escopo: organização + usuário + rota + chave, hash canônico do JSON, resposta gravada na mesma transação da criação/auditoria. Retry com mesmo corpo retorna 201 e o mesmo ID; replay é indicado em header. Revogação/papel/CSRF são revalidados antes de replay. Falhas não gravam sucesso.
- TTL de idempotência: 24h; chave expirada ainda presente retorna 409. Após remoção pela retenção, a garantia da chave terminou. Após 24h, conferir registro antes de repetir e gerar nova chave conscientemente. Não tratar idempotência como deduplicação permanente.
- Frontend conserva chave e corpo para retry da tentativa em memória até obter sucesso. Recarregar/fechar a aba perde a chave: consultar Mission Control antes de recriar, pois não há outbox persistente no browser.

```sh
npm run cleanup -- --once
npm run cleanup
```

Segundo comando é worker separado, a cada 60s, com conta de manutenção e batches de até 500 por tabela. Advisory lock impede dois ciclos simultâneos; statement timeout 5s. Remove sessões expiradas, inativas há 30min ou revogadas, states vencidos, keys >24h e rate buckets sem uso há 1 dia. Não é servidor HTTP e não roda dentro do runtime. Mantê-lo supervisionado pelo operador; sem worker a expiração continua aplicada na autenticação, mas as linhas acumulam. Não existe job agendado externamente nesta tarefa.

## 6. Backup e restauração descartável

Clients PostgreSQL oficiais 18.3, fixados por digest. O Docker usa somente conexão ao banco local (host networking para loopback), nenhum acesso externo dentro do container e nenhuma porta publicada. Preserva validação TLS/checksums do pull.

```sh
docker --host=unix:///var/run/docker.sock pull postgres@sha256:7e32e9833a6fb1c92c32552794cb6ed569d51b445a54907d35fc112ef39684db
npm run backup:key
npm run backup -- .local/backups/homologacao.catus
npm run restore:prepare
npm run restore:test -- .local/backups/homologacao.catus
```

`backup:key` cria 32 bytes aleatórios em `.local/backup.key` 0600 e recusa sobrescrever; manter cópia em cofre **separada do backup**. Perda da chave impede restauração. Arquivo pg_dump custom é criptografado em streaming com AES-256-GCM; nonce aleatório, autenticação, arquivo 0600, fsync e publicação por rename. Falha não deixa arquivo final com aparência de sucesso. Não sobrescreve destino existente. Backups incluem dados pessoais/auditoria: aplicar política de acesso, retenção e armazenamento definida pelo proprietário.

Restore só aceita banco local descartável com nome terminado em `_restore_test`, vazio. `restore:prepare` cria `catus_homolog_restore_test` e papéis próprios; se já existir, recusa, **nunca apaga ou sobrescreve**. Pode-se selecionar outro nome `catus_<identificador>_restore_test` via `RESTORE_DATABASE_NAME`. Credenciais ficam em `.local/restore.env`. A chave/tag GCM são verificadas **antes** de executar pg_restore. Restore usa uma transação, sem owners/ACLs do arquivo; limpa sessões, states, rate buckets e cache idempotente, depois concede grants mínimos ao runtime de destino. Não reanima cookies antigos. Business data, membros e auditoria são preservados. Não é um comando de recuperação de produção.

Os testes descartáveis comparam linhas de clientes, projetos, atendimentos, solicitações, usuários, membros e auditoria antes/depois; tentam arquivo adulterado e alvo não vazio; confirmam ausência de sessões no destino. O operador deve repetir antes do aceite e registrar duração/contagens. Não houve simulação de dump: pg_dump e pg_restore reais foram executados. Não há restauração testada de backups históricos anteriores ao schema M1.1; para eles, planejar migration/ensaio separado antes de uso.

## 7. Bateria reproduzível e pendências do proprietário

Com portas 3000/5173 livres e PostgreSQL ativo:

```sh
npm run test:db
npm run check
npm run build
# Gerar TLS apenas se ainda não houver arquivos; não sobrescrever material existente.
test -f .local/tls/server.crt || npm run tls:local
npm test
npm run format:check
npx playwright install chromium
npm run test:e2e
```

A suíte exige CA local gerada e imagem PostgreSQL acima. Testes de operação criam/removem bancos/roles descartáveis únicos; o teste base `catus_test` é truncado e nunca pode ser o banco do aplicativo. Chromium externo compatível pode ser fornecido por CHROMIUM_PATH, mantendo verificações de TLS da suíte HTTPS ativas.

Pendente do proprietário: cliente/consentimento/segredo Google de homologação, domínio Workspace, egress, distribuição segura de CA/confiança dos navegadores, contas A/B/C e aceite manual. No host compartilhado, também isolamento de SO/segredos e supervisão do worker. Não alterar main/default, fazer merge, iniciar M2 ou publicar aplicação na Internet durante esse procedimento.

## Atualização M2

O atendimento inteligente foi implementado após autorização explícita, sem alterar os requisitos de homologação acima. Para política de dados, credenciais LLM, nova conta AI worker, testes sintéticos e aceite externo, seguir [AI_INTAKE.md](AI_INTAKE.md). Isto não autoriza dados reais nem confirma login Google/LLM real.
