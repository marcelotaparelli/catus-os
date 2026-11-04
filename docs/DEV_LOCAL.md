# Desenvolvimento local, sem Docker

| Ambiente                                | Como roda                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------- |
| Máquina de desenvolvimento (Arch Linux) | Nativo, com `npm run dev:local`                                            |
| GitHub Actions                          | Testes automatizados, incluindo Docker e G4                                |
| VPS                                     | Homologação e produção, com Docker Compose, HTTPS e PostgreSQL persistente |

## Uso

```sh
npm ci            # uma vez, e quando as dependências mudarem
npm run dev:local
```

Abra `http://127.0.0.1:5173`. **Ctrl+C** encerra tudo e preserva os dados.

O comando faz, nesta ordem, com o que já existe no repositório:

1. Cria o `.env` local, se faltar, e confere que nada aponta para fora desta máquina.
2. Sobe o PostgreSQL de `.local/postgres`, ou reutiliza o que já estiver rodando com esses dados.
3. Prepara os papéis do banco (`.local/database.env`) e aplica as migrations pendentes. Repetir não muda nada.
4. Inicia a API em Bun e o Vite, ambos com recarga ao salvar.

Para só preparar o banco, sem iniciar a aplicação: `npm run dev:local -- --prepare-only`.

## Dados

Ficam em `.local/postgres`, ignorado pelo Git, e passam de uma execução para outra. O `dev:local` não apaga, recria nem restaura nada. Ele só cria o banco na primeira vez.

## Segurança

- **Só banco local:** recusa qualquer variável `*DATABASE*_URL`, no `.env`, em `.local/database.env` ou no terminal, que não aponte para esta máquina e para `catus` ou `*_test`.
- **Mesma autenticação de produção:** a API sobe pelo mesmo `scripts/runtime.mjs`, com o papel de runtime sem privilégios e sem credenciais administrativas. Sem OIDC, o login fica bloqueado; não existe atalho de desenvolvimento.
- **Sem produção:** recusa `NODE_ENV=production`, `APP_ORIGIN` diferente de `http://127.0.0.1:5173` ou `http://localhost:5173`, `PORT` diferente de 3000 e arquivos de TLS.
- **Segredos:** `.env` e `.local/database.env` ficam com permissão só para o dono, fora do Git.

## Portas

| Porta | Serviço    | Se estiver ocupada                                                                         |
| ----- | ---------- | ------------------------------------------------------------------------------------------ |
| 5432  | PostgreSQL | Reutiliza se for este `.local/postgres`. Se for outro serviço, para e diz qual, sem usá-lo |
| 3000  | API        | Para e diz qual processo está na porta                                                     |
| 5173  | Vite       | Para e diz qual processo está na porta                                                     |

Abrir o `dev:local` duas vezes no mesmo checkout é recusado, sem afetar o que já está rodando. Se uma execução morrer de forma abrupta, a seguinte encerra a API e o Vite que sobraram e reaproveita o banco, sem comando manual.

## Login Google de desenvolvimento

Use um projeto e um cliente **só de desenvolvimento**. Nunca reaproveite as credenciais da VPS.

1. No [Google Cloud Console](https://console.cloud.google.com/), crie um projeto, por exemplo `catus-os-dev`.
2. Em **Google Auth Platform → Audience**, escolha **Internal**, se o projeto pertence à organização Workspace da Catus. Com **External** em status **Testing**, inclua sua conta em **Test users**.
3. Em **Google Auth Platform → Clients**, clique em **Create Client** e selecione **Web application**.
4. Em **Authorized redirect URIs**, cadastre exatamente:

   ```
   http://127.0.0.1:5173/api/auth/callback
   ```

   O Google só aceita `http` em endereços locais. Se usar `localhost` no `APP_ORIGIN`, o endereço cadastrado precisa ser o mesmo.

5. Copie o ID e o segredo para o `.env`, que não vai para o Git:

   ```sh
   OIDC_ISSUER=https://accounts.google.com
   OIDC_CLIENT_ID=<id do cliente de desenvolvimento>
   OIDC_CLIENT_SECRET=<segredo do cliente de desenvolvimento>
   # Opcional e recomendado com Workspace: valida o claim assinado hd
   OIDC_HOSTED_DOMAIN=<seu dominio>
   ```

6. Reinicie o `npm run dev:local`, que passa a informar que o login está configurado.
7. Com ele rodando, em outro terminal, autorize o primeiro administrador uma vez:

   ```sh
   npm run bootstrap:admin -- --email voce@seu-dominio --name 'Seu Nome'
   ```

8. Entre em `http://127.0.0.1:5173` com essa conta. Os demais membros são autorizados pela própria tela de acesso.

O app pede só `openid email profile`. Quem não foi autorizado não entra, mesmo com uma conta Google válida.

**Erros comuns:**

| Mensagem                          | Causa                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `redirect_uri_mismatch` no Google | O endereço cadastrado difere do `APP_ORIGIN`, inclusive `127.0.0.1` e `localhost` |
| `org_internal` no Google          | Cliente **Internal** com uma conta de fora da organização                         |
| "OIDC incompleto" no `dev:local`  | Falta uma das três variáveis `OIDC_*`                                             |

## Problemas

| Mensagem                                            | O que fazer                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| "Execute com seu usuário normal"                    | O PostgreSQL não roda como root                                                                   |
| "Dependências ausentes"                             | `npm ci`                                                                                          |
| "aponta para ..."                                   | Remova essa URL do `.env`, de `.local/database.env` ou do terminal                                |
| "Roles already exist but credential file is absent" | `.local/database.env` foi apagado. Recupere o arquivo: as senhas não são redefinidas de propósito |
| "Existing role file does not match target"          | `.local/database.env` veio de outra instalação. Confira antes de mexer                            |
| "A porta ... está ocupada"                          | A mensagem diz por quem e como encerrar                                                           |

## Testes

```sh
npm run test:dev-local
```

Roda o fluxo inteiro em uma cópia descartável do repositório, sem tocar no seu `.env` nem no seu `.local/postgres`, e sem Docker. Precisa das portas 3000, 5173 e 5432 livres, então encerre o `dev:local` antes. As regras também têm testes unitários em `tests/dev-local.test.ts`, e o job `dev-local` roda o fluxo no CI.
