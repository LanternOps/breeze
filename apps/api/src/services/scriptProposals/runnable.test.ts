import { describe, expect, it, vi } from 'vitest';

let stored: Record<string, unknown> | null = null;
vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => (stored ? [stored] : []) }) }) }) },
}));
import { assertProposalRunnable } from './runnable';

const auth = { orgId: 'org-1' } as never;
const device = '11111111-1111-4111-8111-111111111111';
const base = {
  id: 'p1', orgId: 'org-1', status: 'reviewed', intentId: null,
  expiresAt: new Date(Date.now() + 3600_000), targetDeviceIds: [device],
  runAs: 'system', timeoutSeconds: 300,
};
const call = (over: Record<string, unknown> = {}) =>
  assertProposalRunnable(auth, { proposalId: 'p1', deviceIds: [device], ...over });

describe('assertProposalRunnable', () => {
  it('accepts a reviewed, unconsumed, unexpired proposal on a targeted device', async () => {
    stored = { ...base };
    await expect(call()).resolves.toEqual({ ok: true, proposal: stored });
  });

  it.each([
    ['not_found', null, {}],
    ['wrong_org', { ...base, orgId: 'org-2' }, {}],
    ['not_reviewed', { ...base, status: 'proposed' }, {}],
    ['superseded', { ...base, status: 'superseded' }, {}],
    ['consumed', { ...base, intentId: 'i1' }, {}],
    ['expired', { ...base, expiresAt: new Date(Date.now() - 1000) }, {}],
    ['device_not_targeted', { ...base }, { deviceIds: ['22222222-2222-4222-8222-222222222222'] }],
    ['run_as_mismatch', { ...base }, { runAs: 'user' }],
    ['timeout_mismatch', { ...base }, { timeoutSeconds: 60 }],
    ['parameters_not_allowed', { ...base }, { parameters: { a: 1 } }],
  ])('refuses with %s', async (reason, row, over) => {
    stored = row as Record<string, unknown> | null;
    await expect(call(over as Record<string, unknown>)).resolves.toEqual({ ok: false, reason });
  });

  it('lets the intent that claimed the proposal release it, and still refuses any other intent', async () => {
    stored = { ...base, intentId: 'i1' };
    await expect(call({ releasingIntentId: 'i1' })).resolves.toEqual({ ok: true, proposal: stored });
    await expect(call({ releasingIntentId: 'i2' })).resolves.toEqual({ ok: false, reason: 'consumed' });
    await expect(call()).resolves.toEqual({ ok: false, reason: 'consumed' });
  });

  it('never silently degrades to a library run — every refusal is explicit', async () => {
    stored = { ...base, status: 'rejected' };
    const result = await call();
    expect(result.ok).toBe(false);
  });
});
