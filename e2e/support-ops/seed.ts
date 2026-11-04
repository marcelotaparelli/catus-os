import type { Browser, Page } from '@playwright/test';
import pg from 'pg';
import { login } from '../login';
import { api } from '../support-ux/meter';

// Synthetic agency for the operational journeys: same people and data for the
// before and after runs. Only the disposable test database is ever reached.
export const PEOPLE = {
  admin: 'ops.admin@browser.test',
  manager: 'ops.gestor@browser.test',
  commercial: 'ops.comercial@browser.test',
  po: 'ops.po@browser.test',
  dev: 'ops.dev@browser.test',
  dev2: 'ops.dev2@browser.test',
} as const;
export type Who = keyof typeof PEOPLE;

export function testDb() {
  const url = process.env.TEST_DATABASE_URL!;
  if (!/127\.0\.0\.1.*\/[a-z0-9_]*_test$/.test(url))
    throw new Error('Refusing a database that is not the disposable test one');
  return new pg.Pool({ connectionString: url, max: 2 });
}

export async function team(browser: Browser, width = 1280) {
  const pages = {} as Record<Who, Page>;
  for (const who of Object.keys(PEOPLE) as Who[]) {
    pages[who] = await (await browser.newContext()).newPage();
    await pages[who].setViewportSize({ width, height: 900 });
    await login(pages[who], PEOPLE[who]);
  }
  const members = await api<{ id: string; email: string }[]>(
    pages.admin,
    'members',
  );
  const ids = Object.fromEntries(
    (Object.keys(PEOPLE) as Who[]).map((who) => [
      who,
      members.find((m) => m.email === PEOPLE[who])!.id,
    ]),
  ) as Record<Who, string>;
  return { pages, ids };
}

export async function intake(po: Page, name: string) {
  const client = await api<{ id: string }>(po, 'clients', 'POST', { name });
  const project = await api<{ id: string }>(po, 'projects', 'POST', {
    client_id: client.id,
    name: `Loja ${name}`,
  });
  const interaction = await api<{ id: string }>(po, 'interactions', 'POST', {
    project_id: project.id,
    kind: 'service',
    summary: `Atendimento de ${name}`,
    occurred_at: new Date().toISOString(),
  });
  return { clientId: client.id, projectId: project.id, id: interaction.id };
}

export async function demand(
  po: Page,
  interaction: string,
  title: string,
  owner: string,
  extra: Record<string, unknown> = {},
) {
  return api<{ id: string; version: number }>(po, 'requests', 'POST', {
    interaction_id: interaction,
    title,
    description: `Descrição sintética: ${title}`,
    owner_user_id: owner,
    next_action: `Próximo passo de ${title}`,
    ...extra,
  });
}
