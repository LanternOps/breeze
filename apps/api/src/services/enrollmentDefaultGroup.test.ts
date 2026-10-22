import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/schema', () => ({
  organizations: { id: 'organizations.id', settings: 'organizations.settings' },
  deviceGroups: { id: 'deviceGroups.id', orgId: 'deviceGroups.orgId', type: 'deviceGroups.type' },
  deviceGroupMemberships: { deviceId: 'm.deviceId', groupId: 'm.groupId' },
  groupMembershipLog: { groupId: 'log.groupId' },
}));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { applyOrgDefaultDeviceGroup } from './enrollmentDefaultGroup';

const GROUP_ID = '11111111-1111-4111-8111-111111111111';
const ORG = 'org-1';
const DEVICE = 'dev-1';

function chain(rows: unknown[]) {
  const c: any = { from: () => c, where: () => c, limit: () => Promise.resolve(rows) };
  return c;
}

/** selects: results returned in call order (settings row, then group row). */
function makeTx(selects: unknown[][], opts: { insertThrows?: boolean } = {}) {
  const inserted: Array<{ table: unknown; values: any }> = [];
  const queue = [...selects];
  const tx: any = {
    select: vi.fn(() => chain(queue.shift() ?? [])),
    insert: vi.fn((table: unknown) => ({
      values: (values: any) => {
        if (opts.insertThrows) {
          const fail = () => Promise.reject(new Error('boom'));
          return { onConflictDoNothing: fail, then: (_ok: unknown, bad: (e: Error) => void) => bad(new Error('boom')) };
        }
        inserted.push({ table, values });
        return Object.assign(Promise.resolve(undefined), {
          onConflictDoNothing: () => Promise.resolve(undefined),
        });
      },
    })),
  };
  tx.transaction = async (fn: any) => fn(tx); // savepoint
  return { tx, inserted };
}

describe('applyOrgDefaultDeviceGroup (#9617)', () => {
  it('adds the device to the org default static group', async () => {
    const { tx, inserted } = makeTx([
      [{ settings: { defaults: { deviceGroup: GROUP_ID } } }],
      [{ id: GROUP_ID }],
    ]);
    const res = await applyOrgDefaultDeviceGroup(tx, { orgId: ORG, deviceId: DEVICE });
    expect(res).toBe('added');
    const m = inserted.find((i) => i.values.deviceId === DEVICE && i.values.groupId === GROUP_ID);
    expect(m?.values).toMatchObject({ orgId: ORG, addedBy: 'manual' });
  });

  it('skips when no default is configured', async () => {
    const { tx, inserted } = makeTx([[{ settings: { defaults: {} } }]]);
    expect(await applyOrgDefaultDeviceGroup(tx, { orgId: ORG, deviceId: DEVICE })).toBe('none');
    expect(inserted).toHaveLength(0);
  });

  it('treats a legacy display-string value as unset (no group lookup)', async () => {
    const { tx, inserted } = makeTx([[{ settings: { defaults: { deviceGroup: 'All Managed Devices' } } }]]);
    expect(await applyOrgDefaultDeviceGroup(tx, { orgId: ORG, deviceId: DEVICE })).toBe('none');
    expect(tx.select).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(0);
  });

  it('skips silently when the group is missing, foreign-org, or not static', async () => {
    const { tx, inserted } = makeTx([
      [{ settings: { defaults: { deviceGroup: GROUP_ID } } }],
      [], // lookup is scoped to org + static, so foreign/dynamic/deleted returns nothing
    ]);
    expect(await applyOrgDefaultDeviceGroup(tx, { orgId: ORG, deviceId: DEVICE })).toBe('skipped');
    expect(inserted).toHaveLength(0);
  });

  it('never throws when the membership insert fails', async () => {
    const { tx } = makeTx(
      [[{ settings: { defaults: { deviceGroup: GROUP_ID } } }], [{ id: GROUP_ID }]],
      { insertThrows: true },
    );
    expect(await applyOrgDefaultDeviceGroup(tx, { orgId: ORG, deviceId: DEVICE })).toBe('skipped');
  });
});
