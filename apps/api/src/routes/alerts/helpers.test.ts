import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ db: { select: vi.fn() } }));
import { db } from '../../db';
import { getAlertWithOrgCheck } from './helpers';

const orgId = '11111111-1111-4111-8111-111111111111';
const siteId = '22222222-2222-4222-8222-222222222222';
const alert = { id: '33333333-3333-4333-8333-333333333333', orgId,
  deviceId: null, topologySiteId: null, ownerKind: 'backup_workload', ownerRef: 'workload' };

beforeEach(() => {
  vi.mocked(db.select).mockReset();
  vi.mocked(db.select).mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [alert] }) }) } as never);
});

describe('getAlertWithOrgCheck workload visibility', () => {
  it.each([{ allowedSiteIds: [siteId] }, { allowedSiteIds: [] }])('denies workload by id with site allowlist %j', async ({ allowedSiteIds }) => {
    expect(await getAlertWithOrgCheck(alert.id, { canAccessOrg: () => true, allowedSiteIds })).toBeNull();
    expect(db.select).toHaveBeenCalledTimes(1);
  });
  it('allows workload by id without a site restriction', async () => {
    expect(await getAlertWithOrgCheck(alert.id, { canAccessOrg: () => true })).toEqual(alert);
  });
  it('denies another organization regardless of site scope', async () => {
    expect(await getAlertWithOrgCheck(alert.id, { canAccessOrg: () => false })).toBeNull();
  });
});
