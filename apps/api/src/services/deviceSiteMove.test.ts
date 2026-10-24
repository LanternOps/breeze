import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * services/deviceSiteMove.ts — the single same-org site move shared by PATCH /devices/:id and
 * POST /devices/bulk/site (#9796). The caller authorizes the device (org + source-site allowlist)
 * through getDeviceWithOrgAndSiteCheck and passes the row in; this module owns the rest of the
 * move: the expectedSiteId guard, the target-site org/allowlist check, the row lock + re-read,
 * the guarded UPDATE savepoint (with the caller's extra columns and custom-field writes), the
 * denormalized rewrite, group re-evaluation, peripheral reconciliation and both audit entries.
 */

vi.mock('../db', () => ({
  db: { select: vi.fn(), execute: vi.fn(), transaction: vi.fn(), update: vi.fn() },
}));
vi.mock('../routes/devices/core', () => ({ rewriteDeviceSiteDenormalizedTables: vi.fn() }));
vi.mock('../jobs/deviceGroupJobs', () => ({ requestDeviceGroupReevaluationAfterCommit: vi.fn() }));
vi.mock('../jobs/peripheralJobs', () => ({ schedulePeripheralPolicyDevice: vi.fn().mockResolvedValue('job') }));
vi.mock('./customFields/queries', () => ({ persistDeviceCustomFieldValues: vi.fn() }));

import { db } from '../db';
import { rewriteDeviceSiteDenormalizedTables } from '../routes/devices/core';
import { requestDeviceGroupReevaluationAfterCommit } from '../jobs/deviceGroupJobs';
import { schedulePeripheralPolicyDevice } from '../jobs/peripheralJobs';
import { persistDeviceCustomFieldValues } from './customFields/queries';
import {
  moveDeviceToSite,
  prepareDeviceSiteMove,
  executeDeviceSiteMove,
  type SiteMoveAuditEntry,
} from './deviceSiteMove';
import type { UserPermissions } from './permissions';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const SITE_A = '77777777-7777-4777-8777-777777777777';
const SITE_B = '88888888-8888-4888-8888-888888888888';
const SITE_C = '99999999-9999-4999-8999-999999999999';
const device = { id: DEVICE_ID, orgId: 'org-1', siteId: SITE_A, hostname: 'FRONTDESK-01', displayName: null };
const unrestricted = { permissions: [], partnerId: null, orgId: 'org-1', roleId: 'r', scope: 'organization' } as unknown as UserPermissions;
const restricted = (...ids: string[]) => ({ ...unrestricted, allowedSiteIds: ids }) as UserPermissions;

const selectCalls: { methods: string[]; args: unknown[][] }[] = [];
function queueSelects(results: unknown[][]) {
  const queue = [...results];
  vi.mocked(db.select).mockImplementation((() => {
    const result = queue.shift() ?? [];
    const record = { methods: [] as string[], args: [] as unknown[][] };
    selectCalls.push(record);
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit', 'for']) {
      chain[m] = (...args: unknown[]) => { record.methods.push(m); record.args.push(args); return chain; };
    }
    chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
    return chain;
  }) as never);
}

let returningRows: unknown[];
let sets: Record<string, unknown>[];
let insideSavepoint: boolean;
function rigSavepoint() {
  sets = [];
  insideSavepoint = false;
  vi.mocked(db.transaction).mockImplementation(async (cb: any) => {
    insideSavepoint = true;
    try {
      return await cb({
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockImplementation((s: Record<string, unknown>) => {
            sets.push(s);
            return { where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(returningRows) }) };
          }),
        }),
        execute: vi.fn().mockResolvedValue([]),
      });
    } finally {
      insideSavepoint = false;
    }
  });
}

let audits: SiteMoveAuditEntry[];
const audit = (entry: SiteMoveAuditEntry) => { audits.push(entry); };

beforeEach(() => {
  vi.clearAllMocks();
  selectCalls.length = 0;
  audits = [];
  returningRows = [{ ...device, siteId: SITE_B }];
  rigSavepoint();
});

/** target site → row lock (current site) → source site name. */
const moveSelects = (lockedSiteId = SITE_A) =>
  queueSelects([[{ id: SITE_B, orgId: 'org-1', name: 'Lakeside' }], [{ siteId: lockedSiteId }], [{ name: 'Main Office' }]]);

const baseArgs = { device, permissions: unrestricted, toSiteId: SITE_B, expectedSiteId: SITE_A, trigger: 'manual' as const, audit };

describe('moveDeviceToSite', () => {
  it('moved: guarded UPDATE + denormalized rewrite in one savepoint, then re-evaluation, peripheral, two audits', async () => {
    moveSelects();
    const result = await moveDeviceToSite({ ...baseArgs, reevaluationReason: 'device_bulk_site_move' });
    expect(result).toMatchObject({ outcome: 'moved', fromSiteId: SITE_A, device: { id: DEVICE_ID, siteId: SITE_B } });
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ siteId: SITE_B });
    expect(rewriteDeviceSiteDenormalizedTables).toHaveBeenCalledWith(expect.anything(), DEVICE_ID, SITE_B);
    expect(requestDeviceGroupReevaluationAfterCommit).toHaveBeenCalledTimes(1);
    expect(requestDeviceGroupReevaluationAfterCommit).toHaveBeenCalledWith({
      deviceId: DEVICE_ID, orgId: 'org-1', eventType: 'device.updated', changedFields: ['siteId'], reason: 'device_bulk_site_move',
    });
    expect(schedulePeripheralPolicyDevice).toHaveBeenCalledWith(DEVICE_ID, 'device_site_changed');
    expect(audits.map((a) => a.action)).toEqual(['device.update', 'device.site_move']);
    expect(audits[0]).toMatchObject({ orgId: 'org-1', resourceType: 'device', resourceId: DEVICE_ID, details: { changedFields: ['siteId'] } });
    expect(audits[1]!.details).toEqual({
      fromSiteId: SITE_A, fromSiteName: 'Main Office', toSiteId: SITE_B, toSiteName: 'Lakeside', expectedSiteId: SITE_A, trigger: 'manual',
    });
  });

  it('takes the row lock FOR UPDATE on devices before the savepoint', async () => {
    moveSelects();
    await moveDeviceToSite({ ...baseArgs, reevaluationReason: 'r' });
    const lock = selectCalls[1]!;
    expect(lock.args[lock.methods.indexOf('for')]![0]).toBe('update');
    expect(vi.mocked(db.select).mock.invocationCallOrder[1]!).toBeLessThan(vi.mocked(db.transaction).mock.invocationCallOrder[0]!);
  });

  it('already_there: the device is already at the target — no lookup, no write, no audit', async () => {
    const result = await moveDeviceToSite({ ...baseArgs, toSiteId: SITE_A, reevaluationReason: 'r' });
    expect(result).toEqual({ outcome: 'already_there', fromSiteId: SITE_A });
    expect(db.select).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
    expect(requestDeviceGroupReevaluationAfterCommit).not.toHaveBeenCalled();
    expect(schedulePeripheralPolicyDevice).not.toHaveBeenCalled();
  });

  it('conflict: a stale expectedSiteId refuses before any read, naming the visible current site', async () => {
    const result = await moveDeviceToSite({ ...baseArgs, expectedSiteId: SITE_C, reevaluationReason: 'r' });
    expect(result).toMatchObject({ outcome: 'conflict', currentSiteId: SITE_A });
    expect(db.select).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it('conflict: compares expectedSiteId case-insensitively', async () => {
    moveSelects();
    const result = await moveDeviceToSite({ ...baseArgs, expectedSiteId: SITE_A.toUpperCase(), reevaluationReason: 'r' });
    expect(result.outcome).toBe('moved');
  });

  it('conflict: the lock re-read finds the device moved — no savepoint, no side effects', async () => {
    moveSelects(SITE_C);
    const result = await moveDeviceToSite({ ...baseArgs, reevaluationReason: 'r' });
    expect(result).toMatchObject({ outcome: 'conflict', currentSiteId: SITE_C });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
    expect(requestDeviceGroupReevaluationAfterCommit).not.toHaveBeenCalled();
    expect(schedulePeripheralPolicyDevice).not.toHaveBeenCalled();
  });

  it('conflict never names a site the caller cannot see', async () => {
    moveSelects(SITE_C);
    const result = await moveDeviceToSite({ ...baseArgs, permissions: restricted(SITE_A, SITE_B), reevaluationReason: 'r' });
    expect(result.outcome).toBe('conflict');
    expect(result).not.toHaveProperty('currentSiteId');
    expect(JSON.stringify(result)).not.toContain(SITE_C);
  });

  it('conflict: the guarded UPDATE matches no row — savepoint rolls back before the denormalized rewrite', async () => {
    queueSelects([[{ id: SITE_B, orgId: 'org-1', name: 'Lakeside' }], [{ siteId: SITE_A }], [{ name: 'Main Office' }], [{ siteId: SITE_C }]]);
    returningRows = [];
    const result = await moveDeviceToSite({ ...baseArgs, reevaluationReason: 'r' });
    expect(result).toMatchObject({ outcome: 'conflict', currentSiteId: SITE_C });
    expect(rewriteDeviceSiteDenormalizedTables).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
    expect(requestDeviceGroupReevaluationAfterCommit).not.toHaveBeenCalled();
  });

  it('forbidden: the target site is not in the device org (or missing)', async () => {
    queueSelects([[]]);
    const result = await moveDeviceToSite({ ...baseArgs, reevaluationReason: 'r' });
    expect(result).toMatchObject({ outcome: 'forbidden', reason: 'target_site_not_found' });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it('forbidden: a site-scoped caller moving INTO a site outside the allowlist', async () => {
    queueSelects([[{ id: SITE_B, orgId: 'org-1', name: 'Lakeside' }]]);
    const result = await moveDeviceToSite({ ...baseArgs, permissions: restricted(SITE_A), reevaluationReason: 'r' });
    expect(result).toMatchObject({ outcome: 'forbidden', reason: 'target_site_denied' });
    expect(selectCalls).toHaveLength(1);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('a non-Error throw inside the savepoint propagates (the caller decides; nothing is reported as moved)', async () => {
    moveSelects();
    vi.mocked(rewriteDeviceSiteDenormalizedTables).mockRejectedValueOnce(new Error('deadlock'));
    await expect(moveDeviceToSite({ ...baseArgs, reevaluationReason: 'r' })).rejects.toThrow('deadlock');
    expect(audits).toHaveLength(0);
    expect(requestDeviceGroupReevaluationAfterCommit).not.toHaveBeenCalled();
  });
});

describe('prepareDeviceSiteMove + executeDeviceSiteMove (PATCH combined update)', () => {
  it('prepare returns the target site name; execute carries extra columns and custom-field writes into the savepoint', async () => {
    queueSelects([[{ id: SITE_B, orgId: 'org-1', name: 'Lakeside' }]]);
    const prepared = await prepareDeviceSiteMove({ device, permissions: unrestricted, toSiteId: SITE_B, expectedSiteId: undefined });
    expect(prepared).toEqual({ outcome: 'ready', targetSiteName: 'Lakeside' });

    queueSelects([[{ siteId: SITE_A }], [{ name: 'Main Office' }]]);
    let persistedInside = false;
    vi.mocked(persistDeviceCustomFieldValues).mockImplementation(async () => { persistedInside = insideSavepoint; return undefined as never; });
    const writes = [{ definitionId: 'd1', fieldKey: 'assetTag', type: 'text' as const, value: 'HD-0042' }];
    const result = await executeDeviceSiteMove({
      device, permissions: unrestricted, toSiteId: SITE_B, targetSiteName: 'Lakeside', expectedSiteId: null, trigger: 'manual',
      updates: { updatedAt: new Date(), displayName: 'Front desk' }, customFieldWrites: writes,
      groupFilterFields: ['displayName'], changedFields: ['displayName', 'siteId', 'customFields'], reevaluationReason: 'device_patch', audit,
    });
    expect(result.outcome).toBe('moved');
    expect(persistedInside).toBe(true);
    expect(persistDeviceCustomFieldValues).toHaveBeenCalledWith(DEVICE_ID, 'org-1', writes, 'manual');
    expect(sets[0]).toMatchObject({ displayName: 'Front desk', siteId: SITE_B });
    expect(requestDeviceGroupReevaluationAfterCommit).toHaveBeenCalledWith(expect.objectContaining({
      changedFields: ['displayName', 'siteId'], reason: 'device_patch',
    }));
    expect(audits[0]!.details).toEqual({ changedFields: ['displayName', 'siteId', 'customFields'] });
    expect(audits[1]!.details).toMatchObject({ expectedSiteId: null });
  });

  it('a guarded-UPDATE conflict rolls the custom-field writes back with the savepoint', async () => {
    queueSelects([[{ siteId: SITE_A }], [{ name: 'Main Office' }], [{ siteId: SITE_C }]]);
    returningRows = [];
    const order: string[] = [];
    vi.mocked(persistDeviceCustomFieldValues).mockImplementation(async () => { order.push(insideSavepoint ? 'persist:inside' : 'persist:outside'); return undefined as never; });
    const result = await executeDeviceSiteMove({
      device, permissions: unrestricted, toSiteId: SITE_B, targetSiteName: 'Lakeside', expectedSiteId: null, trigger: 'manual',
      customFieldWrites: [{ definitionId: 'd1', fieldKey: 'k', type: 'text', value: 'v' }],
      changedFields: ['siteId', 'customFields'], reevaluationReason: 'device_patch', audit,
    });
    expect(result).toMatchObject({ outcome: 'conflict', currentSiteId: SITE_C });
    expect(order).toEqual(['persist:inside']);
    expect(audits).toHaveLength(0);
  });

  it('topology_suggestion: reads presence evidence under the lock, before the savepoint', async () => {
    queueSelects([[{ siteId: SITE_A }], [{ name: 'Main Office' }]]);
    vi.mocked(db.execute).mockResolvedValueOnce([] as never);
    const result = await executeDeviceSiteMove({
      device, permissions: unrestricted, toSiteId: SITE_B, targetSiteName: 'Lakeside', expectedSiteId: SITE_A, trigger: 'topology_suggestion',
      changedFields: ['siteId'], reevaluationReason: 'device_patch', audit,
    });
    expect(result.outcome).toBe('moved');
    expect(vi.mocked(db.execute).mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(db.transaction).mock.invocationCallOrder[0]!);
    expect(audits[1]!.details).toMatchObject({ trigger: 'topology_suggestion', suggestionState: 'not_eligible', evidence: null });
  });
});
