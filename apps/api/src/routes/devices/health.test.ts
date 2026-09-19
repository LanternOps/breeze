import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { requirePermissionMock, siteDenied } = vi.hoisted(() => ({
  requirePermissionMock: vi.fn(() => async (_c: any, next: any) => next()),
  siteDenied: Symbol('SITE_ACCESS_DENIED'),
}));

vi.mock('../../db', () => ({
  db: { select: vi.fn() },
}));

vi.mock('../../db/schema', () => ({
  agentHealthObservations: {
    id: 'agent_health_observations.id',
    orgId: 'agent_health_observations.org_id',
    deviceId: 'agent_health_observations.device_id',
    schemaVersion: 'agent_health_observations.schema_version',
    agentVersion: 'agent_health_observations.agent_version',
    overall: 'agent_health_observations.overall',
    metricsAvailable: 'agent_health_observations.metrics_available',
    components: 'agent_health_observations.components',
    observedAt: 'agent_health_observations.observed_at',
  },
  deviceAgentHealthLatest: {
    deviceId: 'device_agent_health_latest.device_id',
    orgId: 'device_agent_health_latest.org_id',
    observationId: 'device_agent_health_latest.observation_id',
    receivedAt: 'device_agent_health_latest.received_at',
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1' },
      scope: 'organization',
      orgId: 'org-1',
      accessibleOrgIds: ['org-1'],
      canAccessOrg: (orgId: string) => orgId === 'org-1',
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: requirePermissionMock,
}));

vi.mock('./helpers', () => ({
  getDeviceWithOrgAndSiteCheck: vi.fn(),
  SITE_ACCESS_DENIED: siteDenied,
}));

import { db } from '../../db';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';
import { healthRoutes } from './health';

const registeredPermissionCalls = [...requirePermissionMock.mock.calls];

function app() {
  const instance = new Hono();
  instance.route('/devices', healthRoutes);
  return instance;
}

function selectRows(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn(() => ({
      innerJoin: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue(rows),
        })),
      })),
    })),
  } as never);
}

describe('GET /devices/:id/health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers the devices:read permission gate', () => {
    expect(registeredPermissionCalls).toContainEqual(['devices', 'read']);
  });

  it('returns an explicit unknown view for an authorized device with no observation', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
      id: 'device-1', orgId: 'org-1', siteId: 'site-1',
    } as never);
    selectRows([]);

    const response = await app().request('/devices/device-1/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'unknown', observation: null });
  });

  it('returns only the latest authorized observation with authoritative device identity', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
      id: 'device-1', orgId: 'org-1', siteId: 'site-1',
    } as never);
    selectRows([{
      schemaVersion: 1,
      agentVersion: '0.65.10',
      overall: 'warning',
      metricsAvailable: false,
      components: { metrics: { state: 'warning', reason: 'collector failed' } },
      observedAt: new Date('2026-08-24T12:00:00.000Z'),
      receivedAt: new Date('2026-08-24T12:00:01.000Z'),
    }]);

    const response = await app().request('/devices/device-1/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'known',
      observation: {
        schemaVersion: 1,
        deviceId: 'device-1',
        agentVersion: '0.65.10',
        overall: 'warning',
        metricsAvailable: false,
        components: { metrics: { state: 'warning', reason: 'collector failed' } },
        observedAt: '2026-08-24T12:00:00.000Z',
      },
      receivedAt: '2026-08-24T12:00:01.000Z',
    });
  });

  it('returns the same 404 for malformed, missing, and foreign devices without reading health', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(null);

    for (const deviceId of ['not-a-uuid', 'missing-device', 'foreign-device']) {
      const response = await app().request(`/devices/${deviceId}/health`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Device not found' });
    }
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns 403 for a site-denied device without reading health', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SITE_ACCESS_DENIED as never);

    const response = await app().request('/devices/device-1/health');

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Access to this site denied' });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns 500 without leaking database details when the authorized health read fails', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
      id: 'device-1', orgId: 'org-1', siteId: 'site-1',
    } as never);
    vi.mocked(db.select).mockImplementation(() => {
      throw new Error('relation device_agent_health_latest leaked-detail');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await app().request('/devices/device-1/health');

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    errorSpy.mockRestore();
  });
});
