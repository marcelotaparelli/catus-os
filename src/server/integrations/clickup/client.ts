/**
 * ClickUp API v2 read-only transport.
 *
 * No automatic credentials, writes or background polling. This module cannot
 * mutate the external workspace. A future application service must enforce
 * organization authorization and persist snapshots before exposing them.
 */
export interface ClickUpTaskSnapshot {
  externalId: string;
  externalListId: string;
  title: string;
  status: string;
  assigneeIds: string[];
  parentExternalId: string | null;
  dueAtMs: number | null;
  updatedAtMs: number | null;
  estimatedMs: number | null;
  trackedMs: number | null;
}

export interface ClickUpTaskPage {
  tasks: ClickUpTaskSnapshot[];
  page: number;
  lastPage: boolean;
}

export type ClickUpErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'upstream_error'
  | 'network_error'
  | 'invalid_response';

export class ClickUpApiError extends Error {
  constructor(
    readonly code: ClickUpErrorCode,
    readonly retryable: boolean,
  ) {
    super(`ClickUp integration: ${code}`);
    this.name = 'ClickUpApiError';
  }
}

type Fetcher = typeof fetch;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function milliseconds(value: unknown): number | null {
  const number =
    typeof value === 'string' && /^\\d+$/.test(value)
      ? Number(value)
      : value;
  return typeof number === 'number' &&
    Number.isSafeInteger(number) &&
    number >= 0
    ? number
    : null;
}

function normalizeTask(value: unknown, listId: string): ClickUpTaskSnapshot {
  const task = record(value);
  if (
    !task ||
    typeof task.id !== 'string' ||
    !task.id ||
    typeof task.name !== 'string'
  ) {
    throw new ClickUpApiError('invalid_response', false);
  }
  const statusValue = record(task.status)?.status;
  const status =
    typeof statusValue === 'string'
      ? statusValue
      : typeof task.status === 'string'
        ? task.status
        : '';
  const assignees = Array.isArray(task.assignees)
    ? task.assignees.flatMap((assignee: unknown) => {
        const id = record(assignee)?.id;
        if (typeof id === 'string' && id) return [id];
        if (typeof id === 'number' && Number.isSafeInteger(id))
          return [String(id)];
        return [];
      })
    : [];

  return {
    externalId: task.id,
    externalListId: listId,
    title: task.name,
    status,
    assigneeIds: assignees,
    parentExternalId:
      typeof task.parent === 'string' && task.parent ? task.parent : null,
    dueAtMs: milliseconds(task.due_date),
    updatedAtMs: milliseconds(task.date_updated),
    estimatedMs: milliseconds(task.time_estimate),
    trackedMs: milliseconds(task.time_spent),
  };
}

export class ClickUpReadClient {
  constructor(
    private readonly token: string,
    private readonly fetcher: Fetcher = fetch,
    private readonly timeoutMs = 15000,
  ) {
    if (!token || !token.trim())
      throw new Error('ClickUp token must be explicitly configured');
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1000 ||
      timeoutMs > 60000
    )
      throw new Error('Invalid ClickUp timeout');
  }

  async listTasksPage(
    listId: string,
    page = 0,
  ): Promise<ClickUpTaskPage> {
    if (!/^\\d{1,20}$/.test(listId))
      throw new Error('Invalid ClickUp list ID');
    if (!Number.isSafeInteger(page) || page < 0 || page > 9999)
      throw new Error('Invalid ClickUp page');

    const url = new URL(
      `https://api.clickup.com/api/v2/list/${listId}/task`,
    );
    url.searchParams.set('page', String(page));
    url.searchParams.set('subtasks', 'true');
    url.searchParams.set('include_closed', 'true');

    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: 'GET',
        headers: {
          Authorization: this.token,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Do not expose request headers, token or upstream response in errors.
      throw new ClickUpApiError('network_error', true);
    }
    if (!response.ok) {
      if (response.status === 401)
        throw new ClickUpApiError('unauthorized', false);
      if (response.status === 403)
        throw new ClickUpApiError('forbidden', false);
      if (response.status === 429)
        throw new ClickUpApiError('rate_limited', true);
      throw new ClickUpApiError(
        'upstream_error',
        response.status >= 500 || response.status === 408,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ClickUpApiError('invalid_response', false);
    }
    const body = record(payload);
    if (!body || !Array.isArray(body.tasks) || body.tasks.length > 100)
      throw new ClickUpApiError('invalid_response', false);
    return {
      tasks: body.tasks.map((task: unknown) => normalizeTask(task, listId)),
      page,
      lastPage:
        typeof body.last_page === 'boolean'
          ? body.last_page
          : body.tasks.length < 100,
    };
  }
}
