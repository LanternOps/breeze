import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';

const { requirePermissionMock } = vi.hoisted(() => ({
  requirePermissionMock: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    const restricted = c.req.header('x-site-restricted');
    c.set('permissions', {
      permissions: [{ resource, action }],
      allowedSiteIds:
        restricted === 'true' ? ['site-allowed'] : restricted === 'empty' ? [] : undefined,
    });
    return next();
  }),
}));

vi.mock('../../db', () => ({
  db: {
    execute: vi.fn(),
  },
}));

const ACCESSIBLE_ORG_ID = '0d4433c3-6fa5-4bfb-a217-c9d2924e3f01';
const OTHER_ORG_ID = 'a63f79cf-9a10-4f5e-8de3-0a180fa7c882';

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1' },
      scope: 'organization',
      orgId: ACCESSIBLE_ORG_ID,
      accessibleOrgIds: [ACCESSIBLE_ORG_ID],
      canAccessOrg: (orgId: string) => orgId === ACCESSIBLE_ORG_ID,
      // Real SQL fragment so tests can assert the condition reaches the scope.
      orgCondition: () => sql`ORG_CONDITION_SENTINEL`,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: requirePermissionMock,
}));

vi.mock('../../services/managementPostureReport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/managementPostureReport')>();
  return {
    ...actual,
    getManagementPostureSummary: vi.fn(),
    getPostureDevices: vi.fn(),
  };
});

import {
  getManagementPostureSummary,
  getPostureDevices,
} from '../../services/managementPostureReport';
import { postureRoutes } from './posture';

const summaryMock = vi.mocked(getManagementPostureSummary);
const devicesMock = vi.mocked(getPostureDevices);

const EMPTY_SUMMARY = {
  category: 'rmm' as const,
  stalenessDays: 7,
  totals: {
    totalDevices: 0, neverScanned: 0, stale: 0,
    scannedNoneDetected: 0, detectedDevices: 0, freshDetectedDevices: 0,
  },
  orgs: [],
};

function sqlToString(node: unknown): string {
  const seen = new Set<object>();
  return JSON.stringify(node, (_k, v) => {
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return '[circular]';
      seen.add(v);
    }
    return v;
  });
}

function makeApp() {
  const app = new Hono();
  app.route('/devices', postureRoutes);
  return app;
}

beforeEach(() => {
  summaryMock.mockReset();
  devicesMock.mockReset();
  summaryMock.mockResolvedValue(EMPTY_SUMMARY);
  devicesMock.mockResolvedValue({ devices: [], total: 0 });
});

describe('GET /devices/management-posture/summary', () => {
  it('defaults to category=rmm, stalenessDays=7 and applies the auth org condition', async () => {
    const res = await makeApp().request('/devices/management-posture/summary');

    expect(res.status).toBe(200);
    expect(summaryMock).toHaveBeenCalledTimes(1);
    const args = summaryMock.mock.calls[0]![0];
    expect(args.category).toBe('rmm');
    expect(args.stalenessDays).toBe(7);
    expect(sqlToString(args.scope)).toContain('ORG_CONDITION_SENTINEL');
  });

  it('passes explicit category and stalenessDays through', async () => {
    const res = await makeApp().request(
      '/devices/management-posture/summary?category=remoteAccess&stalenessDays=30'
    );

    expect(res.status).toBe(200);
    const args = summaryMock.mock.calls[0]![0];
    expect(args.category).toBe('remoteAccess');
    expect(args.stalenessDays).toBe(30);
  });

  it('rejects an unknown category with 400 before any query runs', async () => {
    const res = await makeApp().request(
      "/devices/management-posture/summary?category=rmm';DROP TABLE devices;--"
    );

    expect(res.status).toBe(400);
    expect(summaryMock).not.toHaveBeenCalled();
  });

  it('403s an inaccessible orgId without calling the service', async () => {
    const res = await makeApp().request(
      `/devices/management-posture/summary?orgId=${OTHER_ORG_ID}`
    );

    expect(res.status).toBe(403);
    expect(summaryMock).not.toHaveBeenCalled();
  });

  it('narrows to an accessible orgId', async () => {
    const res = await makeApp().request(
      `/devices/management-posture/summary?orgId=${ACCESSIBLE_ORG_ID}`
    );

    expect(res.status).toBe(200);
    expect(sqlToString(summaryMock.mock.calls[0]![0].scope)).toContain(ACCESSIBLE_ORG_ID);
  });

  it('narrows site-restricted users to their allowed sites', async () => {
    const res = await makeApp().request('/devices/management-posture/summary', {
      headers: { 'x-site-restricted': 'true' },
    });

    expect(res.status).toBe(200);
    expect(sqlToString(summaryMock.mock.calls[0]![0].scope)).toContain('site-allowed');
  });

  it('returns an all-zero report for an empty site allowlist without querying', async () => {
    const res = await makeApp().request('/devices/management-posture/summary', {
      headers: { 'x-site-restricted': 'empty' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.totals.totalDevices).toBe(0);
    expect(body.data.orgs).toEqual([]);
    expect(summaryMock).not.toHaveBeenCalled();
  });
});

describe('GET /devices/management-posture/devices', () => {
  it('requires product', async () => {
    const res = await makeApp().request('/devices/management-posture/devices');

    expect(res.status).toBe(400);
    expect(devicesMock).not.toHaveBeenCalled();
  });

  it('passes product, status and pagination through with the org scope', async () => {
    const res = await makeApp().request(
      '/devices/management-posture/devices?product=ScreenConnect&status=active&page=2&limit=25'
    );

    expect(res.status).toBe(200);
    const args = devicesMock.mock.calls[0]![0];
    expect(args.product).toBe('ScreenConnect');
    expect(args.detectionStatus).toBe('active');
    expect(args.limit).toBe(25);
    expect(args.offset).toBe(25);
    expect(sqlToString(args.scope)).toContain('ORG_CONDITION_SENTINEL');

    const body = await res.json();
    expect(body.data).toEqual({ devices: [], total: 0, page: 2, limit: 25 });
  });

  it('rejects an invalid detection status', async () => {
    const res = await makeApp().request(
      '/devices/management-posture/devices?product=Atera&status=present'
    );

    expect(res.status).toBe(400);
    expect(devicesMock).not.toHaveBeenCalled();
  });

  it('403s an inaccessible orgId', async () => {
    const res = await makeApp().request(
      `/devices/management-posture/devices?product=Atera&orgId=${OTHER_ORG_ID}`
    );

    expect(res.status).toBe(403);
    expect(devicesMock).not.toHaveBeenCalled();
  });

  it('returns an empty page for an empty site allowlist without querying', async () => {
    const res = await makeApp().request(
      '/devices/management-posture/devices?product=Atera',
      { headers: { 'x-site-restricted': 'empty' } }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ devices: [], total: 0, page: 1, limit: 50 });
    expect(devicesMock).not.toHaveBeenCalled();
  });
});
