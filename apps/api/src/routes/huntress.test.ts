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
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: {
    id: 'id',
    hostname: 'hostname',
  },
  huntressIntegrations: {
    id: 'id',
    orgId: 'orgId',
    name: 'name',
    accountId: 'accountId',
    apiBaseUrl: 'apiBaseUrl',
    apiKeyEncrypted: 'apiKeyEncrypted',
    webhookSecretEncrypted: 'webhookSecretEncrypted',
    isActive: 'isActive',
    lastSyncAt: 'lastSyncAt',
    lastSyncStatus: 'lastSyncStatus',
    lastSyncError: 'lastSyncError',
    createdBy: 'createdBy',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
  huntressAgents: {
    integrationId: 'integrationId',
    deviceId: 'deviceId',
    status: 'status',
  },
  huntressIncidents: {
    id: 'id',
    orgId: 'orgId',
    integrationId: 'integrationId',
    deviceId: 'deviceId',
    huntressIncidentId: 'huntressIncidentId',
    severity: 'severity',
    category: 'category',
    title: 'title',
    description: 'description',
    recommendation: 'recommendation',
    status: 'status',
    reportedAt: 'reportedAt',
    resolvedAt: 'resolvedAt',
    details: 'details',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'organization',
      orgId: '11111111-1111-1111-1111-111111111111',
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111',
      orgCondition: vi.fn(() => undefined),
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

vi.mock('../jobs/huntressSync', () => ({
  scheduleHuntressSync: vi.fn(async () => 'job-1'),
  ingestHuntressWebhookPayload: vi.fn(async () => ({
    integrationId: 'integration-1',
    fetchedAgents: 0,
    fetchedIncidents: 0,
    upsertedAgents: 0,
    createdIncidents: 0,
    updatedIncidents: 0,
  })),
  findHuntressIntegrationByAccount: vi.fn(async () => ({ status: 'none' as const })),
}));

vi.mock('../services/secretCrypto', () => ({
  encryptSecret: vi.fn((value: string | undefined) => `enc:${value ?? ''}`),
  decryptSecret: vi.fn(() => 'webhook-secret'),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    ORGS_WRITE: { resource: 'organizations', action: 'write' }
  }
}));

import { db } from '../db';
import { findHuntressIntegrationByAccount } from '../jobs/huntressSync';
import { huntressRoutes } from './huntress';

describe('huntress routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    permissionGate.deny = false;
    mfaGate.deny = false;
    app = new Hono();
    app.route('/huntress', huntressRoutes);
  });

  it('rejects integration upsert when permission check fails', async () => {
    permissionGate.deny = true;
    const res = await app.request('/huntress/integration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Primary Huntress',
        apiKey: 'api-key',
      }),
    });

    expect(res.status).toBe(403);
  });

  it('rejects webhook payloads with missing signature when webhook secret is configured', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{
            id: 'integration-1',
            orgId: 'org-1',
            webhookSecretEncrypted: 'enc:webhook',
            isActive: true,
          }]),
        })),
      })),
    } as any);

    const res = await app.request('/huntress/webhook?integrationId=integration-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(String(body.error)).toContain('signature');
  });

  it('rejects webhook payloads with missing timestamp when signature auth is enabled', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{
            id: 'integration-1',
            orgId: 'org-1',
            webhookSecretEncrypted: 'enc:webhook',
            isActive: true,
          }]),
        })),
      })),
    } as any);

    const res = await app.request('/huntress/webhook?integrationId=integration-1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-huntress-signature': 'sha256=abc123',
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(String(body.error)).toContain('timestamp');
  });

  it('rejects webhook accountId routing when multiple integrations match', async () => {
    vi.mocked(findHuntressIntegrationByAccount).mockResolvedValueOnce({ status: 'ambiguous' });

    const res = await app.request('/huntress/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-huntress-account-id': 'acct-123',
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(String(body.error)).toContain('integrationId');
  });
});
