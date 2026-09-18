import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { ERROR_CODES } from '@breeze/shared';
import { jsonError } from './jsonError';

describe('jsonError', () => {
  it('emits { error, code } with the prose message intact', async () => {
    const app = new Hono().get('/', (c) =>
      jsonError(c, 404, ERROR_CODES.NOT_FOUND, 'Device not found'),
    );
    const res = await app.request('/');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Device not found', code: 'NOT_FOUND' });
  });

  it('passes the status through unchanged', async () => {
    const app = new Hono().get('/', (c) =>
      jsonError(c, 409, ERROR_CODES.CONFLICT, 'Already exists'),
    );
    const res = await app.request('/');
    expect(res.status).toBe(409);
  });
});
