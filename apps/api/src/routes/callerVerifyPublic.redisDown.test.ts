/**
 * With Redis unavailable the miss budget fails OPEN by design, so the public
 * card's safety rests on the real per-IP `rateLimiter` failing CLOSED first.
 * Unlike callerVerifyPublic.test.ts, the limiter is NOT mocked here.
 */
import { expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const m = vi.hoisted(() => ({ lookup: vi.fn(), decide: vi.fn(), contexts: 0 }));
vi.mock('../services/callerVerification/gate', () => ({ isCallerVerificationEnabled: () => true }));
vi.mock('../services/callerVerification/publicLookup', async (orig) => ({
  ...await orig<typeof import('../services/callerVerification/publicLookup')>(),
  lookupPublicToken: m.lookup,
}));
vi.mock('../services/callerVerification/service', () => ({ applyDecision: m.decide }));
vi.mock('../services/redis', () => ({ getRedis: () => null }));
vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => { m.contexts++; return fn(); },
}));

import { callerVerifyPublicRoutes } from './callerVerifyPublic';

const app = new Hono().route('/verify', callerVerifyPublicRoutes);
const path = `/verify/${'A'.repeat(43)}`;

it('refuses GET and POST with 429 before any lookup or decision when Redis is down', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect((await app.request(path)).status).toBe(429);
  const res = await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choice: 'not_me' }) });
  expect(res.status).toBe(429);
  expect(res.headers.get('Cache-Control')).toBe('no-store, private');
  expect(m.lookup).not.toHaveBeenCalled();
  expect(m.decide).not.toHaveBeenCalled();
  expect(m.contexts).toBe(0);
  error.mockRestore();
});
