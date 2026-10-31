import { timingSafeEqual } from 'node:crypto';
import { pool } from './db';
import { InputError } from '../shared/domain';
import { extractionCapability } from './extraction';
import { HttpError } from './errors';
import { getMissionControl } from './modules/mission-control';
import { createClient } from './modules/clients';
import { createProject } from './modules/projects';
import { createInteraction } from './modules/interactions';
import { createRequest, updateRequest } from './modules/requests';
function response(data: unknown, code = 200) {
  return Response.json(data, {
    status: code,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'X-Frame-Options': 'DENY',
    },
  });
}
export function createApp(token: string) {
  if (token.length < 32)
    throw new Error('DEV_TOKEN must contain at least 32 characters');
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const origin = request.headers.get('origin');
      if (
        origin &&
        ![
          'http://127.0.0.1:5173',
          'http://localhost:5173',
          'http://127.0.0.1:3000',
          'http://localhost:3000',
        ].includes(origin)
      )
        throw new HttpError(403, 'Origem não permitida');
      const supplied =
        request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      if (
        Buffer.byteLength(supplied) !== Buffer.byteLength(token) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
      )
        throw new HttpError(401, 'Token de desenvolvimento obrigatório');
      if (request.method === 'GET' && url.pathname === '/api/health') {
        await pool.query('SELECT 1');
        return response({ status: 'ok' });
      }
      if (request.method === 'GET' && url.pathname === '/api/extraction')
        return response(extractionCapability);
      if (request.method === 'GET' && url.pathname === '/api/mission-control') {
        return response(await getMissionControl());
      }
      if (!['POST', 'PATCH'].includes(request.method))
        throw new HttpError(404, 'Rota não encontrada');
      if (!request.headers.get('content-type')?.startsWith('application/json'))
        throw new HttpError(415, 'Use application/json');
      // Stream limit prevents oversized bodies even when Content-Length is absent or forged.
      const reader = request.body?.getReader();
      if (!reader) throw new InputError('Corpo obrigatório');
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 32768) {
            await reader.cancel();
            throw new HttpError(413, 'Corpo muito grande');
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString());
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new Error();
        body = parsed as Record<string, unknown>;
      } catch {
        throw new InputError('JSON inválido');
      }
      if (request.method === 'POST') {
        switch (url.pathname) {
          case '/api/clients':
            return response(await createClient(body), 201);
          case '/api/projects':
            return response(await createProject(body), 201);
          case '/api/interactions':
            return response(await createInteraction(body), 201);
          case '/api/requests':
            return response(await createRequest(body), 201);
        }
      }
      const match = /^\/api\/requests\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'PATCH' && match) {
        return response(await updateRequest(match[1]!, body));
      }
      throw new HttpError(404, 'Rota não encontrada');
    } catch (e) {
      if (e instanceof HttpError) return response({ error: e.message }, e.code);
      if (e instanceof InputError) return response({ error: e.message }, 422);
      const code = (e as { code?: string }).code;
      if (code === '23503')
        return response({ error: 'Vínculo não encontrado' }, 422);
      if (code === '22007' || code === '22008')
        return response({ error: 'Data inválida' }, 422);
      // Never return SQL, credentials, submitted text or internal errors.
      console.error('API failure', code ?? 'internal');
      return response({ error: 'Falha interna; tente novamente' }, 500);
    }
  };
}
