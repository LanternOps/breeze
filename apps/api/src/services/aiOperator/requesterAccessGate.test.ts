import { beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  selectMock: vi.fn(),
  getUserPermissions: vi.fn(),
  canAccessOrg: vi.fn(),
  canAccessSite: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: { select: shared.selectMock },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema/users', () => ({
  users: { id: 'users.id', partnerId: 'users.partnerId', status: 'users.status' },
}));

vi.mock('../../db/schema/devices', () => ({
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
}));

vi.mock('../permissions', () => ({
  getUserPermissions: shared.getUserPermissions,
  canAccessOrg: shared.canAccessOrg,
  canAccessSite: shared.canAccessSite,
}));

import { requesterAccessLost } from './requesterAccessGate';

const ORG_ID = 'org-1';
const DEVICE_ID = 'device-1';
const USER_ID = 'user-1';

/** One `db.select(...).from(...).where(...).limit(1)` call resolving to `rows`. */
function queueSelect(rows: unknown[]) {
  shared.selectMock.mockReturnValueOnce({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  shared.canAccessOrg.mockReturnValue(true);
  shared.canAccessSite.mockReturnValue(true);
});

describe('requesterAccessLost', () => {
  it('has nothing to check for a task with no requester (automatic origin)', async () => {
    const result = await requesterAccessLost({ orgId: ORG_ID, requesterUserId: null }, DEVICE_ID);
    expect(result).toEqual({ lost: false, detail: null });
    expect(shared.selectMock).not.toHaveBeenCalled();
    expect(shared.getUserPermissions).not.toHaveBeenCalled();
  });

  it('is lost when the requester account no longer exists', async () => {
    queueSelect([]);
    const result = await requesterAccessLost({ orgId: ORG_ID, requesterUserId: USER_ID }, DEVICE_ID);
    expect(result.lost).toBe(true);
    expect(result.detail).toMatch(/no longer active/);
  });

  it('is lost when the requester account is no longer active', async () => {
    queueSelect([{ id: USER_ID, partnerId: 'p1', status: 'disabled' }]);
    const result = await requesterAccessLost({ orgId: ORG_ID, requesterUserId: USER_ID }, DEVICE_ID);
    expect(result.lost).toBe(true);
    expect(result.detail).toMatch(/no longer active/);
  });

  it('is lost when live permissions no longer resolve for the org', async () => {
    queueSelect([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);
    shared.getUserPermissions.mockResolvedValue(null);
    const result = await requesterAccessLost({ orgId: ORG_ID, requesterUserId: USER_ID }, DEVICE_ID);
    expect(result.lost).toBe(true);
    expect(result.detail).toMatch(/no longer has access to organization/);
    expect(shared.getUserPermissions).toHaveBeenCalledWith(
      USER_ID,
      { partnerId: 'p1', orgId: ORG_ID },
      { bypassCache: true },
    );
  });

  it('is lost when canAccessOrg rejects the live permission set', async () => {
    queueSelect([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);
    shared.getUserPermissions.mockResolvedValue({ scope: 'organization', orgId: ORG_ID });
    shared.canAccessOrg.mockReturnValue(false);
    const result = await requesterAccessLost({ orgId: ORG_ID, requesterUserId: USER_ID }, DEVICE_ID);
    expect(result.lost).toBe(true);
    expect(result.detail).toMatch(/no longer has access to organization/);
  });

  it('is lost when the target device no longer resolves in this org', async () => {
    queueSelect([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);
    shared.getUserPermissions.mockResolvedValue({ scope: 'organization', orgId: ORG_ID });
    queueSelect([]); // device lookup
    const result = await requesterAccessLost({ orgId: ORG_ID, requesterUserId: USER_ID }, DEVICE_ID);
    expect(result.lost).toBe(true);
    expect(result.detail).toMatch(/target device is no longer/);
  });

  it('is lost when the requester is site-restricted away from the device', async () => {
    queueSelect([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);
    shared.getUserPermissions.mockResolvedValue({ scope: 'organization', orgId: ORG_ID, allowedSiteIds: ['site-A'] });
    queueSelect([{ id: DEVICE_ID, siteId: 'site-B' }]);
    shared.canAccessSite.mockReturnValue(false);
    const result = await requesterAccessLost({ orgId: ORG_ID, requesterUserId: USER_ID }, DEVICE_ID);
    expect(result.lost).toBe(true);
    expect(result.detail).toMatch(/site/);
  });

  it('is NOT lost when org, org-access and site all still resolve live', async () => {
    queueSelect([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);
    shared.getUserPermissions.mockResolvedValue({ scope: 'organization', orgId: ORG_ID, allowedSiteIds: ['site-A'] });
    queueSelect([{ id: DEVICE_ID, siteId: 'site-A' }]);
    const result = await requesterAccessLost({ orgId: ORG_ID, requesterUserId: USER_ID }, DEVICE_ID);
    expect(result).toEqual({ lost: false, detail: null });
  });
});
