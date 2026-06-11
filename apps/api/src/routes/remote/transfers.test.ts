import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  fileTransfers: {
    id: 'fileTransfers.id',
    sessionId: 'fileTransfers.sessionId',
    deviceId: 'fileTransfers.deviceId',
    userId: 'fileTransfers.userId',
    direction: 'fileTransfers.direction',
    remotePath: 'fileTransfers.remotePath',
    localFilename: 'fileTransfers.localFilename',
    sizeBytes: 'fileTransfers.sizeBytes',
    status: 'fileTransfers.status',
    progressPercent: 'fileTransfers.progressPercent',
    errorMessage: 'fileTransfers.errorMessage',
    createdAt: 'fileTransfers.createdAt',
    completedAt: 'fileTransfers.completedAt',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    hostname: 'devices.hostname',
    osType: 'devices.osType',
  },
  users: { id: 'users.id', name: 'users.name', email: 'users.email' },
}));

// requireScope seeds auth; requirePermission seeds permissions (mirrors prod — only
// requirePermission populates c.get('permissions'), which the site-scope gate reads).
// x-restrict-site opts into a single-site allowlist.
vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => async (c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: 'org-111',
      accessibleOrgIds: ['org-111'],
      canAccessOrg: (id: string) => id === 'org-111',
    });
    return next();
  }),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    const restrict = c.req.header('x-restrict-site');
    c.set('permissions', {
      permissions: [],
      partnerId: null,
      orgId: 'org-111',
      roleId: 'role-1',
      scope: 'organization',
      ...(restrict ? { allowedSiteIds: [restrict] } : {}),
    });
    return next();
  }),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: { DEVICES_READ: { resource: 'devices', action: 'read' } },
  canAccessSite: (perms: any, siteId: string) =>
    !perms?.allowedSiteIds || perms.allowedSiteIds.includes(siteId),
}));

vi.mock('../../services/fileStorage', () => ({
  saveChunk: vi.fn(),
  assembleChunks: vi.fn(),
  getFileStream: vi.fn(),
  getFileSize: vi.fn(),
  hasAssembledFile: vi.fn(),
  getTotalBytesReceived: vi.fn(),
  MAX_TRANSFER_SIZE_BYTES: 1024 * 1024,
}));

vi.mock('../../services/clientIp', () => ({
  getTrustedClientIpOrUndefined: vi.fn(() => '10.0.0.1'),
}));

vi.mock('./helpers', () => ({
  getPagination: vi.fn(() => ({ page: 1, limit: 50, offset: 0 })),
  getDeviceWithOrgCheck: vi.fn(),
  getSessionWithOrgCheck: vi.fn(),
  getTransferWithOrgCheck: vi.fn(),
  hasSessionOrTransferOwnership: vi.fn(() => true),
  logSessionAudit: vi.fn(),
  MAX_ACTIVE_TRANSFERS_PER_ORG: 10,
  MAX_ACTIVE_TRANSFERS_PER_USER: 5,
}));

import { transferRoutes } from './transfers';
import { db } from '../../db';
import { getTransferWithOrgCheck } from './helpers';
import { hasAssembledFile, getFileSize, getFileStream } from '../../services/fileStorage';

const ALLOWED_SITE = 'site-a';
const FORBIDDEN_SITE = 'site-b';
const DEVICE_IN_ALLOWED = '11111111-1111-4111-8111-111111111111';
const DEVICE_IN_FORBIDDEN = '22222222-2222-4222-8222-222222222222';
const TRANSFER_ID = '33333333-3333-4333-8333-333333333333';

function conditionContainsSiteScope(condition: unknown, siteId = ALLOWED_SITE): boolean {
  if (!condition || typeof condition !== 'object') return false;
  const chunks = (condition as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) return false;
  const hasSiteColumn = chunks.some((chunk) => chunk === 'devices.siteId' || conditionContainsSiteScope(chunk, siteId));
  const hasAllowedSites = chunks.some((chunk) => Array.isArray(chunk) && chunk.includes(siteId));
  return hasSiteColumn && (hasAllowedSites || chunks.some((chunk) => conditionContainsSiteScope(chunk, siteId)));
}

function makeTransferRow(deviceId: string) {
  return {
    id: TRANSFER_ID,
    sessionId: null,
    deviceId,
    userId: 'user-1',
    direction: 'download',
    remotePath: '/tmp/source.txt',
    localFilename: 'source.txt',
    sizeBytes: 128n,
    status: 'completed',
    progressPercent: 100,
    errorMessage: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    completedAt: new Date('2026-01-01T00:01:00Z'),
    deviceHostname: 'host-1',
    userName: 'Test User',
  };
}

describe('remote transfers — site-scope enforcement', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(db.update).mockReset();
    vi.mocked(db.insert).mockReset();
    app = new Hono();
    app.route('/remote', transferRoutes);
  });

  function rigListTransfers(
    orgDevices: Array<{ id: string; siteId: string | null }> | null,
    rows: Array<ReturnType<typeof makeTransferRow>>,
  ) {
    if (orgDevices) {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(orgDevices) }),
      } as never);
    }

    const countWhere = vi.fn((condition: unknown) => {
      expect(conditionContainsSiteScope(condition)).toBe(true);
      return Promise.resolve([{ count: rows.length }]);
    });
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({ where: countWhere }),
      }),
    } as never);

    const listWhere = vi.fn((condition: unknown) => {
      expect(conditionContainsSiteScope(condition)).toBe(true);
      return {
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({ offset: vi.fn().mockResolvedValue(rows) }),
        }),
      };
    });
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({ where: listWhere }),
        }),
      }),
    } as never);
    return { countWhere, listWhere };
  }

  function rigListTransfersUnrestricted(rows: Array<ReturnType<typeof makeTransferRow>>) {
    const countWhere = vi.fn().mockResolvedValue([{ count: rows.length }]);
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({ where: countWhere }),
      }),
    } as never);

    const listWhere = vi.fn().mockReturnValue({
      orderBy: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({ offset: vi.fn().mockResolvedValue(rows) }),
      }),
    });
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({ where: listWhere }),
        }),
      }),
    } as never);
    return { countWhere, listWhere };
  }

  it('returns 403 when a site-restricted caller filters by an out-of-scope deviceId', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { id: DEVICE_IN_ALLOWED, siteId: ALLOWED_SITE },
          { id: DEVICE_IN_FORBIDDEN, siteId: FORBIDDEN_SITE },
        ]),
      }),
    } as never);

    const res = await app.request(`/remote/transfers?deviceId=${DEVICE_IN_FORBIDDEN}`, {
      headers: { Authorization: 'Bearer t', 'x-restrict-site': ALLOWED_SITE },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Device not found or access denied' });
  });

  it('narrows the transfer list to the caller allowed sites', async () => {
    const { countWhere, listWhere } = rigListTransfers(
      [
        { id: DEVICE_IN_ALLOWED, siteId: ALLOWED_SITE },
        { id: DEVICE_IN_FORBIDDEN, siteId: FORBIDDEN_SITE },
      ],
      [makeTransferRow(DEVICE_IN_ALLOWED)]
    );

    const res = await app.request('/remote/transfers', {
      headers: { Authorization: 'Bearer t', 'x-restrict-site': ALLOWED_SITE },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].deviceId).toBe(DEVICE_IN_ALLOWED);
    expect(body.pagination.total).toBe(1);
    expect(countWhere).toHaveBeenCalledTimes(1);
    expect(listWhere).toHaveBeenCalledTimes(1);
  });

  it('does not narrow the transfer list for unrestricted callers', async () => {
    const { countWhere, listWhere } = rigListTransfersUnrestricted([
      makeTransferRow(DEVICE_IN_ALLOWED),
      makeTransferRow(DEVICE_IN_FORBIDDEN),
    ]);

    const res = await app.request('/remote/transfers', {
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.pagination.total).toBe(2);
    expect(db.select).toHaveBeenCalledTimes(2);
    expect(countWhere).toHaveBeenCalledTimes(1);
    expect(listWhere).toHaveBeenCalledTimes(1);
  });

  describe('GET /transfers/:id', () => {
    function rigTransferDetail(device: Record<string, unknown>) {
      vi.mocked(getTransferWithOrgCheck).mockResolvedValue({
        transfer: { ...makeTransferRow(device.id as string) },
        device: { id: device.id, hostname: 'host-1', osType: 'linux', ...device },
      } as never);
      // user info lookup
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ name: 'Test User', email: 'test@example.com' }]) }),
        }),
      } as never);
    }

    it('returns 403 when caller is site-restricted away from the transfer device site', async () => {
      vi.mocked(getTransferWithOrgCheck).mockResolvedValue({
        transfer: makeTransferRow(DEVICE_IN_FORBIDDEN),
        device: { id: DEVICE_IN_FORBIDDEN, orgId: 'org-111', siteId: FORBIDDEN_SITE, hostname: 'host-1', osType: 'linux' },
      } as never);

      const res = await app.request(`/remote/transfers/${TRANSFER_ID}`, {
        headers: { Authorization: 'Bearer t', 'x-restrict-site': ALLOWED_SITE },
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/site/i);
      expect(body).not.toHaveProperty('remotePath');
    });

    it('returns 403 when the transfer device has a null siteId and caller is site-restricted', async () => {
      vi.mocked(getTransferWithOrgCheck).mockResolvedValue({
        transfer: makeTransferRow(DEVICE_IN_ALLOWED),
        device: { id: DEVICE_IN_ALLOWED, orgId: 'org-111', siteId: null, hostname: 'host-1', osType: 'linux' },
      } as never);

      const res = await app.request(`/remote/transfers/${TRANSFER_ID}`, {
        headers: { Authorization: 'Bearer t', 'x-restrict-site': ALLOWED_SITE },
      });

      expect(res.status).toBe(403);
    });

    it('returns the transfer detail when caller is restricted to the transfer device site', async () => {
      rigTransferDetail({ id: DEVICE_IN_ALLOWED, orgId: 'org-111', siteId: ALLOWED_SITE });

      const res = await app.request(`/remote/transfers/${TRANSFER_ID}`, {
        headers: { Authorization: 'Bearer t', 'x-restrict-site': ALLOWED_SITE },
      });

      expect(res.status).toBe(200);
      expect((await res.json()).id).toBe(TRANSFER_ID);
    });

    it('returns the transfer detail for an unrestricted caller regardless of device site', async () => {
      rigTransferDetail({ id: DEVICE_IN_FORBIDDEN, orgId: 'org-111', siteId: FORBIDDEN_SITE });

      const res = await app.request(`/remote/transfers/${TRANSFER_ID}`, {
        headers: { Authorization: 'Bearer t' },
      });

      expect(res.status).toBe(200);
      expect((await res.json()).id).toBe(TRANSFER_ID);
    });
  });

  describe('GET /transfers/:id/download', () => {
    it('returns 403 when caller is site-restricted away from the transfer device site', async () => {
      vi.mocked(getTransferWithOrgCheck).mockResolvedValue({
        transfer: { ...makeTransferRow(DEVICE_IN_FORBIDDEN), direction: 'upload', status: 'completed' },
        device: { id: DEVICE_IN_FORBIDDEN, orgId: 'org-111', siteId: FORBIDDEN_SITE, hostname: 'host-1', osType: 'linux' },
      } as never);

      const res = await app.request(`/remote/transfers/${TRANSFER_ID}/download`, {
        headers: { Authorization: 'Bearer t', 'x-restrict-site': ALLOWED_SITE },
      });

      expect(res.status).toBe(403);
      // Must not stream file content for an out-of-site device.
      expect(hasAssembledFile).not.toHaveBeenCalled();
    });

    it('streams the file when caller is restricted to the transfer device site', async () => {
      vi.mocked(getTransferWithOrgCheck).mockResolvedValue({
        transfer: { ...makeTransferRow(DEVICE_IN_ALLOWED), direction: 'upload', status: 'completed' },
        device: { id: DEVICE_IN_ALLOWED, orgId: 'org-111', siteId: ALLOWED_SITE, hostname: 'host-1', osType: 'linux' },
      } as never);
      vi.mocked(hasAssembledFile).mockReturnValue(true);
      vi.mocked(getFileSize).mockReturnValue(128);
      const { Readable } = await import('stream');
      vi.mocked(getFileStream).mockReturnValue(Readable.from(Buffer.from('hello')) as never);

      const res = await app.request(`/remote/transfers/${TRANSFER_ID}/download`, {
        headers: { Authorization: 'Bearer t', 'x-restrict-site': ALLOWED_SITE },
      });

      expect(res.status).toBe(200);
      expect(hasAssembledFile).toHaveBeenCalled();
    });

    it('streams the file for an unrestricted caller regardless of device site', async () => {
      vi.mocked(getTransferWithOrgCheck).mockResolvedValue({
        transfer: { ...makeTransferRow(DEVICE_IN_FORBIDDEN), direction: 'upload', status: 'completed' },
        device: { id: DEVICE_IN_FORBIDDEN, orgId: 'org-111', siteId: FORBIDDEN_SITE, hostname: 'host-1', osType: 'linux' },
      } as never);
      vi.mocked(hasAssembledFile).mockReturnValue(true);
      vi.mocked(getFileSize).mockReturnValue(128);
      const { Readable } = await import('stream');
      vi.mocked(getFileStream).mockReturnValue(Readable.from(Buffer.from('hello')) as never);

      const res = await app.request(`/remote/transfers/${TRANSFER_ID}/download`, {
        headers: { Authorization: 'Bearer t' },
      });

      expect(res.status).toBe(200);
    });
  });
});
