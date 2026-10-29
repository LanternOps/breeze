import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { redisState } = vi.hoisted(() => {
  // A minimal SET NX EX / DEL store standing in for Redis in the webhook replay guard.
  const store = new Map<string, string>();
  const client = {
    set: vi.fn(async (key: string, value: string, ..._args: unknown[]) => {
      if (store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  };
  return { redisState: { store, client, available: true } };
});

vi.mock('../services/redis', () => ({
  getRedis: vi.fn(() => (redisState.available ? redisState.client : null)),
}));

const { permissionGate, mfaGate, permsState, authState } = vi.hoisted(() => ({
  permissionGate: { deny: false },
  mfaGate: { deny: false },
  permsState: { permissions: undefined as { allowedSiteIds?: string[] } | undefined },
  authState: {
    scope: 'organization' as 'organization' | 'partner' | 'system',
    orgId: '11111111-1111-1111-1111-111111111111' as string | null,
    partnerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as string | null,
    partnerOrgAccess: null as 'all' | 'selected' | 'none' | null,
    accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'] as string[],
  },
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
  organizations: { id: 'id', partnerId: 'partnerId', type: 'type' },
  devices: {
    id: 'id',
    hostname: 'hostname',
    orgId: 'orgId',
    siteId: 'siteId',
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
    lastSyncAgents: 'lastSyncAgents',
    lastSyncIncidents: 'lastSyncIncidents',
    lastSyncOrgs: 'lastSyncOrgs',
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
      scope: authState.scope,
      orgId: authState.orgId,
      partnerId: authState.partnerId,
      partnerOrgAccess: authState.partnerOrgAccess,
      accessibleOrgIds: authState.accessibleOrgIds,
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111',
      orgCondition: vi.fn(() => undefined),
      user: { id: 'user-123', email: 'test@example.com' }
    });
    // NOTE: authMiddleware does NOT populate `permissions` in production — only
    // requirePermission does (auth.ts). Setting it here would mask routes that
    // rely on `c.get('permissions')` for site-scoping but lack a requirePermission
    // gate. Keep this faithful to prod so such gaps fail their site-scope tests.
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (permissionGate.deny) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    // Mirror prod: requirePermission is the gate that populates `permissions`.
    c.set('permissions', permsState.permissions);
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
    integrationId: '33333333-3333-4333-8333-333333333333',
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
  decryptForColumn: vi.fn(() => 'webhook-secret'),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    ORGS_WRITE: { resource: 'organizations', action: 'write' },
    DEVICES_READ: { resource: 'devices', action: 'read' }
  },
  canAccessSite: (perms: { allowedSiteIds?: string[] } | undefined, siteId: string) =>
    !perms?.allowedSiteIds || perms.allowedSiteIds.includes(siteId),
}));

import { createHmac } from 'node:crypto';
import { db } from '../db';
import { findHuntressIntegrationByAccount, ingestHuntressWebhookPayload } from '../jobs/huntressSync';
import { decryptForColumn } from '../services/secretCrypto';
import { buildHuntressWebhookSignature } from '../services/huntressClient';
import { huntressRoutes } from './huntress';

const WEBHOOK_INTEGRATION_ID = '33333333-3333-4333-8333-333333333333';
const SW_KEY = Buffer.from('huntress-standard-webhooks-key-32');
const SW_SECRET = `whsec_${SW_KEY.toString('base64')}`;
const TEST_EVENT_BODY = '{"event_type":"test.event","message":"Hello World"}';

function mockWebhookIntegrationRow() {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => [{
          id: WEBHOOK_INTEGRATION_ID,
          partnerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          accountId: 'acct-123',
          webhookSecretEncrypted: 'enc:webhook',
          isActive: true,
        }]),
      })),
    })),
  } as any);
}

/** Standard Webhooks (Svix) headers, signed the way Huntress signs a delivery. */
function standardWebhookHeaders(body: string, key: Buffer = SW_KEY): {
  'content-type': string;
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
} {
  const id = 'msg_2pHuntressDelivery';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${signature}`,
  };
}

describe('huntress routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    redisState.store.clear();
    redisState.available = true;
    permissionGate.deny = false;
    mfaGate.deny = false;
    permsState.permissions = undefined;
    authState.scope = 'organization';
    authState.orgId = '11111111-1111-1111-1111-111111111111';
    authState.partnerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    authState.partnerOrgAccess = null;
    authState.accessibleOrgIds = ['11111111-1111-1111-1111-111111111111'];
    app = new Hono();
    app.route('/huntress', huntressRoutes);
  });

  it.each([
    ['GET', '/huntress/integration', undefined],
    ['POST', '/huntress/integration', { name: 'Primary Huntress', apiKey: 'secret' }],
    ['POST', '/huntress/sync', {}],
    ['GET', '/huntress/organizations', undefined],
    ['POST', '/huntress/organizations/map', {
      integrationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      huntressOrgId: 'huntress-org-1',
      orgId: null,
    }],
  ])('rejects selected-org partner access before shared integration work: %s %s', async (method, path, body) => {
    authState.scope = 'partner';
    authState.orgId = null;
    authState.partnerOrgAccess = 'selected';

    const res = await app.request(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('refuses to map a Huntress organization onto a holding org, even for system scope', async () => {
    authState.scope = 'system';
    authState.orgId = null;
    authState.partnerId = null as any;
    const HOLDING = '11111111-1111-1111-1111-111111111111';
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', partnerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }]) })) })),
    } as any);
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => [{ id: HOLDING, partnerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', type: 'unassigned_pool' }]) })) })),
    } as any);

    const res = await app.request('/huntress/organizations/map', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ integrationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', huntressOrgId: 'huntress-org-1', orgId: HOLDING }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ORG_PROTECTED');
    expect(db.update).not.toHaveBeenCalled();
  });

  describe('GET /status partner-wide authority', () => {
    it.each(['selected', 'none'] as const)(
      'rejects partner org access %s before partner-global reads',
      async (orgAccess) => {
        authState.scope = 'partner';
        authState.orgId = null;
        authState.partnerOrgAccess = orgAccess;

        const res = await app.request('/huntress/status');

        expect(res.status).toBe(403);
        expect(db.select).not.toHaveBeenCalled();
      },
    );

    it('allows a full-partner caller to read status', async () => {
      authState.scope = 'partner';
      authState.orgId = null;
      authState.partnerOrgAccess = 'all';
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => []),
          })),
        })),
      } as any);

      const res = await app.request('/huntress/status');

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        integration: null,
        coverage: { totalAgents: 0 },
        incidents: { open: 0 },
      });
      expect(db.select).toHaveBeenCalledOnce();
    });
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
	            id: '33333333-3333-4333-8333-333333333333',
	            orgId: 'org-1',
	            accountId: 'acct-123',
	            webhookSecretEncrypted: 'enc:webhook',
	            isActive: true,
	          }]),
        })),
      })),
    } as any);

    const res = await app.request('/huntress/webhook?integrationId=33333333-3333-4333-8333-333333333333', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(String(body.error)).toContain('signature');
  });

  it('treats a non-UUID integration header as absent and returns the no-integration response', async () => {
    const res = await app.request('/huntress/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-huntress-integration-id': 'abc',
        'x-huntress-account-id': 'acct-123',
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'No active Huntress integration found for webhook payload',
    });
    expect(db.select).not.toHaveBeenCalled();
    expect(findHuntressIntegrationByAccount).toHaveBeenCalledWith('acct-123');
  });

  it('rejects webhook payloads with missing timestamp when signature auth is enabled', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{
	            id: '33333333-3333-4333-8333-333333333333',
	            orgId: 'org-1',
	            accountId: 'acct-123',
	            webhookSecretEncrypted: 'enc:webhook',
	            isActive: true,
	          }]),
        })),
      })),
    } as any);

    const res = await app.request('/huntress/webhook?integrationId=33333333-3333-4333-8333-333333333333', {
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

  it('rejects explicit integrationId when the payload accountId belongs to another Huntress account', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{
            id: '33333333-3333-4333-8333-333333333333',
            orgId: 'org-1',
            accountId: 'acct-stored',
            webhookSecretEncrypted: 'enc:webhook',
            isActive: true,
          }]),
        })),
      })),
    } as any);

    const res = await app.request('/huntress/webhook?integrationId=33333333-3333-4333-8333-333333333333', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-huntress-account-id': 'acct-other',
      },
      body: JSON.stringify({ accountId: 'acct-other' }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(String(body.error)).toContain('account');
  });

  describe('POST /webhook Standard Webhooks deliveries (#10335)', () => {
    const INCIDENT_BODY = JSON.stringify({
      incident_reports: [{ id: 101, subject: 'Suspicious process', severity: 'high', sent_at: '2026-10-28T18:00:00Z' }],
    });

    it('accepts a Standard Webhooks-signed delivery and ingests it', async () => {
      mockWebhookIntegrationRow();
      vi.mocked(decryptForColumn).mockReturnValueOnce(SW_SECRET);

      const res = await app.request(`/huntress/webhook?integrationId=${WEBHOOK_INTEGRATION_ID}`, {
        method: 'POST',
        headers: standardWebhookHeaders(INCIDENT_BODY),
        body: INCIDENT_BODY,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ accepted: true, integrationId: WEBHOOK_INTEGRATION_ID });
      expect(ingestHuntressWebhookPayload).toHaveBeenCalledWith({
        integrationId: WEBHOOK_INTEGRATION_ID,
        payload: JSON.parse(INCIDENT_BODY),
      });
    });

    it('accepts the svix-* header spellings at the route', async () => {
      mockWebhookIntegrationRow();
      vi.mocked(decryptForColumn).mockReturnValueOnce(SW_SECRET);
      const std = standardWebhookHeaders(INCIDENT_BODY);

      const res = await app.request(`/huntress/webhook?integrationId=${WEBHOOK_INTEGRATION_ID}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'svix-id': std['webhook-id'],
          'svix-timestamp': std['webhook-timestamp'],
          'svix-signature': std['webhook-signature'],
        },
        body: INCIDENT_BODY,
      });

      expect(res.status).toBe(200);
      expect(ingestHuntressWebhookPayload).toHaveBeenCalledTimes(1);
    });

    it('rejects a Standard Webhooks delivery signed with another secret and logs why, without the secret', async () => {
      mockWebhookIntegrationRow();
      vi.mocked(decryptForColumn).mockReturnValueOnce(SW_SECRET);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const res = await app.request(`/huntress/webhook?integrationId=${WEBHOOK_INTEGRATION_ID}`, {
          method: 'POST',
          headers: standardWebhookHeaders(INCIDENT_BODY, Buffer.from('some-other-thirty-two-byte-key!!')),
          body: INCIDENT_BODY,
        });

        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'Invalid Huntress webhook signature' });
        expect(ingestHuntressWebhookPayload).not.toHaveBeenCalled();

        const rejected = warn.mock.calls.map((args) => args.map(String).join(' '))
          .filter((line) => line.includes('signature rejected'));
        expect(rejected).toHaveLength(1);
        expect(rejected[0]).toContain(WEBHOOK_INTEGRATION_ID);
        expect(rejected[0]).toContain('standard-webhooks');
        expect(rejected[0]).toContain('Invalid Huntress webhook signature');
        expect(rejected[0]).toContain('whsec_-prefixed');
        expect(rejected[0]).not.toContain(SW_SECRET);
        expect(rejected[0]).not.toContain(SW_KEY.toString('base64'));
      } finally {
        warn.mockRestore();
      }
    });

    it('notes in the rejection log when the stored secret has no whsec_ prefix', async () => {
      mockWebhookIntegrationRow();
      // decryptForColumn's default mock returns the unprefixed 'webhook-secret'.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const res = await app.request(`/huntress/webhook?integrationId=${WEBHOOK_INTEGRATION_ID}`, {
          method: 'POST',
          headers: standardWebhookHeaders(INCIDENT_BODY),
          body: INCIDENT_BODY,
        });

        expect(res.status).toBe(401);
        const rejected = warn.mock.calls.map((args) => args.map(String).join(' '))
          .filter((line) => line.includes('signature rejected'));
        expect(rejected).toHaveLength(1);
        expect(rejected[0]).toContain('no whsec_ prefix');
        expect(rejected[0]).not.toContain('webhook-secret');
      } finally {
        warn.mockRestore();
      }
    });

    it('answers a test.event with 403 when the integration has no webhook secret', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [{
              id: WEBHOOK_INTEGRATION_ID,
              partnerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              accountId: 'acct-123',
              webhookSecretEncrypted: null,
              isActive: true,
            }]),
          })),
        })),
      } as any);

      const res = await app.request(`/huntress/webhook?integrationId=${WEBHOOK_INTEGRATION_ID}`, {
        method: 'POST',
        headers: { ...standardWebhookHeaders(TEST_EVENT_BODY), 'webhook-test': 'true' },
        body: TEST_EVENT_BODY,
      });

      expect(res.status).toBe(403);
      expect(ingestHuntressWebhookPayload).not.toHaveBeenCalled();
    });

    it('returns 200 for a signed Huntress Send Test without parsing it as incident data', async () => {
      mockWebhookIntegrationRow();
      vi.mocked(decryptForColumn).mockReturnValueOnce(SW_SECRET);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const res = await app.request(`/huntress/webhook?integrationId=${WEBHOOK_INTEGRATION_ID}`, {
          method: 'POST',
          headers: { ...standardWebhookHeaders(TEST_EVENT_BODY), 'webhook-test': 'true' },
          body: TEST_EVENT_BODY,
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ accepted: true, test: true, integrationId: WEBHOOK_INTEGRATION_ID });
        expect(ingestHuntressWebhookPayload).not.toHaveBeenCalled();
        const warned = warn.mock.calls.map((args) => String(args[0]));
        expect(warned.filter((line) => line.includes('Could not extract array'))).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });

    it('short-circuits event_type test.event even without the webhook-test header', async () => {
      mockWebhookIntegrationRow();
      vi.mocked(decryptForColumn).mockReturnValueOnce(SW_SECRET);

      const res = await app.request(`/huntress/webhook?integrationId=${WEBHOOK_INTEGRATION_ID}`, {
        method: 'POST',
        headers: standardWebhookHeaders(TEST_EVENT_BODY),
        body: TEST_EVENT_BODY,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ accepted: true, test: true, integrationId: WEBHOOK_INTEGRATION_ID });
      expect(ingestHuntressWebhookPayload).not.toHaveBeenCalled();
    });

    // `webhook-test` is outside the signature, so it must not be able to turn
    // a genuine signed event into a silently dropped "test".
    it('still ingests a real signed event that carries an unsigned webhook-test: true header', async () => {
      mockWebhookIntegrationRow();
      vi.mocked(decryptForColumn).mockReturnValueOnce(SW_SECRET);

      const res = await app.request(`/huntress/webhook?integrationId=${WEBHOOK_INTEGRATION_ID}`, {
        method: 'POST',
        headers: { ...standardWebhookHeaders(INCIDENT_BODY), 'webhook-test': 'true' },
        body: INCIDENT_BODY,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ accepted: true, integrationId: WEBHOOK_INTEGRATION_ID });
      expect(body.test).toBeUndefined();
      expect(ingestHuntressWebhookPayload).toHaveBeenCalledWith({
        integrationId: WEBHOOK_INTEGRATION_ID,
        payload: JSON.parse(INCIDENT_BODY),
      });
    });

    describe('webhook-id replay reservation', () => {
      const MSG_KEY = `huntress:webhook:${WEBHOOK_INTEGRATION_ID}:msg_2pHuntressDelivery`;

      async function deliver(headers: Record<string, string>) {
        mockWebhookIntegrationRow();
        vi.mocked(decryptForColumn).mockReturnValueOnce(SW_SECRET);
        return app.request(`/huntress/webhook?integrationId=${WEBHOOK_INTEGRATION_ID}`, {
          method: 'POST',
          headers,
          body: INCIDENT_BODY,
        });
      }

      it('ingests the first delivery and reserves its webhook-id with NX and a TTL past the replay window', async () => {
        const res = await deliver(standardWebhookHeaders(INCIDENT_BODY));

        expect(res.status).toBe(200);
        expect(ingestHuntressWebhookPayload).toHaveBeenCalledTimes(1);
        expect(redisState.client.set).toHaveBeenCalledTimes(1);
        const [key, , ex, ttl, nx] = redisState.client.set.mock.calls[0]!;
        expect(key).toBe(MSG_KEY);
        expect(ex).toBe('EX');
        expect(Number(ttl)).toBeGreaterThanOrEqual(600);
        expect(nx).toBe('NX');
        expect(redisState.store.has(MSG_KEY)).toBe(true);
      });

      it('answers a redelivery of the same webhook-id with 2xx and does not ingest it again', async () => {
        const headers = standardWebhookHeaders(INCIDENT_BODY);
        const first = await deliver(headers);
        expect(first.status).toBe(200);

        const second = await deliver(headers);
        expect(second.status).toBe(200);
        expect(await second.json()).toEqual({ accepted: true, duplicate: true, integrationId: WEBHOOK_INTEGRATION_ID });
        expect(ingestHuntressWebhookPayload).toHaveBeenCalledTimes(1);
      });

      it('releases the reservation when ingestion fails, so the retry is accepted', async () => {
        const headers = standardWebhookHeaders(INCIDENT_BODY);
        vi.mocked(ingestHuntressWebhookPayload).mockRejectedValueOnce(new Error('db blip'));
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
          const failed = await deliver(headers);
          expect(failed.status).toBe(500);
          expect(redisState.client.del).toHaveBeenCalledWith(MSG_KEY);
          expect(redisState.store.has(MSG_KEY)).toBe(false);
        } finally {
          error.mockRestore();
        }

        const retried = await deliver(headers);
        expect(retried.status).toBe(200);
        expect(await retried.json()).toMatchObject({ accepted: true, integrationId: WEBHOOK_INTEGRATION_ID });
        expect(ingestHuntressWebhookPayload).toHaveBeenCalledTimes(2);
        expect(redisState.store.has(MSG_KEY)).toBe(true);
      });

      // Same choice as the Resend receiver: without the guard a redelivery
      // would be processed twice, so fail closed and let Svix retry.
      it('answers 503 and does not ingest when Redis is unavailable', async () => {
        redisState.available = false;
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
          const res = await deliver(standardWebhookHeaders(INCIDENT_BODY));
          expect(res.status).toBe(503);
          expect(ingestHuntressWebhookPayload).not.toHaveBeenCalled();
        } finally {
          error.mockRestore();
        }
      });

      it('answers 503 and does not ingest when the reservation itself fails', async () => {
        redisState.client.set.mockRejectedValueOnce(new Error('ECONNRESET'));
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
          const res = await deliver(standardWebhookHeaders(INCIDENT_BODY));
          expect(res.status).toBe(503);
          expect(ingestHuntressWebhookPayload).not.toHaveBeenCalled();
        } finally {
          error.mockRestore();
        }
      });

      it('does not reserve anything for an unverified delivery', async () => {
        const res = await deliver(standardWebhookHeaders(INCIDENT_BODY, Buffer.from('some-other-thirty-two-byte-key!!')));
        expect(res.status).toBe(401);
        expect(redisState.client.set).not.toHaveBeenCalled();
      });

      it('acknowledges a signed test.event without needing Redis', async () => {
        redisState.available = false;
        mockWebhookIntegrationRow();
        vi.mocked(decryptForColumn).mockReturnValueOnce(SW_SECRET);

        const res = await app.request(`/huntress/webhook?integrationId=${WEBHOOK_INTEGRATION_ID}`, {
          method: 'POST',
          headers: standardWebhookHeaders(TEST_EVENT_BODY),
          body: TEST_EVENT_BODY,
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ accepted: true, test: true, integrationId: WEBHOOK_INTEGRATION_ID });
      });

      it('leaves the legacy x-huntress-signature path without a reservation (it carries no message id)', async () => {
        mockWebhookIntegrationRow();
        const timestamp = String(Math.floor(Date.now() / 1000));

        const res = await app.request(`/huntress/webhook?integrationId=${WEBHOOK_INTEGRATION_ID}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-huntress-signature': buildHuntressWebhookSignature('webhook-secret', INCIDENT_BODY, timestamp),
            'x-huntress-timestamp': timestamp,
          },
          body: INCIDENT_BODY,
        });

        expect(res.status).toBe(200);
        expect(ingestHuntressWebhookPayload).toHaveBeenCalledTimes(1);
        expect(redisState.client.set).not.toHaveBeenCalled();
      });
    });

    // The short-circuit sits AFTER verification: an unsigned test event is still a 401.
    it('rejects a test.event whose signature does not verify', async () => {
      mockWebhookIntegrationRow();
      vi.mocked(decryptForColumn).mockReturnValueOnce(SW_SECRET);

      const res = await app.request(`/huntress/webhook?integrationId=${WEBHOOK_INTEGRATION_ID}`, {
        method: 'POST',
        headers: {
          ...standardWebhookHeaders(TEST_EVENT_BODY, Buffer.from('some-other-thirty-two-byte-key!!')),
          'webhook-test': 'true',
        },
        body: TEST_EVENT_BODY,
      });

      expect(res.status).toBe(401);
      expect(ingestHuntressWebhookPayload).not.toHaveBeenCalled();
    });

    it('acknowledges a legacy-signed test.event without ingesting it', async () => {
      mockWebhookIntegrationRow();
      const timestamp = String(Math.floor(Date.now() / 1000));

      const res = await app.request(`/huntress/webhook?integrationId=${WEBHOOK_INTEGRATION_ID}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // decryptForColumn's default mock returns 'webhook-secret'.
          'x-huntress-signature': buildHuntressWebhookSignature('webhook-secret', TEST_EVENT_BODY, timestamp),
          'x-huntress-timestamp': timestamp,
        },
        body: TEST_EVENT_BODY,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ accepted: true, test: true, integrationId: WEBHOOK_INTEGRATION_ID });
      expect(ingestHuntressWebhookPayload).not.toHaveBeenCalled();
    });

    it('still accepts a legacy x-huntress-signature delivery', async () => {
      mockWebhookIntegrationRow();
      const timestamp = String(Math.floor(Date.now() / 1000));

      const res = await app.request(`/huntress/webhook?integrationId=${WEBHOOK_INTEGRATION_ID}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // decryptForColumn's default mock returns 'webhook-secret'.
          'x-huntress-signature': buildHuntressWebhookSignature('webhook-secret', INCIDENT_BODY, timestamp),
          'x-huntress-timestamp': timestamp,
        },
        body: INCIDENT_BODY,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ accepted: true, integrationId: WEBHOOK_INTEGRATION_ID });
      expect(ingestHuntressWebhookPayload).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET /incidents site-scope narrowing', () => {
    const ALLOWED_SITE = 'site-allowed';
    const FOREIGN_SITE = 'site-foreign';
    const ALLOWED_DEVICE = '22222222-2222-2222-2222-222222222222';
    const FOREIGN_DEVICE = '33333333-3333-3333-3333-333333333333';

    // Mock the device-resolution select (runs first when site-restricted),
    // returning all org devices with their siteId for the narrowing filter.
    function mockDeviceResolution() {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(async () => [
            { id: ALLOWED_DEVICE, siteId: ALLOWED_SITE },
            { id: FOREIGN_DEVICE, siteId: FOREIGN_SITE },
          ]),
        })),
      } as any);
    }

    // Capture the where clause passed to the main incidents query so we can
    // assert how the route narrowed, and return a fixed result set.
    function mockIncidentQuery(captured: { where?: unknown }, rows: unknown[]) {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            where: vi.fn((w: unknown) => {
              captured.where = w;
              return {
                orderBy: vi.fn(() => ({
                  limit: vi.fn(() => ({
                    offset: vi.fn(async () => rows),
                  })),
                })),
              };
            }),
          })),
        })),
      } as any);
      // Count query
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(async () => [{ count: rows.length }]),
        })),
      } as any);
    }

    it('returns 403 when a site-restricted caller requests a deviceId outside their allowed sites', async () => {
      permsState.permissions = { allowedSiteIds: [ALLOWED_SITE] };
      mockDeviceResolution();

      const res = await app.request(`/huntress/incidents?deviceId=${FOREIGN_DEVICE}`);

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(String(body.error)).toContain('access denied');
    });

    it('allows a site-restricted caller to request a deviceId within their allowed sites', async () => {
      permsState.permissions = { allowedSiteIds: [ALLOWED_SITE] };
      mockDeviceResolution();
      const captured: { where?: unknown } = {};
      mockIncidentQuery(captured, [
        { id: 'inc-1', deviceId: ALLOWED_DEVICE, title: 'allowed' },
      ]);

      const res = await app.request(`/huntress/incidents?deviceId=${ALLOWED_DEVICE}`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });

    it('narrows results to allowed devices + provider-level (null-device) incidents for restricted callers', async () => {
      permsState.permissions = { allowedSiteIds: [ALLOWED_SITE] };
      mockDeviceResolution();
      const captured: { where?: unknown } = {};
      // The DB-level narrowing is asserted via the where clause; here we just
      // confirm the route issues the query and returns rows successfully.
      mockIncidentQuery(captured, [
        { id: 'inc-allowed', deviceId: ALLOWED_DEVICE, title: 'allowed-device' },
        { id: 'inc-provider', deviceId: null, title: 'provider-level' },
      ]);

      const res = await app.request('/huntress/incidents');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      // A narrowing condition must have been applied to the main query.
      expect(captured.where).toBeDefined();
    });

    it('still narrows (allowing only null-device incidents) when the caller has no allowed devices', async () => {
      permsState.permissions = { allowedSiteIds: ['site-with-no-devices'] };
      // No org devices match the allowlist.
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(async () => [
            { id: ALLOWED_DEVICE, siteId: ALLOWED_SITE },
            { id: FOREIGN_DEVICE, siteId: FOREIGN_SITE },
          ]),
        })),
      } as any);
      const captured: { where?: unknown } = {};
      mockIncidentQuery(captured, [
        { id: 'inc-provider', deviceId: null, title: 'provider-level' },
      ]);

      const res = await app.request('/huntress/incidents');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(captured.where).toBeDefined();
    });

    it('does not narrow for unrestricted callers (no device-resolution query issued)', async () => {
      permsState.permissions = undefined; // unrestricted
      const captured: { where?: unknown } = {};
      // Only the main query + count query should be issued (no device resolution).
      mockIncidentQuery(captured, [
        { id: 'inc-1', deviceId: FOREIGN_DEVICE, title: 'foreign-device' },
        { id: 'inc-2', deviceId: null, title: 'provider-level' },
      ]);

      const res = await app.request('/huntress/incidents');

      expect(res.status).toBe(200);
      const body = await res.json();
      // Unrestricted: foreign-device rows remain visible.
      expect(body.data).toHaveLength(2);
      // db.select called exactly twice (main + count), proving no device-resolution query.
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2);
    });
  });
});
