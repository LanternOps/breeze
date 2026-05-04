import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { permissionGate, mfaGate } = vi.hoisted(() => ({
  permissionGate: { deny: false },
  mfaGate: { deny: false }
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }
,
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: { id: 'id', orgId: 'orgId', hostname: 'hostname' },
  s1Actions: {
    id: 'id',
    orgId: 'orgId',
    deviceId: 'deviceId',
    status: 'status',
    requestedAt: 'requestedAt',
    completedAt: 'completedAt',
    providerActionId: 'providerActionId',
    action: 'action'
  },
  s1Agents: {
    id: 'id',
    orgId: 'orgId',
    integrationId: 'integrationId',
    deviceId: 'deviceId',
    s1AgentId: 's1AgentId',
    infected: 'infected',
    threatCount: 'threatCount'
  },
  s1Integrations: {
    id: 'id',
    orgId: 'orgId',
    name: 'name',
    managementUrl: 'managementUrl',
    apiTokenEncrypted: 'apiTokenEncrypted',
    isActive: 'isActive',
    lastSyncAt: 'lastSyncAt',
    lastSyncStatus: 'lastSyncStatus',
    lastSyncError: 'lastSyncError',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
    createdBy: 'createdBy'
  },
  s1Threats: {
    id: 'id',
    s1ThreatId: 's1ThreatId',
    orgId: 'orgId',
    integrationId: 'integrationId',
    deviceId: 'deviceId',
    detectedAt: 'detectedAt',
    updatedAt: 'updatedAt'
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'organization',
      orgId: '11111111-1111-1111-1111-111111111111',
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111',
      user: { id: 'user-123', email: 'test@example.com' }
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (permissionGate.deny) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (mfaGate.deny) {
      return c.json({ error: 'MFA required' }, 403);
    }
    return next();
  })
}));

vi.mock('../jobs/s1Sync', () => ({
  isThreatAction: vi.fn(() => true),
  scheduleS1Sync: vi.fn()
}));

vi.mock('../services/sentinelOne/actions', () => ({
  executeS1IsolationForOrg: vi.fn(),
  executeS1ThreatActionForOrg: vi.fn(),
  getActiveS1IntegrationForOrg: vi.fn()
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('../services/secretCrypto', () => ({
  encryptSecret: vi.fn((value: string | undefined) => `enc:${value ?? ''}`)
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    ORGS_WRITE: { resource: 'organizations', action: 'write' },
    DEVICES_EXECUTE: { resource: 'devices', action: 'execute' }
  }
}));

import { sentinelOneRoutes } from './sentinelOne';
import { db } from '../db';
import {
  executeS1IsolationForOrg,
  executeS1ThreatActionForOrg,
  getActiveS1IntegrationForOrg
} from '../services/sentinelOne/actions';
import { encryptSecret } from '../services/secretCrypto';

describe('sentinel one routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    permissionGate.deny = false;
    mfaGate.deny = false;

    app = new Hono();
    app.route('/s1', sentinelOneRoutes);
  });

  it('rejects integration save when permission check fails', async () => {
    permissionGate.deny = true;

    const res = await app.request('/s1/integration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'SentinelOne Prod',
        managementUrl: 'https://example.sentinelone.net',
        apiToken: 'token'
      })
    });

    expect(res.status).toBe(403);
  });

  it('fails integration save when token encryption fails', async () => {
    vi.mocked(encryptSecret).mockReturnValueOnce(null);

    const res = await app.request('/s1/integration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'SentinelOne Prod',
        managementUrl: 'https://example.sentinelone.net',
        apiToken: 'token'
      })
    });

    expect(res.status).toBe(500);
  });

  it('rejects non-HTTPS management URLs', async () => {
    const res = await app.request('/s1/integration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'SentinelOne Prod',
        managementUrl: 'http://example.sentinelone.net',
        apiToken: 'token'
      })
    });

    expect(res.status).toBe(400);
  });

  it('requires token re-entry when changing the SentinelOne management host', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{
            id: 'integration-1',
            managementUrl: 'https://old.sentinelone.net',
            apiTokenEncrypted: 'enc:stored-token'
          }])
        }))
      }))
    } as any);

    const res = await app.request('/s1/integration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'SentinelOne Prod',
        managementUrl: 'https://new.sentinelone.net'
      })
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error)).toContain('re-entered');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects isolate action when MFA check fails', async () => {
    mfaGate.deny = true;

    const res = await app.request('/s1/isolate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceIds: ['11111111-1111-1111-1111-111111111111']
      })
    });

    expect(res.status).toBe(403);
  });

  it('rejects cross-org status access', async () => {
    const res = await app.request('/s1/status?orgId=22222222-2222-2222-2222-222222222222');
    expect(res.status).toBe(403);
  });

  it('returns warning when isolate dispatch has no provider activity id', async () => {
    vi.mocked(getActiveS1IntegrationForOrg).mockResolvedValueOnce({
      id: 'int-1',
      orgId: '11111111-1111-1111-1111-111111111111',
      name: 'S1',
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null
    } as any);
    vi.mocked(executeS1IsolationForOrg).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        requestedDeviceIds: ['11111111-1111-1111-1111-111111111111'],
        inaccessibleDeviceIds: [],
        unmappedAccessibleDeviceIds: [],
        requestedDevices: 1,
        mappedAgents: 1,
        providerActionId: null,
        actions: [{ id: 'action-1', deviceId: '11111111-1111-1111-1111-111111111111' }],
        warning: 'Provider did not return activityId; action cannot be tracked'
      }
    } as any);

    const res = await app.request('/s1/isolate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceIds: ['11111111-1111-1111-1111-111111111111']
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warnings).toEqual(['Provider did not return activityId; action cannot be tracked']);
    expect(body.data.providerActionId).toBeNull();
  });

  it('returns 502 with persisted action details when isolate dispatch fails', async () => {
    vi.mocked(getActiveS1IntegrationForOrg).mockResolvedValueOnce({
      id: 'int-1',
      orgId: '11111111-1111-1111-1111-111111111111',
      name: 'S1',
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null
    } as any);
    vi.mocked(executeS1IsolationForOrg).mockResolvedValueOnce({
      ok: true,
      status: 502,
      data: {
        requestedDeviceIds: ['11111111-1111-1111-1111-111111111111'],
        inaccessibleDeviceIds: [],
        unmappedAccessibleDeviceIds: [],
        requestedDevices: 1,
        mappedAgents: 1,
        providerActionId: null,
        actions: [{ id: 'action-err-1', deviceId: '11111111-1111-1111-1111-111111111111' }],
        warning: 'SentinelOne action dispatch failed: provider timeout'
      }
    } as any);

    const res = await app.request('/s1/isolate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceIds: ['11111111-1111-1111-1111-111111111111']
      })
    });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain('SentinelOne action dispatch failed');
    expect(body.data.actions).toHaveLength(1);
  });

  it('returns partial threat action results with unmatched threat ids', async () => {
    vi.mocked(getActiveS1IntegrationForOrg).mockResolvedValueOnce({
      id: 'int-1',
      orgId: '11111111-1111-1111-1111-111111111111',
      name: 'S1',
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null
    } as any);
    vi.mocked(executeS1ThreatActionForOrg).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        action: 'kill',
        requestedThreats: 2,
        matchedThreats: 1,
        matchedThreatIds: ['s1-threat-1'],
        unmatchedThreatIds: ['missing-threat'],
        providerActionId: 'activity-1',
        actions: [{ id: 'action-1', deviceId: 'device-1' }]
      }
    } as any);

    const res = await app.request('/s1/threat-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'kill',
        threatIds: ['s1-threat-1', 'missing-threat']
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.unmatchedThreatIds).toEqual(['missing-threat']);
    expect(body.data.matchedThreatIds).toEqual(['s1-threat-1']);
  });
});
