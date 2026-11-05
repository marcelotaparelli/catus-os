type Env = Record<string, string | undefined>;
export function runtimeEnvironment(
  base: Env,
  local: Env,
  roles: Env,
): Record<string, string>;
export function workerEnvironment(
  base: Env,
  local: Env,
  roles: Env,
): Record<string, string>;
export function clickupWorkerEnvironment(
  base: Env,
  local: Env,
  roles: Env,
): Record<string, string>;
