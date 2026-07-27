import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  executeCommandMock,
  getDeviceMock,
  auditSensitiveReadMock,
  authState,
  siteAccessDenied,
} = vi.hoisted(() => ({
  executeCommandMock: vi.fn(),
  getDeviceMock: vi.fn(),
  auditSensitiveReadMock: vi.fn(),
  authState: {
    current: {
      user: {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'reader@example.com',
      },
      scope: 'organization',
      orgId: '22222222-2222-4222-8222-222222222222',
      partnerId: null,
      accessibleOrgIds: ['22222222-2222-4222-8222-222222222222'],
      canAccessOrg: (orgId: string) => orgId === '22222222-2222-4222-8222-222222222222',
    },
  },
  siteAccessDenied: Symbol('SITE_ACCESS_DENIED'),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('auth', authState.current);
    await next();
  },
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../../services/commandQueue', () => ({
  executeCommand: executeCommandMock,
  CommandTypes: {
    FILE_READ: 'FILE_READ',
    FILE_LIST: 'FILE_LIST',
    FILE_LIST_DRIVES: 'FILE_LIST_DRIVES',
    FILE_WRITE: 'FILE_WRITE',
    FILE_COPY: 'FILE_COPY',
    FILE_DELETE: 'FILE_DELETE',
    FILE_RENAME: 'FILE_RENAME',
    FILE_TRASH_LIST: 'FILE_TRASH_LIST',
    FILE_TRASH_RESTORE: 'FILE_TRASH_RESTORE',
    FILE_TRASH_PURGE: 'FILE_TRASH_PURGE',
  },
}));

vi.mock('../../services/auditService', () => ({
  createAuditLog: vi.fn(),
}));

vi.mock('./helpers', () => ({
  getDeviceWithOrgAndSiteCheck: getDeviceMock,
  SITE_ACCESS_DENIED: siteAccessDenied,
}));

vi.mock('../../services/sensitiveReadAudit', () => ({
  auditSensitiveRead: auditSensitiveReadMock,
}));

import { fileBrowserRoutes } from './fileBrowser';

const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID = '22222222-2222-4222-8222-222222222222';

function app() {
  const instance = new Hono();
  instance.route('/', fileBrowserRoutes);
  return instance;
}

describe('file browser sensitive-read audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDeviceMock.mockResolvedValue({
      id: DEVICE_ID,
      orgId: ORG_ID,
      siteId: '44444444-4444-4444-8444-444444444444',
      hostname: 'device-1',
    });
  });

  it('audits only after the final file buffer is prepared with its exact byte length', async () => {
    const bytes = Buffer.from('downloaded bytes', 'utf8');
    executeCommandMock.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({
        path: '/private/customer-secret.txt',
        content: bytes.toString('base64'),
      }),
    });

    const res = await app().request(
      `/devices/${DEVICE_ID}/files/download?path=${encodeURIComponent('/private/customer-secret.txt')}`,
    );

    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
    expect(auditSensitiveReadMock).toHaveBeenCalledWith(expect.anything(), {
      action: 'file.download',
      orgId: ORG_ID,
      resourceType: 'device_file',
      resourceId: DEVICE_ID,
      format: 'binary',
      rowCount: 1,
      byteCount: bytes.length,
    });
    expect(JSON.stringify(auditSensitiveReadMock.mock.calls[0]?.[1]))
      .not.toContain('/private/customer-secret.txt');
  });

  it.each([
    ['missing or cross-org device', null, 404],
    ['site-denied device', siteAccessDenied, 403],
  ])('does not audit a %s', async (_label, device, status) => {
    getDeviceMock.mockResolvedValueOnce(device);

    const res = await app().request(
      `/devices/${DEVICE_ID}/files/download?path=${encodeURIComponent('/private/file.txt')}`,
    );

    expect(res.status).toBe(status);
    expect(executeCommandMock).not.toHaveBeenCalled();
    expect(auditSensitiveReadMock).not.toHaveBeenCalled();
  });

  it('does not audit an upstream command failure', async () => {
    executeCommandMock.mockResolvedValue({
      status: 'failed',
      error: 'agent refused the read',
    });

    const res = await app().request(
      `/devices/${DEVICE_ID}/files/download?path=${encodeURIComponent('/private/file.txt')}`,
    );

    expect(res.status).not.toBe(200);
    expect(auditSensitiveReadMock).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid JSON', '{not-json'],
    ['missing content', JSON.stringify({ path: '/private/file.txt' })],
    ['invalid base64', JSON.stringify({ path: '/private/file.txt', content: '%%%not-base64%%%' })],
  ])('does not audit an agent parse failure: %s', async (_label, stdout) => {
    executeCommandMock.mockResolvedValue({ status: 'completed', stdout });

    const res = await app().request(
      `/devices/${DEVICE_ID}/files/download?path=${encodeURIComponent('/private/file.txt')}`,
    );

    expect(res.status).toBe(502);
    expect(auditSensitiveReadMock).not.toHaveBeenCalled();
  });

  it('keeps successful response bytes unchanged when audit delivery is non-blocking', async () => {
    const bytes = Buffer.from('same response', 'utf8');
    executeCommandMock.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ path: '/tmp/file.bin', content: bytes.toString('base64') }),
    });
    auditSensitiveReadMock.mockImplementationOnce(() => {
      void Promise.reject(new Error('audit backend unavailable')).catch(() => undefined);
    });

    const res = await app().request(
      `/devices/${DEVICE_ID}/files/download?path=${encodeURIComponent('/tmp/file.bin')}`,
    );

    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
  });
});
