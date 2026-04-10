import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { vssRoutes } from './vss';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_ORG_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

vi.mock('../../services', () => ({}));

const executeCommandMock = vi.fn();

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn(() => chainMock([]));
let authState = {
  user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
  scope: 'organization' as const,
  partnerId: null,
  orgId: ORG_ID,
  token: { sub: 'user-123' },
};

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
}));

vi.mock('../../db/schema', () => ({
  devices: {
    id: 'devices.id',
    orgId: 'devices.org_id',
  },
}));

vi.mock('../../services/commandQueue', () => ({
  executeCommand: (...args: unknown[]) => executeCommandMock(...(args as [])),
  CommandTypes: {
    VSS_WRITER_LIST: 'VSS_WRITER_LIST',
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authState);
    return next();
  }),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

import { authMiddleware } from '../../middleware/auth';

describe('vss routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    authState = {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: ORG_ID,
      token: { sub: 'user-123' },
    };
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', authState);
      return next();
    });
    app = new Hono();
    app.use('*', authMiddleware);
    app.route('/backup/vss', vssRoutes);
  });

  it('returns VSS writer status for a device', async () => {
    selectMock.mockReturnValueOnce(chainMock([{ id: DEVICE_ID, orgId: ORG_ID }]));
    executeCommandMock.mockResolvedValueOnce({
      status: 'completed',
      stdout: JSON.stringify({ writers: [{ name: 'System Writer', state: 'stable' }] }),
    });

    const res = await app.request(`/backup/vss/status/${DEVICE_ID}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.writers[0].name).toBe('System Writer');
  });

  it('rejects an invalid device UUID', async () => {
    const res = await app.request('/backup/vss/status/not-a-uuid', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(400);
  });

  it('rejects cross-org device access', async () => {
    selectMock.mockReturnValueOnce(chainMock([{ id: DEVICE_ID, orgId: OTHER_ORG_ID }]));

    const res = await app.request(`/backup/vss/status/${DEVICE_ID}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(404);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });
});
