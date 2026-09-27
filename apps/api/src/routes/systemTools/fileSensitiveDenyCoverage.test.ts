/**
 * Regression coverage for the server-side agent-config-directory deny on the
 * file-mutation routes that were not covered by the original download-only
 * fix: copy, move, upload (overwrite), and delete. Without this, an
 * un-upgraded agent lets an execute-tier caller copy the agent's own
 * secrets file to another path and download the copy from there — the
 * download route's deny only ever sees the literal requested path, so a
 * copy/move defeats it entirely.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { executeCommandMock, getDeviceMock } = vi.hoisted(() => ({
  executeCommandMock: vi.fn(),
  getDeviceMock: vi.fn(),
}));

const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID = '22222222-2222-4222-8222-222222222222';

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('auth', {
      user: { id: '11111111-1111-4111-8111-111111111111', email: 'tech@example.com' },
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (orgId: string) => orgId === ORG_ID,
    });
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
  createAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/sensitiveReadAudit', () => ({
  auditSensitiveRead: vi.fn(),
}));

vi.mock('../../services/clientIp', () => ({
  getTrustedClientIpOrUndefined: () => undefined,
}));

vi.mock('./helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./helpers')>();
  return {
    ...actual,
    getDeviceWithOrgAndSiteCheck: getDeviceMock,
  };
});

import { fileBrowserRoutes } from './fileBrowser';

function fileApp() {
  const instance = new Hono();
  instance.route('/', fileBrowserRoutes);
  return instance;
}

const SENSITIVE_PATH = String.raw`C:\ProgramData\Breeze\secrets.yaml`;
const ORDINARY_PATH = String.raw`C:\Users\tech\ordinary.txt`;

beforeEach(() => {
  vi.clearAllMocks();
  getDeviceMock.mockResolvedValue({
    id: DEVICE_ID,
    orgId: ORG_ID,
    siteId: null,
    hostname: 'device-1',
  });
});

describe('file copy sensitive-path deny', () => {
  it('denies when the source is the agent config directory', async () => {
    const res = await fileApp().request(`/devices/${DEVICE_ID}/files/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ sourcePath: SENSITIVE_PATH, destPath: ORDINARY_PATH }] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].status).toBe('failure');
    expect(body.results[0].code).toBe('sensitive_path_denied');
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('denies when the destination is the agent config directory', async () => {
    const res = await fileApp().request(`/devices/${DEVICE_ID}/files/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ sourcePath: ORDINARY_PATH, destPath: SENSITIVE_PATH }] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].status).toBe('failure');
    expect(body.results[0].code).toBe('sensitive_path_denied');
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('allows an ordinary copy', async () => {
    executeCommandMock.mockResolvedValue({ status: 'completed', stdout: '{}' });

    const res = await fileApp().request(`/devices/${DEVICE_ID}/files/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ sourcePath: ORDINARY_PATH, destPath: `${ORDINARY_PATH}.bak` }] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].status).toBe('success');
    expect(executeCommandMock).toHaveBeenCalled();
  });
});

describe('file move sensitive-path deny', () => {
  it('denies when the source is the agent config directory', async () => {
    const res = await fileApp().request(`/devices/${DEVICE_ID}/files/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ sourcePath: SENSITIVE_PATH, destPath: ORDINARY_PATH }] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].status).toBe('failure');
    expect(body.results[0].code).toBe('sensitive_path_denied');
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('denies when the destination is the agent config directory', async () => {
    const res = await fileApp().request(`/devices/${DEVICE_ID}/files/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ sourcePath: ORDINARY_PATH, destPath: SENSITIVE_PATH }] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].status).toBe('failure');
    expect(body.results[0].code).toBe('sensitive_path_denied');
    expect(executeCommandMock).not.toHaveBeenCalled();
  });
});

describe('file upload sensitive-path deny', () => {
  it('denies overwriting into the agent config directory', async () => {
    const res = await fileApp().request(`/devices/${DEVICE_ID}/files/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: SENSITIVE_PATH, content: 'replacement', encoding: 'text' }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('sensitive_path_denied');
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('allows an ordinary upload', async () => {
    executeCommandMock.mockResolvedValue({ status: 'completed', stdout: JSON.stringify({ path: ORDINARY_PATH, size: 3 }) });

    const res = await fileApp().request(`/devices/${DEVICE_ID}/files/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: ORDINARY_PATH, content: 'abc', encoding: 'text' }),
    });

    expect(res.status).toBe(200);
    expect(executeCommandMock).toHaveBeenCalled();
  });
});

describe('file delete sensitive-path deny', () => {
  it('denies deleting the agent config directory', async () => {
    const res = await fileApp().request(`/devices/${DEVICE_ID}/files/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [SENSITIVE_PATH] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].status).toBe('failure');
    expect(body.results[0].code).toBe('sensitive_path_denied');
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('allows an ordinary delete', async () => {
    executeCommandMock.mockResolvedValue({ status: 'completed', stdout: '{}' });

    const res = await fileApp().request(`/devices/${DEVICE_ID}/files/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [ORDINARY_PATH] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].status).toBe('success');
    expect(executeCommandMock).toHaveBeenCalled();
  });
});
