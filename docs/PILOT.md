# Piloto operacional controlado — M0–M4

Runbook para uma equipe pequena da Catus operar atendimento → solicitação → escopo/contrato → horas → rentabilidade em **homologação privada**. Não é produção, não publica serviço na Internet e não ativa IA (M2) nem agentes (M5). Detalhes de contas PostgreSQL, HTTPS, Google, limites, manutenção e backup ficam em [HOMOLOGATION.md](HOMOLOGATION.md); este documento define a ordem de execução, os portões de decisão e a rotina do piloto.

## 1. Escopo do piloto

| Incluído                                                                 | Fora do piloto                                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Clientes, projetos, reuniões/atendimentos, solicitações com responsável  | Atendimento inteligente com LLM (`LLM_ENABLED=false`)        |
| Triagem, execução e acompanhamento no Mission Control                    | Entrega agêntica M5 (`DELIVERY_ENABLED=false`, política OFF) |
| Contratos, versões de escopo, aprovações independentes e change requests | Dados reais de clientes enviados a terceiros                 |
| Premissas, taxas, estimativas, capacidade, horas, EAC/margens (gestor)   | Faturamento, contabilidade, câmbio, caixa                    |
| Auditoria operacional (admin/gestor) e históricos comercial/econômico    | Exposição pública, produção, merge/deploy automático         |

Dados: começar com clientes **sintéticos ou internos** até o portão G4. Números econômicos reais só depois que o gestor aprovar premissas com fonte documentada (ver [ECONOMICS.md](ECONOMICS.md)).

## 2. Portões (go/no-go)

| Portão | Condição                                                                                              | Quem         | Situação nesta branch                                                |
| ------ | ----------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------- |
| G1     | Bateria automatizada verde no CI da branch, incluindo `e2e/pilot-journey.spec.ts`                     | Engenharia   | CI verde no `783f19f` (85/85 + 6/6); conferir o HEAD em PROGRESS     |
| G2     | Host privado com PostgreSQL de homologação e administrador de senha forte (não `catus_local_only`)    | Proprietário | Pendente; [G2_HOST.md](G2_HOST.md) ou Docker: [DOCKER.md](DOCKER.md) |
| G3     | Cliente OAuth Google de homologação, `OIDC_HOSTED_DOMAIN`, redirect exato, egress Google, CA confiada | Proprietário | Pendente; login Google real **não verificado**                       |
| G4     | `deploy/g4.sh` com GO ([G4.md](G4.md)) + checklist humano de [PILOT_READINESS.md](PILOT_READINESS.md) | Proprietário | Executor automatizado pronto; execução no Arch pendente              |
| G5     | Backup criptografado + restore descartável ensaiados no host do piloto; chave em cofre separado       | Operador     | Pendente no host (validado no CI)                                    |
| G6     | Alçadas comerciais e premissas econômicas aprovadas por pessoas diferentes                            | Admin/gestor | Configuração inicial do piloto                                       |

Não iniciar uso pela equipe antes de G1–G5. Interromper o piloto (voltar a G4) se: login falhar por motivo não explicado, aparecer dado de outra organização, uma escrita for aceita sem autoria na auditoria, ou backup/restore falhar.

## 3. Preparar o host (operador)

Procedimento detalhado, modelos systemd e verificador somente leitura `scripts/g2-preflight.sh`: [G2_HOST.md](G2_HOST.md). Alternativa só com Docker Compose (Arch/Linux sem Node/PostgreSQL no host), com `deploy/catus.sh install|verify|backup|update`: [DOCKER.md](DOCKER.md).

Host Linux privado, usuário de SO dedicado e sem root para o PostgreSQL, Node ≥ 22.12, OpenSSL e Docker local (somente para clientes `pg_dump`/`pg_restore` fixados).

```sh
git clone https://github.com/marcelotaparelli/catus-os.git && cd catus-os
git switch feat/pilot-readiness
npm ci
npm run env:init            # preserva .env existente
```

Banco: use PostgreSQL de homologação com administrador forte (G2) e ajuste `DATABASE_URL` somente no ambiente do operador. O `npm run db` embutido serve apenas para ensaio descartável.

```sh
npm run db:roles            # cria runtime/migrator/maintenance; segredos em .local/database.env (0600)
npm run migrate             # 001–009, idempotente
npm run build
test -f .local/tls/server.crt || npm run tls:local
```

Configure no ambiente **do processo runtime** (nunca no Git): `APP_ORIGIN=https://localhost:3443`, `PORT=3443`, `TLS_CERT_FILE`, `TLS_KEY_FILE`, `OIDC_ISSUER=https://accounts.google.com`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_HOSTED_DOMAIN`. Mantenha `LLM_ENABLED=false` e `DELIVERY_ENABLED=false`.

```sh
npm run homologation:check  # offline; código 2 indica o item faltante sem imprimir segredo
```

## 4. Subir os serviços

Em terminais/serviços supervisionados separados:

```sh
npm run start               # build + API na mesma origem HTTPS, somente 127.0.0.1
npm run cleanup             # worker de retenção com conta de manutenção
```

O runtime recusa iniciar com conta PostgreSQL privilegiada e só recebe `RUNTIME_DATABASE_URL`. Integrantes acessam por túnel SSH autorizado, mantendo a mesma origem:

```sh
ssh -N -L 3443:127.0.0.1:3443 usuario@host-do-piloto
```

Verificação rápida (sem `-k`):

```sh
curl --cacert .local/tls/ca.crt https://localhost:3443/api/auth/config   # {"configured":true} após G3
```

## 5. Acesso da equipe

1. Operador provisiona o primeiro administrador (offline, auditado):
   `npm run bootstrap:admin -- --email admin@dominio --name 'Administrador Piloto'`
2. Administrador entra com Google e, em **Acesso**, autoriza cada integrante com papel mínimo: `po`, `developer`, `manager`. Pertencer ao domínio não dá acesso.
3. Administrador abre **Contratos e escopos → Configurar alçadas comerciais** e salva os papéis decisores (G6).
4. Gestor prepara **Horas e economia → Premissas econômicas** (calendário, tributos, comissões, overhead) e taxas por profissional; **outra pessoa** (admin) aprova. Os campos monetários usam unidades mínimas; a prévia ao lado mostra o valor formatado antes de enviar.

## 6. Rotina do piloto por papel

| Papel         | Onde                                       | O que faz                                                                                                    |
| ------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| PO            | Registrar atendimento                      | Cadastra cliente/projeto, registra reunião/atendimento e cria solicitação com **responsável e próxima ação** |
| PO            | Solicitações                               | Tria (`Nova → Em triagem → Pronta`); reabre/reatribui; consulta histórico em **Clientes e projetos**         |
| PO            | Contratos e escopos                        | Registra contrato, prepara/submete escopo, abre change request e vincula a cobertura da demanda              |
| PO            | Horas e economia                           | Estima minutos por demanda (sem ver taxas)                                                                   |
| Desenvolvedor | Solicitações → filtro **Atribuídas a mim** | Move para Em execução/Bloqueada/Concluída e atualiza a próxima ação; não reatribui                           |
| Desenvolvedor | Horas e economia → Apontar horas próprias  | Registra minutos por demanda; não vê custos                                                                  |
| Gestor        | Contratos e escopos                        | Ativa contratos e decide escopos/change requests preparados por outra pessoa                                 |
| Gestor        | Horas e economia                           | Aprova estimativas e horas (por nome), calcula a observação econômica e revisa EAC/margem/alertas            |
| Admin/Gestor  | Auditoria                                  | Confere quem fez o quê; históricos comerciais/econômicos ficam nos módulos                                   |

Conflito de edição: se duas pessoas editam a mesma solicitação, a segunda recebe aviso, vê os dados atuais e decide novamente; nada é sobrescrito em silêncio.

## 7. Backup e continuidade

Diariamente durante o piloto e antes de qualquer migration:

```sh
npm run backup -- .local/backups/piloto-$(date +%Y%m%d).catus
```

Ensaiar restore em banco descartável na primeira semana (G5) conforme HOMOLOGATION.md §6. Restore invalida sessões; ninguém precisa “religar” dados. Guardar a chave de backup fora do host.

## 8. Evidência automatizada da jornada

`e2e/pilot-journey.spec.ts` percorre a jornada inteira pela UI real com quatro papéis e dados sintéticos: atendimento → solicitação com responsável → contrato ativo → escopo V1 aprovado por outra pessoa → cobertura → triagem → conflito de edição concorrente → premissas/taxa/termos/capacidade/custo direto aprovados por outra pessoa → estimativa do PO → desenvolvedor executa e aponta horas → gestor aprova horas e calcula rentabilidade → Mission Control consistente para PO/gestor/desenvolvedor → auditoria por nome → negações de API (403) e layout móvel. As entradas espelham `e2e/economics.spec.ts`, montado via API; os resultados idênticos (EAC USD 3284,00, margem projetada USD 6716,00) validam a UI contra a API. O login usa apenas o provedor OIDC simulado do harness de teste (`NODE_ENV=test`) e **não comprova o Google real**.

```sh
npm test && npm run test:e2e   # sequencialmente; nunca em paralelo no mesmo banco de teste
```

## 9. Limitações conhecidas no piloto

- Clientes, projetos e atendimentos não podem ser renomeados ou excluídos pela UI; registre correções como novo atendimento.
- Listas mostram até 500 atendimentos/solicitações recentes e 500 eventos de auditoria; não há paginação.
- Fechar a aba durante uma criação perde a chave de idempotência em memória; confira o Mission Control antes de recriar.
- Cota de API é por endereço TCP; com túnel SSH compartilhado, todos dividem o limite (300 req/min).
- A interface não recarrega sozinha; use **Atualizar dados** para ver mudanças de outros integrantes.
