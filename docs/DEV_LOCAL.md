# Desenvolvimento local, sem Docker

| Ambiente                                | Como roda                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------- |
| Máquina de desenvolvimento (Arch Linux) | Nativo, com `bun run dev:local`                                            |
| GitHub Actions                          | Testes automatizados, incluindo Docker e G4                                |
| VPS                                     | Homologação e produção, com Docker Compose, HTTPS e PostgreSQL persistente |

## Uso

```sh
bun install --frozen-lockfile   # uma vez, e quando as dependências mudarem
bun run dev:local
```

Abra o endereço que aparece em `pronto:`, normalmente `http://127.0.0.1:5173`. **Ctrl+C** encerra tudo e preserva os dados.

Na máquina de desenvolvimento, Bun é o gerenciador e o comando recomendado, e o npm não é necessário. O CI e a imagem Docker da VPS continuam usando `npm ci` com `package-lock.json`, porque isso não muda com esta decisão. O CI confere os dois arquivos de versões, e hoje eles têm as mesmas versões.

O comando faz, nesta ordem, com o que já existe no repositório:

1. Cria o `.env` local, se faltar, e confere que nada aponta para fora desta máquina.
2. Sobe o PostgreSQL de `.local/postgres`, ou reutiliza o que já estiver rodando com esses dados.
3. Prepara os papéis do banco (`.local/database.env`) e aplica as migrations pendentes. Repetir não muda nada.
4. Inicia a API em Bun e o Vite, ambos com recarga ao salvar, com `/api` encaminhado para a porta que a API recebeu.

Para só preparar o banco, sem iniciar a aplicação: `bun run dev:local --prepare-only`.

## Dados

Ficam em `.local/postgres`, ignorado pelo Git, e passam de uma execução para outra. O `dev:local` não apaga, recria nem restaura nada. Ele só cria o banco na primeira vez.

## Segurança

- **Só banco local:** recusa qualquer variável `*DATABASE*_URL`, no `.env`, em `.local/database.env` ou no terminal, que não aponte para esta máquina e para `catus` ou `*_test`.
- **Mesma autenticação de produção:** a API sobe pelo mesmo `scripts/runtime.mjs`, com o papel de runtime sem privilégios e sem credenciais administrativas. Sem OIDC, o login fica bloqueado; não existe atalho de desenvolvimento.
- **Sem produção:** recusa `NODE_ENV=production`, `APP_ORIGIN` que não seja `http` em `127.0.0.1` ou `localhost`, e arquivos de TLS.
- **Segredos:** `.env` e `.local/database.env` ficam com permissão só para o dono, fora do Git.

## Portas

Uma porta ocupada nunca é motivo para mexer em quem a ocupa. O `dev:local` escolhe outra, avisa no terminal e não envia sinal nenhum a esse processo. Por isso ele funciona com as VMs dos agentes ligadas, inclusive quando uma delas expõe uma dessas portas no computador.

| Serviço    | Porta de sempre           | Alternativas | Observação                                                        |
| ---------- | ------------------------- | ------------ | ----------------------------------------------------------------- |
| API        | `PORT` do `.env`, 3000    | 3001 a 3099  | O proxy `/api` do Vite segue a porta escolhida                    |
| Vite       | A de `APP_ORIGIN`, 5173   | 5174 a 5199  | Com login Google, exige cadastrar o endereço novo (abaixo)        |
| PostgreSQL | A de `DATABASE_URL`, 5432 | 5433 a 5499  | `.local/database.env` acompanha a porta; senhas e dados não mudam |

- **Só neste computador:** os três escutam apenas em `127.0.0.1`. A porta alternativa vale só para esta execução, sem mudar a configuração de produção.
- **A porta pode mudar entre execuções.** Use sempre o endereço de `pronto:`, e a linha seguinte mostra as portas da API e do banco.
- **Outros comandos do banco:** `bun run migrate` e `bun run bootstrap:admin` usam a porta atual, por `.local/database.env`. Quem lê `DATABASE_URL` do `.env` continua apontando para a porta escrita lá.

Abrir o `dev:local` duas vezes no mesmo checkout é recusado, sem afetar o que já está rodando. Se uma execução morrer de forma abrupta, a seguinte encerra só o que for comprovadamente dela (mesmo diretório e mesmo programa) e reaproveita o banco.

## O aviso "Blocked 1 postinstall" do Bun

O Bun não roda scripts de instalação de dependências sem autorização. O bloqueado era o de `@embedded-postgres/linux-x64`, e **ele afeta o PostgreSQL**: sem esse script, o binário nem carrega (`libicui18n.so.60: cannot open shared object file`).

- **O que o script faz:** lê `native/pg-symlinks.json` e cria 14 links relativos para as bibliotecas do próprio pacote. Não usa rede nem executa nada baixado.
- **A autorização:** `trustedDependencies`, no `package.json`, lista só três pacotes. O `@embedded-postgres/linux-x64` é o novo. `bun` e `esbuild` já rodavam pela lista padrão do Bun, mas declarar o campo substitui essa lista, então precisam constar; sem eles, `node_modules/.bin/bun` para de funcionar. Os dois só baixam algo do npm se o binário da plataforma estiver faltando. Um teste falha se a lista crescer, e o CI falha se sobrar script bloqueado.
- **Em um `node_modules` que já existia:** `bun install --frozen-lockfile` diz "no changes" e não roda o script. Por isso o `dev:local` confere se o PostgreSQL carrega e, se não carregar, completa os mesmos links a partir da mesma lista, sem executar código do pacote e recusando qualquer caminho fora dele.
- **Em outra arquitetura ou sistema:** o pacote tem outro nome e não está autorizado. O `dev:local` para e explica; avalie antes de incluir o pacote em `trustedDependencies`.

## Login Google de desenvolvimento

Use um projeto e um cliente **só de desenvolvimento**. Nunca reaproveite as credenciais da VPS.

1. No [Google Cloud Console](https://console.cloud.google.com/), crie um projeto, por exemplo `catus-os-dev`.
2. Em **Google Auth Platform → Audience**, escolha **Internal**, se o projeto pertence à organização Workspace da Catus. Com **External** em status **Testing**, inclua sua conta em **Test users**.
3. Em **Google Auth Platform → Clients**, clique em **Create Client** e selecione **Web application**.
4. Em **Authorized redirect URIs**, cadastre exatamente:

   ```
   http://127.0.0.1:5173/api/auth/callback
   ```

   O Google só aceita `http` em endereços locais. Se usar `localhost` no `APP_ORIGIN`, o endereço cadastrado precisa ser o mesmo. Se a porta 5173 estiver ocupada, o `dev:local` avisa qual endereço cadastrar também; para não depender disso, cadastre alguns de antemão, como `5174` e `5175`.

5. Copie o ID e o segredo para o `.env`, que não vai para o Git:

   ```sh
   OIDC_ISSUER=https://accounts.google.com
   OIDC_CLIENT_ID=<id do cliente de desenvolvimento>
   OIDC_CLIENT_SECRET=<segredo do cliente de desenvolvimento>
   # Opcional e recomendado com Workspace: valida o claim assinado hd
   OIDC_HOSTED_DOMAIN=<seu dominio>
   ```

6. Reinicie o `bun run dev:local`, que passa a informar que o login está configurado.
7. Com ele rodando, em outro terminal, autorize o primeiro administrador uma vez:

   ```sh
   bun run bootstrap:admin --email voce@seu-dominio --name 'Seu Nome'
   ```

8. Entre em `http://127.0.0.1:5173` com essa conta. Os demais membros são autorizados pela própria tela de acesso.

O app pede só `openid email profile`. Quem não foi autorizado não entra, mesmo com uma conta Google válida.

**Erros comuns:**

| Mensagem                          | Causa                                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `redirect_uri_mismatch` no Google | O endereço cadastrado difere do que aparece em `pronto:`, inclusive na porta e entre `127.0.0.1` e `localhost` |
| `org_internal` no Google          | Cliente **Internal** com uma conta de fora da organização                                                      |
| "OIDC incompleto" no `dev:local`  | Falta uma das três variáveis `OIDC_*`                                                                          |

## Problemas

| Mensagem                                            | O que fazer                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| "Execute com seu usuário normal"                    | O PostgreSQL não roda como root                                                                   |
| "Dependências ausentes"                             | `bun install --frozen-lockfile`                                                                   |
| "aponta para ..."                                   | Remova essa URL do `.env`, de `.local/database.env` ou do terminal                                |
| "Roles already exist but credential file is absent" | `.local/database.env` foi apagado. Recupere o arquivo: as senhas não são redefinidas de propósito |
| "Existing role file does not match target"          | `.local/database.env` veio de outra instalação. Confira antes de mexer                            |
| "A porta ... está ocupada"                          | A mensagem diz por quem e como encerrar                                                           |

## Testes

```sh
bun run test:dev-local
```

Roda o fluxo inteiro em uma cópia descartável do repositório, sem tocar no seu `.env` nem no seu `.local/postgres`, e sem Docker: portas livres, portas ocupadas por outros processos, segunda execução, SIGINT, banco persistente e execução morta de forma abrupta. Precisa de 3000, 3001, 5173, 5174, 5432 e 5433 livres, por isso **não roda ao lado das VMs que ocupam essas portas**. As regras também têm testes unitários em `tests/dev-local.test.ts`, e o job `dev-local` roda o fluxo no CI.
