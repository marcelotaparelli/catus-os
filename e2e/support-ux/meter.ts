import type { Browser, Locator, Page } from '@playwright/test';
import { login } from '../login';
import { buildEcommerceScenario } from '../../tests/support/ecommerce-scenario';
import type { Actor } from '../../tests/support/ecommerce-scenario';

// Measures real task effort: every action goes through the browser and is counted as it
// runs. One click per click; a native select costs two (open, choose); each typed field
// counts once. Shared by the before and after runs so both use the same rule and data.
export const EMAILS: Record<Actor, string> = {
  admin: 'ux.admin@browser.test',
  manager: 'ux.gestor@browser.test',
  po: 'ux.po@browser.test',
  dev: 'ux.dev@browser.test',
  dev2: 'ux.dev2@browser.test',
};
export const PENDING_RATE_SOURCE = 'SINTÉTICO · custo de Bia a conferir';

export class Meter {
  clicks = 0;
  fields = 0;
  async click(target: Locator) {
    await target.click();
    this.clicks += 1;
  }
  async select(target: Locator, value: string | { label: string }) {
    await target.selectOption(value);
    this.clicks += 2;
  }
  async fill(target: Locator, value: string) {
    await target.fill(value);
    this.fields += 1;
  }
}

export async function api<T>(
  page: Page,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  return page.evaluate(
    async ({ path, method, body }) => {
      const s = await (await fetch('/api/session')).json();
      const r = await fetch('/api/' + path, {
        method,
        headers: {
          'X-CSRF-Token': s.csrfToken,
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok)
        throw new Error(
          `${method} ${path}: ${r.status} ${JSON.stringify(json)}`,
        );
      return json;
    },
    { path, method, body },
  );
}

/** Same agency for both runs, plus one pending record for the decision tasks. */
export async function agency(browser: Browser) {
  const pages = {} as Record<Actor, Page>;
  for (const who of Object.keys(EMAILS) as Actor[]) {
    pages[who] = await (await browser.newContext()).newPage();
    await pages[who].setViewportSize({ width: 1280, height: 900 });
    await login(pages[who], EMAILS[who]);
  }
  const members = await api<{ id: string; email: string }[]>(
    pages.admin,
    'members',
  );
  const people = Object.fromEntries(
    (Object.keys(EMAILS) as Actor[]).map((who) => [
      who,
      members.find((m) => m.email === EMAILS[who])!.id,
    ]),
  ) as Record<Actor, string>;
  await buildEcommerceScenario(
    (who, path, method = 'GET', body) => api(pages[who], path, method, body),
    people,
  );
  // After the scenario's period: an approved rate cannot overlap another one.
  const day = (n: number) =>
    new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  await api(pages.manager, 'economics/records', 'POST', {
    kind: 'rate',
    project_id: null,
    currency: 'BRL',
    valid_from: day(300),
    valid_until: day(330),
    source: PENDING_RATE_SOURCE,
    payload: { user_id: people.dev2, role: null, minor_per_hour: '9500' },
    previous_id: null,
  });
  return { pages, people };
}

/** What the screen asks of the reader: size, visible controls and exposed identifiers. */
export async function screenFacts(page: Page) {
  return page.evaluate(() => {
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/;
    // A closed <details> keeps layout boxes for its content; only checkVisibility sees it.
    const controls = [
      ...document.querySelectorAll(
        'main button, main input, main select, main textarea, main summary',
      ),
    ].filter((e) =>
      e.checkVisibility({
        contentVisibilityAuto: true,
        visibilityProperty: true,
      }),
    );
    return {
      pageHeightPx: document.documentElement.scrollHeight,
      visibleControls: controls.length,
      visibleDisabledButtons: controls.filter(
        (e) => e instanceof HTMLButtonElement && e.disabled,
      ).length,
      buttonsWithUuid: controls.filter(
        (e) => e.tagName === 'BUTTON' && uuid.test(e.textContent ?? ''),
      ).length,
    };
  });
}

/** An uncovered demand whose project has terms and an approved scope item to link. */
export async function demandToCover(po: Page) {
  const snapshot = await api<{
    interactions: { id: string; project_id: string }[];
    requests: {
      id: string;
      title: string;
      interaction_id: string;
      commercial_coverage?: string;
    }[];
  }>(po, 'mission-control');
  const { scopes } = await api<{
    scopes: {
      project_id: string;
      state: string;
      items: { id: string }[];
    }[];
  }>(po, 'commercial');
  const { records } = await api<{
    records: { kind: string; project_id: string | null; decision: string }[];
  }>(po, 'economics');
  for (const r of snapshot.requests) {
    if (r.commercial_coverage !== 'pending_analysis') continue;
    const project = snapshot.interactions.find(
      (i) => i.id === r.interaction_id,
    )?.project_id;
    const scope = scopes.find(
      (s) => s.project_id === project && s.state === 'approved',
    );
    const terms = records.some(
      (x) =>
        x.kind === 'terms' &&
        x.decision === 'approved' &&
        x.project_id === project,
    );
    if (scope && terms)
      return {
        id: r.id,
        title: r.title,
        itemId: scope.items[0]!.id,
        itemCount: scope.items.length,
      };
  }
  throw new Error('scenario has no demand left to cover');
}

/** A demand on a project with approved terms and no estimate yet: a real PO task. */
export async function demandToEstimate(po: Page) {
  const snapshot = await api<{
    projects: { id: string; name: string }[];
    interactions: { id: string; project_id: string }[];
    requests: {
      id: string;
      title: string;
      interaction_id: string;
      owner_user_id: string | null;
      commercial_coverage?: string;
    }[];
  }>(po, 'mission-control');
  const { records } = await api<{
    records: {
      kind: string;
      project_id: string | null;
      decision: string | null;
      payload: Record<string, unknown>;
    }[];
  }>(po, 'economics');
  const estimated = new Set(
    records
      .filter((r) => r.kind === 'estimate')
      .map((r) => r.payload.request_id),
  );
  const withTerms = new Set(
    records
      .filter((r) => r.kind === 'terms' && r.decision === 'approved')
      .map((r) => r.project_id),
  );
  for (const r of snapshot.requests) {
    const project = snapshot.interactions.find(
      (i) => i.id === r.interaction_id,
    )?.project_id;
    if (
      project &&
      withTerms.has(project) &&
      !estimated.has(r.id) &&
      r.commercial_coverage === 'covered'
    )
      return {
        id: r.id,
        title: r.title,
        owner: r.owner_user_id,
        project: snapshot.projects.find((p) => p.id === project)!.name,
      };
  }
  throw new Error('scenario has no demand left to estimate');
}

/** Vertical distance between the justification field and the decision button. */
export async function distancePx(a: Locator, b: Locator) {
  const [ra, rb] = [await a.boundingBox(), await b.boundingBox()];
  return ra && rb ? Math.round(Math.abs(rb.y - ra.y)) : null;
}
