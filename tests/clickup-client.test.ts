import { describe, expect, test } from 'bun:test';
import {
  ClickUpApiError,
  ClickUpReadClient,
} from '../src/server/integrations/clickup/client';

const response = (data: unknown, status = 200) =>
  Response.json(data, { status });

describe('ClickUp read-only transport', () => {
  test('loads a page without writing and normalizes only operational fields', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return response({
        tasks: [
          {
            id: 'abc123',
            name: 'Validar layout',
            status: { status: 'Em desenvolvimento' },
            assignees: [{ id: 123 }, { id: '456' }],
            parent: null,
            due_date: '1795000000000',
            date_updated: '1794000000000',
            time_estimate: 3600000,
            time_spent: 120000,
            description: 'Privado: não deve entrar no snapshot',
          },
        ],
        last_page: true,
      });
    }) as typeof fetch;
    const client = new ClickUpReadClient('test-only-token', fetcher);
    const page = await client.listTasksPage('123456', 2);
    expect(page).toEqual({
      page: 2,
      lastPage: true,
      tasks: [
        {
          externalId: 'abc123',
          externalListId: '123456',
          title: 'Validar layout',
          status: 'Em desenvolvimento',
          assigneeIds: ['123', '456'],
          parentExternalId: null,
          dueAtMs: 1795000000000,
          updatedAtMs: 1794000000000,
          estimatedMs: 3600000,
          trackedMs: 120000,
        },
      ],
    });
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe(
      'https://api.clickup.com/api/v2/list/123456/task?page=2&subtasks=true&include_closed=true',
    );
    expect(calls[0]?.init?.method).toBe('GET');
    expect(new Headers(calls[0]?.init?.headers).get('Authorization')).toBe(
      'test-only-token',
    );
    expect(JSON.stringify(page)).not.toContain('Privado');
  });

  test('rejects invalid identifiers and pages before using the network', async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return response({ tasks: [] });
    }) as typeof fetch;
    const client = new ClickUpReadClient('test-token', fetcher);
    await expect(client.listTasksPage('../not-a-list')).rejects.toThrow();
    await expect(client.listTasksPage('123', -1)).rejects.toThrow();
    await expect(client.listTasksPage('123', Number.NaN)).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test.each([
    [401, 'unauthorized', false],
    [403, 'forbidden', false],
    [429, 'rate_limited', true],
    [503, 'upstream_error', true],
  ] as const)(
    'maps HTTP %i into safe %s error',
    async (status, code, retryable) => {
      const client = new ClickUpReadClient(
        'very-secret-token',
        (async () => response({ token: 'very-secret-token' }, status)) as typeof fetch,
      );
      try {
        await client.listTasksPage('123');
        throw new Error('Expected API error');
      } catch (error) {
        expect(error).toBeInstanceOf(ClickUpApiError);
        const apiError = error as ClickUpApiError;
        expect(apiError.code).toBe(code);
        expect(apiError.retryable).toBe(retryable);
        expect(apiError.message).not.toContain('very-secret-token');
      }
    },
  );

  test('rejects malformed pages and does not silently trust provider data', async () => {
    for (const body of [
      {},
      { tasks: 'not-an-array' },
      { tasks: [{ id: null, name: 'Untrusted' }] },
      { tasks: Array.from({ length: 101 }, () => ({ id: 'x', name: 'x' })) },
    ]) {
      const client = new ClickUpReadClient(
        'test-token',
        (async () => response(body)) as typeof fetch,
      );
      await expect(client.listTasksPage('456')).rejects.toMatchObject({
        code: 'invalid_response',
      });
    }
  });

  test('network failure is retryable and does not expose sensitive details', async () => {
    const client = new ClickUpReadClient(
      'super-secret',
      (async () => {
        throw new Error('super-secret used in upstream request');
      }) as typeof fetch,
    );
    await expect(client.listTasksPage('456')).rejects.toMatchObject({
      code: 'network_error',
      retryable: true,
      message: 'ClickUp integration: network_error',
    });
  });

  test('empty list is reported as a completed page', async () => {
    const client = new ClickUpReadClient(
      'test-token',
      (async () => response({ tasks: [] })) as typeof fetch,
    );
    expect(await client.listTasksPage('123')).toEqual({
      tasks: [],
      page: 0,
      lastPage: true,
    });
  });

  test('fails closed without an explicitly configured token', () => {
    expect(() => new ClickUpReadClient('')).toThrow();
    expect(() => new ClickUpReadClient('  ')).toThrow();
  });
});
