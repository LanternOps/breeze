import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({ touched: 0 }));
vi.mock('../../db', () => ({
  db: new Proxy({}, { get: () => { dbMock.touched += 1; throw new Error('db must not be touched'); } }),
  runOutsideDbContext: (fn: () => unknown) => { dbMock.touched += 1; return fn(); },
  withSystemDbAccessContext: (fn: () => unknown) => { dbMock.touched += 1; return fn(); },
}));

import { prepareCallerDispatch } from './dispatch';

const input = {
  orgId: '11111111-1111-4111-8111-111111111111',
  action: 'disable_user' as const,
  connectionId: '22222222-2222-4222-8222-222222222222',
  backendTenantId: '33333333-3333-4333-8333-333333333333',
  oid: '44444444-4444-4444-8444-444444444444',
};

describe('prepareCallerDispatch preconditions', () => {
  beforeEach(() => { dbMock.touched = 0; vi.stubEnv('CALLER_VERIFICATION_ENABLED', 'true'); });
  afterEach(() => vi.unstubAllEnvs());

  it('refuses a backend call without a durable intent before any gate, DB or HTTP work', async () => {
    const gate = vi.fn();
    await expect(prepareCallerDispatch(input, gate)).rejects.toMatchObject({
      name: 'CallerVerificationRequiredError',
      payload: { reason: 'no_fresh_verification', action: 'disable_user', orgId: input.orgId },
    });
    expect(gate).not.toHaveBeenCalled();
    expect(dbMock.touched).toBe(0);
  });

  it('refuses with feature_disabled when the readiness flag is explicitly off', async () => {
    vi.stubEnv('CALLER_VERIFICATION_ENABLED', 'false');
    const gate = vi.fn();
    await expect(prepareCallerDispatch({ ...input, intentId: '55555555-5555-4555-8555-555555555555' }, gate))
      .rejects.toMatchObject({ payload: { reason: 'feature_disabled' } });
    expect(gate).not.toHaveBeenCalled();
    expect(dbMock.touched).toBe(0);
  });
});
