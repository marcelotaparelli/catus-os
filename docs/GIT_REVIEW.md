# Revisão M0, criação de main e integração M1

Estado inspecionado no início do M1: checkout limpo em `824c1e71753455703fd39a41065e8500cd8f3627`, na branch `feat/m0-mission-control`; implementação M0 em `369161a` e commit posterior apenas documental. O remoto anunciou somente `feat/m0-mission-control` e HEAD apontando para ela; nenhuma main existia. A branch M1 foi criada a partir desse estado, preservando ambos os commits.

## Procedimento proposto — executar somente após revisão e autorização

1. Revisar código M0 no commit `369161a` e documentação em `824c1e7`. Rodar sua suíte em ambiente isolado e banco local exclusivo; o M0 usa token local e não deve ser exposto.
2. Confirmar o SHA M0 aprovado; a proposta de baseline é `824c1e71753455703fd39a41065e8500cd8f3627`. Verificar novamente `git status --short`, `git log` e `git ls-remote --heads origin main`. Interromper se main tiver sido criada ou o estado divergir; nunca usar force push/reset para resolver divergência.
3. **Com autorização explícita para criar main**, criar apenas o ref da branch principal no commit M0 revisado, sem incluir M1:

   ```sh
   git branch main 824c1e71753455703fd39a41065e8500cd8f3627
   git push origin refs/heads/main:refs/heads/main
   ```

   Esses comandos estão documentados, não foram executados nesta tarefa. Não é necessário trocar o checkout nem fazer merge para criar esse ref. Se uma main local já existir, conferir seu conteúdo e não sobrescrever.

4. Após autorização separada, um administrador do repositório altera a branch padrão para main na interface do GitHub e configura proteção: PR obrigatório, checks de CI, sem force push e revisão humana. Criar main não autoriza mudar a branch padrão.
5. Abrir PR de `feat/m1-identity-security` contra main, conferindo diff e histórico. Enquanto main não existir, pode-se revisar o diff contra `feat/m0-mission-control`, sem integrar automaticamente nessa branch.
6. Confirmar CI no GitHub, revisar migration e riscos, fazer backup/restauração de teste antes de qualquer migração de ambiente compartilhado. Merge somente por ação autorizada do mantenedor, sem deploy automático.

## Evidência de CI

O workflow `Validate M1` executa instalação congelada, init, PostgreSQL, migrations do aplicativo e banco de teste separado, typecheck, testes, build, formatação e Playwright. O harness OIDC existe somente em testes. As mesmas etapas de código/testes são executadas localmente e registradas em PROGRESS.md.

A tentativa de `gh run list --branch feat/m0-mission-control` recebeu `Forbidden`; a conexão HTTPS a `api.github.com` foi negada pelo proxy com 403 antes de atingir o serviço. A página pública github.com pôde ser lida como alternativa: run M0 `41203424635` falhou na etapa de instalação do Chromium. O M1 fixa runner Ubuntu 24.04 e actions com runtime Node 24; sua execução será acompanhada pela página pública. A API segue bloqueada e logs completos exigem acesso adicional. Git via proxy HTTPS funciona; isso não fornece token genérico de API. Não foi solicitado ou extraído token pessoal. Para observar execuções pelo CLI neste ambiente, a política de rede precisa permitir `api.github.com` e a plataforma deve fornecer autorização de leitura apropriada; alternativamente, um mantenedor pode revisar a execução na interface do GitHub. Não reportar CI remoto aprovado sem observar a execução correspondente.
