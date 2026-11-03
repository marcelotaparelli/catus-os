# Prova de regressão (teste negativo do pipeline)

- Commit `65ed7086dda2` (preservado na tag `ci-proof/checkbox-regression-65ed708`) remove de `src/web/style.css` a regra que mantém checkbox/radio ao lado do rótulo, reintroduzindo o defeito original do M3.
- CI [41605321219](https://github.com/marcelotaparelli/catus-os/actions/runs/41605321219), 03/11/2026: `validate` verde, `quality` **bloqueou** com 2 falhas:
  - `keyboard.spec.ts` › "M3 policy is operable with keyboard only": distância caixa/rótulo acima do limite;
  - `visual.spec.ts` › `m3-admin-1440.png`: 1140×1982 esperado, 1140×2021 recebido, 56.268 px diferentes.
- `m3-admin-1440-actual.png` (renderização regredida) e `m3-admin-1440-diff.png` (diferenças em vermelho) foram copiados do artefato `quality-evidence`, que expira em 14 dias.
