import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { DbAccessContextPrologueTimeoutError, DbPoolAcquireTimeoutError } from '../db/prologueDeadline';
import { dbSaturationResponse, findDbSaturationError } from './dbSaturationResponse';

// Built from the prototype so the test does not depend on either constructor's
// input shape (#8243 and W04 differ); `instanceof` is all the helper relies on.
const make = <T extends Error>(ctor: { prototype: T; name: string }, message: string): T =>
  Object.assign(Object.create(ctor.prototype) as T, { message, name: ctor.name });

function app(err: () => Error) {
  const a = new Hono();
  a.get('/x', () => {
    throw err();
  });
  a.onError((error, c) => dbSaturationResponse(error, c, () => 0) ?? c.json({ error: 'Internal Server Error' }, 500));
  return a;
}

describe('dbSaturationResponse', () => {
  it('answers a pool-acquire timeout with 503 + Retry-After 30..45 and no-store', async () => {
    const res = await app(() => make(DbPoolAcquireTimeoutError, 'pool saturated')).request('/x');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'Server busy; retry later', code: 'DB_POOL_SATURATED', retryAfterSeconds: 30 });
  });

  it('answers a prologue timeout the same way', async () => {
    expect((await app(() => make(DbAccessContextPrologueTimeoutError, 'prologue')).request('/x')).status).toBe(503);
  });

  it('finds the error through a cause chain, and nothing else', () => {
    const wrapped = new Error('route failed', { cause: new Error('mid', { cause: make(DbPoolAcquireTimeoutError, 'x') }) });
    expect(findDbSaturationError(wrapped)).toBe('pool_acquire_timeout');
    expect(findDbSaturationError(new Error('boom'))).toBeNull();
    expect(findDbSaturationError('not an error')).toBeNull();
  });

  it('leaves every other error to the existing 500 path', async () => {
    expect((await app(() => new Error('boom')).request('/x')).status).toBe(500);
  });

  it('keeps Retry-After inside 30..45', async () => {
    const a = new Hono();
    a.get('/x', () => { throw make(DbPoolAcquireTimeoutError, 'x'); });
    a.onError((error, c) => dbSaturationResponse(error, c, () => 0.999)!);
    expect((await a.request('/x')).headers.get('retry-after')).toBe('45');
  });
});
