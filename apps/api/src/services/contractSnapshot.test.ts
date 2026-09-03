/**
 * #3205 W05 fix round 2: proves buildOrgDeviceSnapshot composes the
 * contractQuantities primitives (cross-module, so a plain vi.mock of
 * './contractQuantities' is visible here) and returns per-group failures
 * instead of throwing them.
 *
 * Fix round 3: also proves `groupNames` carries forward the name of every row
 * the builder loaded — resolved AND failed alike — so a caller building a
 * GROUP_EVALUATION_FAILED message never re-queries deviceGroups for a name
 * the builder already read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { snapshotContractDevices, groupMembersForBilling } = vi.hoisted(() => ({
  snapshotContractDevices: vi.fn(),
  groupMembersForBilling: vi.fn(),
}));
vi.mock('./contractQuantities', () => ({ snapshotContractDevices, groupMembersForBilling }));

const { dbRows } = vi.hoisted(() => ({ dbRows: { current: [] as unknown[] } }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'from', 'where'];
  for (const m of methods) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve(dbRows.current);
  return { db: chain, __setRows: (r: unknown[]) => { dbRows.current = r; } };
});

import { buildOrgDeviceSnapshot } from './contractSnapshot';
import { GroupEvaluationError } from './groupMembership';
import * as dbModule from '../db';

const setGroupRows = (rows: unknown[]) => (dbModule as unknown as { __setRows: (r: unknown[]) => void }).__setRows(rows);

const DEVICES = [{ id: 'd1', role: 'server', siteId: 'site-a' }];

beforeEach(() => {
  vi.clearAllMocks();
  snapshotContractDevices.mockResolvedValue(DEVICES);
  setGroupRows([]);
});

describe('buildOrgDeviceSnapshot', () => {
  it('composes the org snapshot from snapshotContractDevices with no groups requested', async () => {
    const { snapshot, groupErrors } = await buildOrgDeviceSnapshot('org-1', []);
    expect(snapshotContractDevices).toHaveBeenCalledWith('org-1');
    expect(snapshot.devices).toEqual(DEVICES);
    expect(snapshot.groups.size).toBe(0);
    expect(groupErrors.size).toBe(0);
    expect(groupMembersForBilling).not.toHaveBeenCalled();
  });

  it('resolves every requested group via groupMembersForBilling', async () => {
    setGroupRows([{ id: 'g-ok', orgId: 'org-1', name: 'VIP', type: 'static', siteId: null, filterConditions: null }]);
    groupMembersForBilling.mockResolvedValue({ siteId: null, memberIds: new Set(['d1']) });

    const { snapshot, groupErrors, groupNames } = await buildOrgDeviceSnapshot('org-1', ['g-ok']);
    expect(groupMembersForBilling).toHaveBeenCalledWith({ id: 'g-ok', orgId: 'org-1', name: 'VIP', type: 'static', siteId: null, filterConditions: null });
    expect(snapshot.groups.get('g-ok')).toEqual({ siteId: null, memberIds: new Set(['d1']) });
    expect(groupErrors.size).toBe(0);
    expect(groupNames.get('g-ok')).toBe('VIP');
  });

  it('returns a GroupEvaluationError in groupErrors instead of throwing, and resolves the rest', async () => {
    setGroupRows([
      { id: 'g-bad', orgId: 'org-1', name: 'Broken', type: 'dynamic', siteId: null, filterConditions: {} },
      { id: 'g-ok', orgId: 'org-1', name: 'VIP', type: 'static', siteId: null, filterConditions: null },
    ]);
    groupMembersForBilling
      .mockRejectedValueOnce(new GroupEvaluationError('g-bad', 'invalid_filter'))
      .mockResolvedValueOnce({ siteId: null, memberIds: new Set(['d1']) });

    const { snapshot, groupErrors, groupNames } = await buildOrgDeviceSnapshot('org-1', ['g-bad', 'g-ok']);
    expect(groupErrors.get('g-bad')).toBeInstanceOf(GroupEvaluationError);
    expect(snapshot.groups.has('g-bad')).toBe(false);
    expect(snapshot.groups.get('g-ok')).toEqual({ siteId: null, memberIds: new Set(['d1']) });
    // The name of the FAILED group must still be present — this is the whole point
    // of groupNames: a caller building the GROUP_EVALUATION_FAILED message needs
    // the name of a row that never made it into `snapshot.groups`.
    expect(groupNames.get('g-bad')).toBe('Broken');
    expect(groupNames.get('g-ok')).toBe('VIP');
  });

  it('re-throws a non-GroupEvaluationError failure from groupMembersForBilling', async () => {
    setGroupRows([{ id: 'g-1', orgId: 'org-1', name: 'X', type: 'static', siteId: null, filterConditions: null }]);
    groupMembersForBilling.mockRejectedValue(new Error('boom'));
    await expect(buildOrgDeviceSnapshot('org-1', ['g-1'])).rejects.toThrow('boom');
  });

  // #3205 W05 fix round 4: a caller that already has one org's device list
  // cached (contractService's orgSnapshot, resolving a NEW group id for an
  // org it already snapshotted this calculation) must be able to hand it in
  // and skip the redundant full-org device scan.
  it('uses opts.devices and never calls snapshotContractDevices when a device list is supplied', async () => {
    const cached = [{ id: 'cached-1', role: 'server', siteId: 'site-a' }];
    setGroupRows([{ id: 'g-ok', orgId: 'org-1', name: 'VIP', type: 'static', siteId: null, filterConditions: null }]);
    groupMembersForBilling.mockResolvedValue({ siteId: null, memberIds: new Set(['cached-1']) });

    const { snapshot } = await buildOrgDeviceSnapshot('org-1', ['g-ok'], { devices: cached });

    expect(snapshotContractDevices).not.toHaveBeenCalled();
    expect(snapshot.devices).toBe(cached);
    // Group resolution still runs normally for the requested ids.
    expect(groupMembersForBilling).toHaveBeenCalledTimes(1);
    expect(snapshot.groups.get('g-ok')).toEqual({ siteId: null, memberIds: new Set(['cached-1']) });
  });
});
