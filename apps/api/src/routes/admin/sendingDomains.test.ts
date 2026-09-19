import { findProviderImports } from '../../services/emailDomains/providerImportScan';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  mfaAllowed: { value: true },
  requireMfa: vi.fn(() => async (c: any, next: any) => (
    mocks.mfaAllowed.value ? next() : c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403)
  )),
  audit: vi.fn(),
  listAll: vi.fn(),
  listAllWithMetrics: vi.fn(),
  suspend: vi.fn(),
  unsuspend: vi.fn(),
  forceRelease: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({ requireMfa: mocks.requireMfa }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: mocks.audit }));
vi.mock('../../services/emailDomains/sendingDomainService', () => {
  class SendingDomainServiceError extends Error {
    constructor(public code: string, message: string, public status: number) { super(message); }
  }
  return {
    SendingDomainServiceError,
    listAllSendingDomains: mocks.listAll,
    listAllSendingDomainsWithMetrics: mocks.listAllWithMetrics,
    suspendSendingDomain: mocks.suspend,
    unsuspendSendingDomain: mocks.unsuspend,
    forceReleaseSendingDomain: mocks.forceRelease,
  };
});

import { SendingDomainServiceError } from '../../services/emailDomains/sendingDomainService';
import { adminSendingDomainsRoutes } from './sendingDomains';

const DOMAIN_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_ID = '55555555-5555-4555-8555-555555555555';
const registeredMfaCount = mocks.requireMfa.mock.calls.length;

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', { scope: 'system', partnerId: null, user: { id: ADMIN_ID, email: 'admin@lanternops.test' } } as never);
    await next();
  });
  app.route('/admin/sending-domains', adminSendingDomainsRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mfaAllowed.value = true;
  mocks.listAll.mockResolvedValue([]);
  mocks.listAllWithMetrics.mockResolvedValue([]);
});

describe('admin sending domains', () => {
  it('registers MFA on every mutating route (three of them)', () => {
    expect(registeredMfaCount).toBe(3);
  });

  it('does NOT apply platformAdminMiddleware itself — the hub owns that gate', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(__dirname, 'sendingDomains.ts'), 'utf8');
    expect(src).not.toContain('platformAdminMiddleware');
    const hub = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8');
    expect(hub).toContain("adminRoutes.use('*', platformAdminMiddleware)");
  });

  it('lists across partners with the partner name attached', async () => {
    mocks.listAllWithMetrics.mockResolvedValue([{ id: DOMAIN_ID, domain: 'mail.acme.test', partnerId: 'p1', partnerName: 'Acme MSP' }]);
    const res = await buildApp().request('/admin/sending-domains');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: [{ partnerName: 'Acme MSP' }] });
  });

  it('lists across partners with the 7-day metrics attached', async () => {
    mocks.listAllWithMetrics.mockResolvedValue([{
      id: DOMAIN_ID, partnerId: 'p1', partnerName: 'Acme MSP', domain: 'mail.acme.test',
      provider: 'resend', status: 'verified', statusReason: null, dnsRecords: [],
      verifiedAt: null, lastCheckedAt: null, lastTestAt: null, lastTestStatus: null,
      lastTestError: null, lastSendError: null, lastSendErrorAt: null,
      providerManaged: true, createdAt: '2026-08-01T00:00:00.000Z',
      metrics: { windowDays: 7, messages: 100, delivered: 90, bounced: 8, complained: 1, failed: 2, suppressed: 0, bounceRate: 0.08 },
    }]);
    const res = await buildApp().request('/admin/sending-domains');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ metrics: { bounceRate: number } }> };
    expect(body.data[0]!.metrics.bounceRate).toBeCloseTo(0.08, 5);
  });

  it('caps the list size rather than trusting the query string', async () => {
    await buildApp().request('/admin/sending-domains?limit=100000');
    expect(mocks.listAllWithMetrics).toHaveBeenCalledWith({ limit: expect.any(Number) });
    expect(mocks.listAllWithMetrics.mock.calls[0]![0].limit).toBeLessThanOrEqual(200);
  });

  it.each([
    ['suspend', 'suspend', 'partner_sending_domain.admin_suspend'],
    ['unsuspend', 'unsuspend', 'partner_sending_domain.admin_unsuspend'],
    ['force-release', 'forceRelease', 'partner_sending_domain.admin_force_release'],
  ] as const)('POST /:id/%s calls the service and audits', async (path, fn, action) => {
    (mocks as Record<string, any>)[fn].mockResolvedValue(undefined);
    const res = await buildApp().request(`/admin/sending-domains/${DOMAIN_ID}/${path}`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((mocks as Record<string, any>)[fn]).toHaveBeenCalledWith(DOMAIN_ID);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action, resourceId: DOMAIN_ID }));
  });

  it('the admin route suspends with the default platform_suspended reason', async () => {
    mocks.suspend.mockResolvedValue(undefined);
    const res = await buildApp().request(`/admin/sending-domains/${DOMAIN_ID}/suspend`, { method: 'POST' });
    expect(res.status).toBe(200);
    // One argument: the route must not start passing abuse_auto.
    expect(mocks.suspend).toHaveBeenCalledWith(DOMAIN_ID);
  });

  it('403s a mutation without MFA', async () => {
    mocks.mfaAllowed.value = false;
    const res = await buildApp().request(`/admin/sending-domains/${DOMAIN_ID}/suspend`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(mocks.suspend).not.toHaveBeenCalled();
  });

  it('404s an unknown domain and writes no audit row', async () => {
    mocks.suspend.mockRejectedValue(new SendingDomainServiceError('not_found', 'Sending domain not found.', 404));
    const res = await buildApp().request(`/admin/sending-domains/${DOMAIN_ID}/suspend`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('does not import providerRegistry or any adapter, in any import form', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const routePath = path.join(__dirname, 'sendingDomains.ts');
    const source = fs.readFileSync(routePath, 'utf8');
    expect(findProviderImports({ path: routePath, source })).toEqual([]);
  });

  const PLANTED = {
    'single-line static': `import { getEmailDomainProvider } from '../services/emailDomains/providerRegistry';`,
    // The form the old single-line `^import .* from` anchor silently missed.
    'multi-line static': [
      'import {',
      '  getEmailDomainProvider,',
      "} from '../services/emailDomains/providerRegistry';",
    ].join('\n'),
    'adapter import': `import { createResendDomainProvider } from '../services/emailDomains/adapters/resend';`,
    'dynamic import': `const p = await import('../services/emailDomains/providerRegistry');`,
    'require': `const p = require('../services/emailDomains/providerRegistry');`,
  };

  // CONTROL — see partnerSendingDomains.test.ts. A guard that cannot fail is
  // indistinguishable from a file that passes it.
  it.each(Object.entries(PLANTED))('flags a planted violation: %s', (_label, snippet) => {
    const source = `import { Hono } from 'hono';\n${snippet}\nexport const routes = new Hono();\n`;
    expect(findProviderImports({ path: 'planted.ts', source })).not.toEqual([]);
  });
});
