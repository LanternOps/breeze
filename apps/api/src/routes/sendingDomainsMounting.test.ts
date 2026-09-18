import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Reach each router through the REAL admin hub, and assert the index.ts mount
// statically. Importing index.ts itself would boot the server and every worker.
vi.mock('../middleware/platformAdmin', () => ({
  platformAdminMiddleware: async (c: any, next: any) => {
    c.set('auth', { scope: 'system', partnerId: null, user: { id: '55555555-5555-4555-8555-555555555555' } });
    return next();
  },
}));
vi.mock('../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: async (c: any, next: any) => {
      c.set('auth', { scope: 'partner', partnerId: '11111111-1111-4111-8111-111111111111', user: { id: 'u1' } });
      c.set('permissions', { permissions: [{ resource: '*', action: '*' }] });
      return next();
    },
    requireMfa: () => async (_c: any, next: any) => next(),
  };
});
vi.mock('../services/emailDomains/config', () => ({ isPartnerLaneConfigured: () => false }));
vi.mock('../services/emailDomains/sendingDomainService', () => ({
  SendingDomainServiceError: class extends Error {},
  listAllSendingDomains: vi.fn(async () => []),
  suspendSendingDomain: vi.fn(),
  unsuspendSendingDomain: vi.fn(),
  forceReleaseSendingDomain: vi.fn(),
  listSendingDomains: vi.fn(),
  createSendingDomain: vi.fn(),
  requestDomainCheck: vi.fn(),
  requestDomainRemoval: vi.fn(),
  upsertSenderIdentity: vi.fn(),
  deleteSenderIdentity: vi.fn(),
  getSendingDomainsCapability: vi.fn(),
}));
vi.mock('../jobs/sendingDomainsWorker', () => ({ enqueueTestSend: vi.fn() }));

const indexSource = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');

describe('index.ts mounts the partner router', () => {
  it('registers /partner/sending-domains', () => {
    expect(indexSource).toContain("import { partnerSendingDomainsRoutes } from './routes/partnerSendingDomains';");
    expect(indexSource.indexOf("api.route('/partner/sending-domains', partnerSendingDomainsRoutes);")).toBeGreaterThan(-1);
  });

  it('registers it BEFORE the catch-all /partner router, or /sending-domains is eaten', () => {
    const specific = indexSource.indexOf("api.route('/partner/sending-domains'");
    const catchAll = indexSource.indexOf("api.route('/partner', partnerRoutes);");
    expect(specific).toBeGreaterThan(-1);
    expect(catchAll).toBeGreaterThan(-1);
    expect(specific).toBeLessThan(catchAll);
  });
});

describe('the routers are reachable through the real composition roots', () => {
  it('the admin hub serves /admin/sending-domains under platformAdminMiddleware', async () => {
    const { adminRoutes } = await import('./admin');
    const app = new Hono();
    app.route('/admin', adminRoutes);
    const res = await app.request('/admin/sending-domains');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it('the partner router answers through its own auth gate and reports the dark default', async () => {
    const { partnerSendingDomainsRoutes } = await import('./partnerSendingDomains');
    const app = new Hono();
    app.route('/partner/sending-domains', partnerSendingDomainsRoutes);
    const res = await app.request('/partner/sending-domains');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'sending_domains_unsupported' });
  });
});
