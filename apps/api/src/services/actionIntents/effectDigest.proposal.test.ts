import { describe, expect, it } from 'vitest';

let stored: Record<string, unknown> | null = null;
const database = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => (stored ? [stored] : []) }) }) }),
} as never;

import { EffectDigestUnresolvableError, computeEffectDigestOutcome } from './effectDigest';

const proposal = {
  id: 'p1', contentDigest: 'a'.repeat(64), language: 'powershell', runAs: 'system',
  timeoutSeconds: 300, scannerVersion: '2026-09-11.1', status: 'reviewed',
  targetDeviceIds: ['d1', 'd2'], expiresAt: new Date(Date.now() + 3600_000), intentId: null,
};

describe('run_script effect digest with a proposalId', () => {
  it('pins a digest that is independent of device argument order', async () => {
    stored = proposal;
    const a = await computeEffectDigestOutcome('run_script', { proposalId: 'p1', deviceIds: ['d2', 'd1'] }, database);
    const b = await computeEffectDigestOutcome('run_script', { proposalId: 'p1', deviceIds: ['d1', 'd2'] }, database);
    expect(a.kind).toBe('pinned');
    expect(a).toEqual(b);
  });

  it('changes when the content digest changes', async () => {
    stored = proposal;
    const before = await computeEffectDigestOutcome('run_script', { proposalId: 'p1', deviceIds: ['d1'] }, database);
    stored = { ...proposal, contentDigest: 'b'.repeat(64) };
    const after = await computeEffectDigestOutcome('run_script', { proposalId: 'p1', deviceIds: ['d1'] }, database);
    expect(after).not.toEqual(before);
  });

  it('does NOT change when only lifecycle state changes — status is never digest material', async () => {
    stored = proposal;
    const before = await computeEffectDigestOutcome('run_script', { proposalId: 'p1', deviceIds: ['d1'] }, database);
    stored = { ...proposal, status: 'approved', intentId: 'i1' };
    const after = await computeEffectDigestOutcome('run_script', { proposalId: 'p1', deviceIds: ['d1'] }, database);
    expect(after).toEqual(before);
  });

  it('throws rather than returning an unpinnable outcome when the proposal is absent', async () => {
    stored = null;
    await expect(
      computeEffectDigestOutcome('run_script', { proposalId: 'p1', deviceIds: ['d1'] }, database),
    ).rejects.toBeInstanceOf(EffectDigestUnresolvableError);
  });

  it('throws when no devices are named — there is nothing to pin the run to', async () => {
    stored = proposal;
    await expect(
      computeEffectDigestOutcome('run_script', { proposalId: 'p1', deviceIds: [] }, database),
    ).rejects.toBeInstanceOf(EffectDigestUnresolvableError);
  });

  it('leaves the library run_script resolver alone', async () => {
    stored = null;
    const outcome = await computeEffectDigestOutcome('run_script', { deviceIds: ['d1'] }, database);
    expect(outcome.kind).not.toBe('pinned');
  });
});
