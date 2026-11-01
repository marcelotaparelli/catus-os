import { readFileSync } from 'node:fs';
import { validThemePath } from '../../shared/delivery';
export interface RepoRule {
  key: string;
  repository: string;
  base_branch: string;
  base_sha: string;
  allowed_paths: string[];
}
export interface DeliveryConfig {
  available: boolean;
  reason: string;
  repos: RepoRule[];
  fixture?: true;
}
export function deliveryConfig(
  env: NodeJS.ProcessEnv = process.env,
): DeliveryConfig {
  const repos: RepoRule[] = [];
  try {
    if (env.DELIVERY_REPOSITORIES_FILE) {
      const raw: unknown = JSON.parse(
        readFileSync(env.DELIVERY_REPOSITORIES_FILE, 'utf8'),
      );
      if (!Array.isArray(raw) || raw.length > 20) throw new Error();
      for (const r of raw) {
        if (
          !r ||
          typeof r.key !== 'string' ||
          !/^[a-z0-9-]{1,60}$/.test(r.key) ||
          !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(
            r.repository,
          ) ||
          !/^[a-zA-Z0-9_/-]{1,120}$/.test(r.base_branch) ||
          !/^[a-f0-9]{40}$/.test(r.base_sha) ||
          !Array.isArray(r.allowed_paths) ||
          !r.allowed_paths.length ||
          r.allowed_paths.length > 20 ||
          !r.allowed_paths.every(validThemePath)
        )
          throw new Error();
        repos.push({
          key: r.key,
          repository: r.repository,
          base_branch: r.base_branch,
          base_sha: r.base_sha,
          allowed_paths: r.allowed_paths,
        });
      }
    }
  } catch {
    return {
      available: false,
      reason: 'Registro de repositórios inválido',
      repos: [],
    };
  }
  // No claiming capability based only on a key: hardened runner, SDK and capped egress must be attested by operator.
  const ready =
    env.DELIVERY_ENABLED === 'true' &&
    env.DELIVERY_RUNNER_ATTESTATION === 'isolated-sdk-capped-gateway-v1' &&
    repos.length > 0;
  return {
    available: ready,
    reason: ready
      ? 'Runner próprio autorizado; execução Codex depende da credencial/gateway no runner'
      : 'Execução indisponível: requer runner isolado, SDK, credencial legítima e gateway com teto independente',
    repos,
  };
}
