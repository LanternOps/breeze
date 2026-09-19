/**
 * AI patch agent W02 (#5748) Task 4 — the `manage_patches:install` effect
 * digest pins the ELIGIBILITY VERDICT for (device, patchIds…), never the
 * `patches` catalog row (a global vendor mirror whose `updated_at` churns on
 * routine re-sync — the trap effectDigestCoverage.contract.test.ts records
 * for `manage_patches:rollback`). The release worker needs no change:
 * `hasPinnedDigest` + `computeEffectDigestForRelease` pick the resolver up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db';

const { resolveEligibility } = vi.hoisted(() => ({ resolveEligibility: vi.fn() }));
vi.mock('../patchEligibility', () => ({ resolvePatchInstallEligibility: resolveEligibility }));
// Keep the run_script resolver's transitive db import inert (same seam as effectDigest.test.ts).
vi.mock('../tenantVariableResolution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tenantVariableResolution')>()),
  loadTenantVariableScope: vi.fn(),
}));

import {
  __EFFECT_DIGEST_RESOLVER_KEYS,
  computeEffectDigestForRelease,
  computeEffectDigestOutcome,
  effectDigestResolverKey,
} from './effectDigest';

const DEV = 'dddddddd-0000-0000-0000-000000000001';
const ORG = 'aaaaaaaa-0000-0000-0000-000000000001';

function fakeDb(deviceRows: unknown[]): { database: Database; select: ReturnType<typeof vi.fn> } {
  const chain = { limit: vi.fn(async () => deviceRows) };
  const select = vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => chain) })) }));
  return { database: { select } as unknown as Database, select };
}

const verdict = (o: Partial<{ eligible: string[]; ineligible: Array<{ patchId: string; reason: string }>; ringId: string | null }> = {}) => ({
  eligible: (o.eligible ?? ['p1']).map((patchId) => ({ patchId, devicePatchId: `dp-${patchId}`, externalId: 'KB', title: 't', category: null, severity: null, requiresReboot: false, approvalReason: 'manual' })),
  ineligible: o.ineligible ?? [],
  ringId: o.ringId === undefined ? 'ring-1' : o.ringId,
  resolvedAt: new Date().toISOString(),
});

const args = { action: 'install', deviceIds: [DEV], patchIds: ['p1', 'p2'] };

async function digest(deviceRows: unknown[] = [{ orgId: ORG }]): Promise<string | null> {
  return (await computeEffectDigestForRelease('manage_patches', args, fakeDb(deviceRows).database)).digest;
}

beforeEach(() => {
  resolveEligibility.mockReset();
});

describe('manage_patches:install effect digest (W02 Task 4)', () => {
  it('registers a manage_patches:install resolver and leaves rollback unpinned', () => {
    expect(__EFFECT_DIGEST_RESOLVER_KEYS).toContain('manage_patches:install');
    expect(effectDigestResolverKey('manage_patches', 'install')).toBe('manage_patches:install');
    expect(effectDigestResolverKey('manage_patches', 'rollback')).toBeNull();
  });

  it('hashes the ELIGIBILITY VERDICT, not patches.updated_at — a catalog re-sync leaves it unchanged', async () => {
    resolveEligibility.mockResolvedValue(verdict({ eligible: ['p1', 'p2'] }));
    const a = await digest();
    // "bump patches.updated_at": the verdict is byte-identical, only time moved.
    resolveEligibility.mockResolvedValue({ ...verdict({ eligible: ['p1', 'p2'] }), resolvedAt: '2099-01-01T00:00:00.000Z' });
    const b = await digest();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });

  it('is independent of the order the resolver returns ids in', async () => {
    resolveEligibility.mockResolvedValue(verdict({ eligible: ['p2', 'p1'] }));
    const a = await digest();
    resolveEligibility.mockResolvedValue(verdict({ eligible: ['p1', 'p2'] }));
    expect(await digest()).toBe(a);
  });

  it('changes the digest when a patch becomes ineligible between approval and release', async () => {
    resolveEligibility.mockResolvedValue(verdict({ eligible: ['p1', 'p2'] }));
    const approved = await digest();
    resolveEligibility.mockResolvedValue(verdict({ eligible: ['p1'], ineligible: [{ patchId: 'p2', reason: 'held_by_deferral' }] }));
    expect(await digest()).not.toBe(approved);
  });

  it('changes the digest when a patch is superseded', async () => {
    resolveEligibility.mockResolvedValue(verdict({ eligible: ['p1', 'p2'] }));
    const approved = await digest();
    resolveEligibility.mockResolvedValue(verdict({ eligible: ['p1'], ineligible: [{ patchId: 'p2', reason: 'superseded' }] }));
    expect(await digest()).not.toBe(approved);
  });

  it('changes the digest when the device moved ring', async () => {
    resolveEligibility.mockResolvedValue(verdict({ ringId: 'ring-1' }));
    const approved = await digest();
    resolveEligibility.mockResolvedValue(verdict({ ringId: 'ring-2' }));
    expect(await digest()).not.toBe(approved);
  });

  it('changes the digest when the device moved org — and resolves against the CURRENT org, never the tool input', async () => {
    resolveEligibility.mockResolvedValue(verdict());
    const approved = await digest([{ orgId: ORG }]);
    expect(resolveEligibility).toHaveBeenLastCalledWith({ deviceId: DEV, orgId: ORG, patchIds: ['p1', 'p2'] });
    const moved = await digest([{ orgId: 'bbbbbbbb-0000-0000-0000-000000000002' }]);
    expect(resolveEligibility).toHaveBeenLastCalledWith(expect.objectContaining({ orgId: 'bbbbbbbb-0000-0000-0000-000000000002' }));
    expect(moved).not.toBe(approved);
  });

  it('reports target_absent when the device no longer exists', async () => {
    const outcome = await computeEffectDigestOutcome('manage_patches', args, fakeDb([]).database);
    expect(outcome).toEqual({ kind: 'unresolved', reason: 'target_absent' });
    expect(resolveEligibility).not.toHaveBeenCalled();
  });

  it('reports missing_arg without exactly one deviceId or without patchIds', async () => {
    const { database } = fakeDb([{ orgId: ORG }]);
    expect(await computeEffectDigestOutcome('manage_patches', { action: 'install', patchIds: ['p1'] }, database))
      .toEqual({ kind: 'unresolved', reason: 'missing_arg' });
    expect(await computeEffectDigestOutcome('manage_patches', { action: 'install', deviceIds: [DEV, 'other'], patchIds: ['p1'] }, database))
      .toEqual({ kind: 'unresolved', reason: 'missing_arg' });
    expect(await computeEffectDigestOutcome('manage_patches', { action: 'install', deviceIds: [DEV], patchIds: [] }, database))
      .toEqual({ kind: 'unresolved', reason: 'missing_arg' });
  });
});
