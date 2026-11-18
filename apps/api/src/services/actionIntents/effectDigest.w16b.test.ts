/**
 * Full-control W16 PR B (#6786): the three four-eyes pins, through the resolver map both release paths use. The rows
 * are faked here; `aiToolsAiDesignWrites.integration` proves the real reads.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  schedule: vi.fn(),
  apply: vi.fn(),
  rollback: vi.fn(),
}));

vi.mock('./scheduleDeleteDigest', () => ({ scheduleDeleteDigestMaterial: h.schedule }));
vi.mock('../fleetDesign/applyTargets', () => ({ snapshotFleetDesignApplyTargets: h.apply, snapshotFleetDesignRollbackTargets: h.rollback }));

import type { Database } from '../../db';
import { computeEffectDigestForRelease, computeEffectDigestOutcome, effectDigestResolverKey, requiresPinnedEffectDigest } from './effectDigest';
import { fleetDesignApplyDigestMaterial, fleetDesignRollbackDigestMaterial } from './fleetDesignDigest';

const database = {} as Database;
const ID = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const scope = { intentOrgId: ORG };

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.schedule.mockResolvedValue({ v: 1, scheduleId: ID });
  h.apply.mockResolvedValue({ orgId: 'o', designHash: 'x' });
  h.rollback.mockResolvedValue({ orgId: 'o', ledger: [] });
});

describe.each([
  ['manage_ai_agent_schedules', 'delete'],
  ['manage_fleet_designs', 'apply'],
  ['manage_fleet_designs', 'rollback'],
] as const)('%s:%s', (tool, action) => {
  it('is pinned and mandatory', () => {
    expect(effectDigestResolverKey(tool, action)).toBe(`${tool}:${action}`);
    expect(requiresPinnedEffectDigest(tool, { action })).toBe(true);
  });
});

describe('manage_ai_agent_schedules:delete', () => {
  const pin = (args: Record<string, unknown>) => computeEffectDigestOutcome('manage_ai_agent_schedules', { action: 'delete', ...args }, database);

  it('no id is missing_arg, and never reaches a read', async () => {
    await expect(pin({})).resolves.toEqual({ kind: 'unresolved', reason: 'missing_arg' });
    expect(h.schedule).not.toHaveBeenCalled();
  });

  it('a malformed id is target_absent, and never reaches a read', async () => {
    await expect(pin({ scheduleId: 'nope' })).resolves.toEqual({ kind: 'unresolved', reason: 'target_absent' });
    expect(h.schedule).not.toHaveBeenCalled();
  });

  it('a missing row is target_absent', async () => {
    h.schedule.mockResolvedValue(null);
    await expect(pin({ scheduleId: ID })).resolves.toEqual({ kind: 'unresolved', reason: 'target_absent' });
  });

  it('an uppercase id reads the same row', async () => {
    await pin({ scheduleId: ID.toUpperCase() });
    expect(h.schedule).toHaveBeenCalledWith(ID, database);
  });

  it('carries no fleet binding', async () => {
    const released = await computeEffectDigestForRelease('manage_ai_agent_schedules', { action: 'delete', scheduleId: ID }, database);
    expect(released.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(released.context).toBeUndefined();
  });
});

describe.each(['apply', 'rollback'] as const)('manage_fleet_designs:%s', (action) => {
  const args = (over: Record<string, unknown> = {}) => ({ action, reportRunId: ID, approval: {}, ...over });
  const snapshot = action === 'apply' ? h.apply : h.rollback;

  it('a match hands the handler the digest it matched', async () => {
    const released = await computeEffectDigestForRelease('manage_fleet_designs', args(), database, scope);
    expect(released.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(released.context).toEqual({ verifiedFleetDesignBinding: { digest: released.digest } });
  });

  it('no report id is missing_arg', async () => {
    const { reportRunId: _dropped, ...rest } = args();
    await expect(computeEffectDigestOutcome('manage_fleet_designs', rest, database, scope)).resolves.toEqual({ kind: 'unresolved', reason: 'missing_arg' });
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('a malformed report id never reaches a read, and there is no binding', async () => {
    const released = await computeEffectDigestForRelease('manage_fleet_designs', args({ reportRunId: 'nope' }), database, scope);
    expect(released.digest).toBeNull();
    expect(released.context).toBeUndefined();
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('a run that is not an org design is target_absent, and there is no binding', async () => {
    snapshot.mockResolvedValue(null);
    await expect(computeEffectDigestOutcome('manage_fleet_designs', args(), database, scope)).resolves.toEqual({ kind: 'unresolved', reason: 'target_absent' });
    const released = await computeEffectDigestForRelease('manage_fleet_designs', args(), database, scope);
    expect(released.digest).toBeNull();
    expect(released.context).toBeUndefined();
  });

  it("reads the design in the intent's org, and with no org there is nothing to pin", async () => {
    await computeEffectDigestForRelease('manage_fleet_designs', args(), database, scope);
    expect(snapshot.mock.calls[0]!.slice(0, 2)).toEqual([ID, ORG]);
    snapshot.mockClear();

    await expect(computeEffectDigestOutcome('manage_fleet_designs', args(), database)).resolves.toEqual({ kind: 'unresolved', reason: 'target_absent' });
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('a different snapshot is a different digest', async () => {
    const before = await computeEffectDigestForRelease('manage_fleet_designs', args(), database, scope);
    snapshot.mockResolvedValue({ orgId: 'o', moved: true });
    const after = await computeEffectDigestForRelease('manage_fleet_designs', args(), database, scope);
    expect(after.digest).not.toBe(before.digest);
  });
});

describe('fleetDesignDigest', () => {
  it('apply needs a parseable approval, and defaults its arrays as the route does', async () => {
    await expect(fleetDesignApplyDigestMaterial({ reportRunId: ID, approval: { functions: ['Not A Key'] } }, ORG, database)).resolves.toBeNull();
    await expect(fleetDesignApplyDigestMaterial({ reportRunId: ID }, ORG, database)).resolves.toBeNull();
    expect(h.apply).not.toHaveBeenCalled();
    await expect(fleetDesignApplyDigestMaterial({ reportRunId: ID, approval: {} }, ORG, database)).resolves.toMatchObject({ v: 1, reportRunId: ID });
    expect(h.apply.mock.calls[0]![2]).toMatchObject({ functions: [], roleCorrections: [] });
  });

  it('rollback needs a uuid', async () => {
    await expect(fleetDesignRollbackDigestMaterial({ reportRunId: 'nope' }, ORG, database)).resolves.toBeNull();
    await expect(fleetDesignRollbackDigestMaterial({ reportRunId: ID }, ORG, database)).resolves.toMatchObject({ v: 1, reportRunId: ID });
  });
});
