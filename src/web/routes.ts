// Hash routes for the single-page app. Hash URLs need no server fallback, survive
// reloads and keep the OIDC callback (which always returns to "/") untouched.
// Visibility by role mirrors the API rules for convenience only: the server
// authorizes every call, so a hidden route is never a security boundary.
import type { Role } from '../shared/identity';

export const routeIds = [
  'mission-control',
  'solicitacoes',
  'clientes',
  'comercial',
  'economia',
  'atendimento-inteligente',
  'acesso',
  'auditoria',
  'entrega',
] as const;
export type RouteId = (typeof routeIds)[number];

export interface RouteDef {
  id: RouteId;
  label: string;
  eyebrow: string;
  title: string;
  description: string;
  roles?: readonly Role[];
}

const nonDeveloper: readonly Role[] = ['administrator', 'manager', 'po'];
export const routes: readonly RouteDef[] = [
  {
    id: 'mission-control',
    label: 'Mission Control',
    eyebrow: 'OPERAÇÃO / VISÃO GERAL',
    title: 'Mission Control',
    description: 'Da conversa à próxima ação, com contexto e responsabilidade.',
  },
  {
    id: 'solicitacoes',
    label: 'Solicitações',
    eyebrow: 'OPERAÇÃO / EXECUÇÃO',
    title: 'Solicitações',
    description: 'Acompanhe responsáveis, estados e próximas ações.',
  },
  {
    id: 'clientes',
    label: 'Clientes e projetos',
    eyebrow: 'OPERAÇÃO / CADASTROS',
    title: 'Clientes e projetos',
    description: 'Cadastros, atendimentos e histórico por projeto.',
  },
  {
    id: 'comercial',
    label: 'Comercial',
    eyebrow: 'GOVERNANÇA / COMERCIAL',
    title: 'Comercial',
    description: 'Contratos, escopos, aprovações e cobertura das demandas.',
  },
  {
    id: 'economia',
    label: 'Economia',
    eyebrow: 'GOVERNANÇA / ECONOMIA',
    title: 'Economia',
    description: 'Horas, custos, capacidade e rentabilidade.',
  },
  {
    id: 'atendimento-inteligente',
    label: 'Atendimento inteligente',
    eyebrow: 'ENTRADA / IA ASSISTIDA',
    title: 'Atendimento inteligente',
    description:
      'Propostas da IA a partir de atendimentos, com revisão humana.',
    roles: nonDeveloper,
  },
  {
    id: 'acesso',
    label: 'Acesso e usuários',
    eyebrow: 'ADMINISTRAÇÃO / ACESSO',
    title: 'Acesso e usuários',
    description: 'Membros da organização e seus papéis.',
    roles: ['administrator'],
  },
  {
    id: 'auditoria',
    label: 'Auditoria',
    eyebrow: 'ADMINISTRAÇÃO / RASTREABILIDADE',
    title: 'Auditoria',
    description: 'Quem fez o quê, quando e em qual registro.',
    roles: ['administrator', 'manager'],
  },
  {
    id: 'entrega',
    label: 'Entrega agêntica',
    eyebrow: 'ENTREGA / EXPERIMENTAL',
    title: 'Entrega agêntica',
    description: 'Execução assistida em ambiente isolado, com revisão humana.',
  },
];

export const routeById = Object.fromEntries(
  routes.map((r) => [r.id, r]),
) as Record<RouteId, RouteDef>;

export function allowed(id: RouteId, role: Role) {
  const roles = routeById[id].roles;
  return !roles || roles.includes(role);
}

export function href(id: RouteId, query?: Record<string, string>) {
  const q = new URLSearchParams(
    Object.entries(query ?? {}).filter(([, v]) => v),
  ).toString();
  return `#/${id === 'mission-control' ? '' : id}${q ? '?' + q : ''}`;
}

// Anchors of the former single-page layout (#comercial, #registro, ...) keep working.
const legacy: Record<string, RouteId> = {
  solicitacoes: 'solicitacoes',
  registro: 'clientes',
  clientes: 'clientes',
  comercial: 'comercial',
  economia: 'economia',
  ia: 'atendimento-inteligente',
  acesso: 'acesso',
  auditoria: 'auditoria',
  entrega: 'entrega',
};

export interface Location {
  /** null when the hash names no known route. */
  id: RouteId | null;
  query: URLSearchParams;
  /** Canonical hash to replace the current one with (legacy anchors). */
  canonical?: string;
}

export function parse(hash: string): Location {
  const raw = hash.replace(/^#/, '');
  if (!raw || raw === '/')
    return { id: 'mission-control', query: new URLSearchParams() };
  if (!raw.startsWith('/')) {
    const id = legacy[raw];
    return id
      ? { id, query: new URLSearchParams(), canonical: href(id) }
      : { id: null, query: new URLSearchParams() };
  }
  const [path = '', search = ''] = raw.slice(1).split('?', 2);
  const id = (routeIds as readonly string[]).includes(path)
    ? (path as RouteId)
    : null;
  return { id, query: new URLSearchParams(search) };
}

const RETURN_KEY = 'catus.returnTo';
/** Remembers a deep link across the OIDC round trip, which returns to "/". */
export function rememberReturn(hash: string) {
  const { id } = parse(hash);
  if (id && id !== 'mission-control') sessionStorage.setItem(RETURN_KEY, hash);
}
export function takeReturn(): string | null {
  const hash = sessionStorage.getItem(RETURN_KEY);
  sessionStorage.removeItem(RETURN_KEY);
  return hash && parse(hash).id ? hash : null;
}
