import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  getDeviceMock,
  canReadSensitiveMock,
  authState,
  siteAccessDenied,
  selectWhereArgs,
} = vi.hoisted(() => ({
  getDeviceMock: vi.fn(),
  canReadSensitiveMock: vi.fn(),
  authState: {
    current: {
      user: { id: '11111111-1111-4111-8111-111111111111', email: 'reader@example.com' },
      scope: 'organization',
      orgId: '22222222-2222-4222-8222-222222222222',
      partnerId: null,
      accessibleOrgIds: ['22222222-2222-4222-8222-222222222222'],
      canAccessOrg: (orgId: string) => orgId === '22222222-2222-4222-8222-222222222222',
    },
  },
  siteAccessDenied: Symbol('SITE_ACCESS_DENIED'),
  selectWhereArgs: [] as unknown[],
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('auth', authState.current);
    await next();
  },
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('./helpers', async () => {
  const actual = await vi.importActual<typeof import('./helpers')>('./helpers');
  return {
    ...actual,
    getDeviceWithOrgAndSiteCheck: getDeviceMock,
    SITE_ACCESS_DENIED: siteAccessDenied,
  };
});

vi.mock('../../services/eventLogSensitivity', async () => {
  const actual = await vi.importActual<typeof import('../../services/eventLogSensitivity')>(
    '../../services/eventLogSensitivity'
  );
  return {
    ...actual,
    canReadSensitiveEventLogCategory: canReadSensitiveMock,
  };
});

vi.mock('../../db', () => ({
  db: {
    select: vi.fn((projection?: Record<string, unknown>) => ({
      from: vi.fn(() => ({
        where: vi.fn((cond: unknown) => {
          selectWhereArgs.push(cond);
          if (projection && 'count' in projection) {
            return Promise.resolve([{ count: 0 }]);
          }
          return {
            orderBy: vi.fn(() => ({
              limit: vi.fn(() => ({
                offset: vi.fn(() => Promise.resolve([])),
              })),
            })),
          };
        }),
      })),
    })),
  },
}));

import { eventLogsRoutes } from './eventlogs';

const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID = '22222222-2222-4222-8222-222222222222';

function app() {
  const instance = new Hono();
  instance.route('/', eventLogsRoutes);
  return instance;
}

describe('device eventlogs stored-log category sensitivity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectWhereArgs.length = 0;
    getDeviceMock.mockResolvedValue({
      id: DEVICE_ID,
      orgId: ORG_ID,
      siteId: '44444444-4444-4444-8444-444444444444',
      hostname: 'device-1',
    });
  });

  it('refuses a devices:read-only caller explicitly requesting category=security', async () => {
    canReadSensitiveMock.mockResolvedValue(false);

    const res = await app().request(`/${DEVICE_ID}/eventlogs?category=security`);

    expect(res.status).toBe(403);
  });

  it('allows a devices:execute caller to request category=security', async () => {
    canReadSensitiveMock.mockResolvedValue(true);

    const res = await app().request(`/${DEVICE_ID}/eventlogs?category=security`);

    expect(res.status).toBe(200);
  });

  it('excludes security rows for a devices:read-only caller with no category filter', async () => {
    canReadSensitiveMock.mockResolvedValue(false);

    const res = await app().request(`/${DEVICE_ID}/eventlogs`);

    expect(res.status).toBe(200);
    expect(selectWhereArgs.length).toBeGreaterThan(0);
  });

  it('allows a devices:read-only caller to request an ordinary category', async () => {
    canReadSensitiveMock.mockResolvedValue(false);

    const res = await app().request(`/${DEVICE_ID}/eventlogs?category=application`);

    expect(res.status).toBe(200);
  });
});
