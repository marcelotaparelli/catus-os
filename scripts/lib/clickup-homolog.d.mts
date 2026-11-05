export const MARKER: string;
export const DEFAULT_ORGANIZATION: string;
export const MANAGED_KEYS: string[];
export function upsertEnv(text: string, values: Record<string, string>): string;
export function isInside(dir: string, path: string): boolean;
export const WORKER_PRIVILEGES: [string, string, boolean][];
export function formatReport(
  items: {
    status: 'ok' | 'pending' | 'fail';
    title: string;
    detail?: string;
  }[],
): string;
