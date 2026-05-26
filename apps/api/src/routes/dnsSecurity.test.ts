import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { permissionGate, mfaGate } = vi.hoisted(() => ({
  permissionGate: { deny: false },
  mfaGate: { deny: false }
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({
  devices: {},
  dnsActionEnum: { enumValues: ['allowed', 'blocked'] },
  dnsEventAggregations: {},
  dnsFilterIntegrations: {
    id: 'id',
    orgId: 'orgId',
    provider: 'provider',
    name: 'name',
    description: 'description',
    apiKey: 'apiKey',
    apiSecret: 'apiSecret',
    config: 'config',
    isActive: 'isActive',
    lastSync: 'lastSync',
    lastSyncStatus: 'lastSyncStatus',
    lastSyncError: 'lastSyncError',
    totalEventsProcessed: 'totalEventsProcessed',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
    createdBy: 'createdBy'
  },
  dnsPolicies: {},
  dnsProviderEnum: { enumValues: ['umbrella', 'cloudflare', 'pihole', 'adguard_home'] },
  dnsSecurityEvents: {},
  dnsThreatCategoryEnum: { enumValues: ['malware', 'phishing'] }
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

vi.mock('../jobs/dnsSyncJob', () => ({
  scheduleDnsEventSync: vi.fn(),
  schedulePolicySync: vi.fn()
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('../services/secretCrypto', () => ({
  encryptSecret: vi.fn((value: string | undefined) => `enc:${value ?? ''}`)
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    ORGS_WRITE: { resource: 'organizations', action: 'write' }
  }
}));

import { dnsSecurityRoutes } from './dnsSecurity';

describe('dns security routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    permissionGate.deny = false;
    mfaGate.deny = false;

    app = new Hono();
    app.route('/dns-security', dnsSecurityRoutes);
  });

  it('rejects integration creation when permission check fails', async () => {
    permissionGate.deny = true;

    const res = await app.request('/dns-security/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'cloudflare',
        name: 'Cloudflare DNS',
        apiKey: 'api-key-123',
        config: { accountId: 'acct-123' }
      })
    });

    expect(res.status).toBe(403);
  });

  it('rejects integration creation when MFA check fails', async () => {
    mfaGate.deny = true;

    const res = await app.request('/dns-security/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'cloudflare',
        name: 'Cloudflare DNS',
        apiKey: 'api-key-123',
        config: { accountId: 'acct-123' }
      })
    });

    expect(res.status).toBe(403);
  });

  it('rejects pihole apiEndpoint pointing at cloud-metadata (SSRF)', async () => {
    const res = await app.request('/dns-security/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'pihole',
        name: 'Pi-hole',
        apiKey: 'api-key-123',
        config: { apiEndpoint: 'http://169.254.169.254/admin' }
      })
    });

    expect(res.status).toBe(400);
  });

  it('rejects adguard_home apiEndpoint pointing at loopback (SSRF)', async () => {
    const res = await app.request('/dns-security/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'adguard_home',
        name: 'AdGuard Home',
        apiKey: 'admin',
        apiSecret: 'pw',
        config: { apiEndpoint: 'http://127.0.0.1:3000' }
      })
    });

    expect(res.status).toBe(400);
  });

  it('rejects cloudflare apiEndpoint pointing off the cloudflare.com allowlist (SSRF)', async () => {
    const res = await app.request('/dns-security/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'cloudflare',
        name: 'Cloudflare DNS',
        apiKey: 'api-key-123',
        config: { accountId: 'acct-123', apiEndpoint: 'https://internal-vault.cluster.local/' }
      })
    });

    expect(res.status).toBe(400);
  });

  it('accepts pihole apiEndpoint on RFC1918 (legitimate on-prem)', async () => {
    // We don't expect this to succeed end-to-end (the DB insert isn't mocked
    // here) — just that validation doesn't reject the URL as SSRF.
    const res = await app.request('/dns-security/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'pihole',
        name: 'Pi-hole',
        apiKey: 'api-key-123',
        config: { apiEndpoint: 'http://192.168.1.50' }
      })
    });

    // Anything other than 400 means the URL passed validation. The downstream
    // DB layer isn't mocked, so a 500 is also acceptable here — the assertion
    // is that we didn't reject at validation time.
    expect(res.status).not.toBe(400);
  });
});
