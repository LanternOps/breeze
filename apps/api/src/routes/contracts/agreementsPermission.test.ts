import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Guard contract test for the agreements permission (W02, spec §4).
 *
 * templates.test.ts and documents.test.ts both mock requirePermission as an
 * unconditional pass-through, so neither can observe which permission the
 * routes actually ask for. This file mocks it as a real predicate over a
 * mutable grant set, which makes the ONE property that matters testable: the
 * agreement-template and signed-agreement routes gate on agreements:*, and a
 * caller holding contracts:* alone is refused.
 *
 * That negative is the whole point of the wave. If it ever goes green with
 * `contracts:read` in the grant set, the resources have quietly re-merged.
 */
const h = vi.hoisted(() => ({ grants: new Set<string>() }));

vi.mock('../../services/contractTemplateService', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/contractTemplateService')>();
  return { ...original, listTemplates: vi.fn().mockResolvedValue([]), createTemplate: vi.fn() };
});

vi.mock('../../services/contractDocumentService', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/contractDocumentService')>();
  return { ...original, listContractDocuments: vi.fn().mockResolvedValue([]) };
});

vi.mock('../../services/sensitiveReadAudit', () => ({ auditSensitiveRead: vi.fn() }));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', {
      user: { id: 'u1' },
      partnerId: 'p1',
      orgId: null,
      scope: 'partner',
      accessibleOrgIds: null,
      canAccessOrg: () => true,
    });
    await next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  // The real middleware's contract, reduced to the grant check: 403
  // 'Permission denied' when the caller lacks the exact resource:action the
  // route asked for (middleware/auth.ts:883-885).
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    if (!h.grants.has(`${resource}:${action}`)) {
      return c.json({ error: 'Permission denied' }, 403);
    }
    await next();
  },
}));

import { contractRoutes } from './index';

const TEMPLATES = '/contract-templates';
const DOCUMENTS = '/contract-documents';

describe('agreement surfaces gate on agreements:*, not contracts:* (W02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.grants.clear();
  });

  it('GET /contract-templates allows a caller holding agreements:read', async () => {
    h.grants.add('agreements:read');
    const res = await contractRoutes.request(TEMPLATES, { method: 'GET' });
    expect(res.status).toBe(200);
  });

  // THE REGRESSION GUARD. Before the guard flip this returns 200.
  it('GET /contract-templates 403s a caller holding contracts:read but not agreements:read', async () => {
    h.grants.add('contracts:read');
    h.grants.add('contracts:write');
    h.grants.add('contracts:manage');
    const res = await contractRoutes.request(TEMPLATES, { method: 'GET' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Permission denied' });
  });

  it('POST /contract-templates requires agreements:write, not agreements:read', async () => {
    h.grants.add('agreements:read');
    const res = await contractRoutes.request(TEMPLATES, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ownerScope: 'partner', partnerId: 'p1', name: 'MSA' }),
    });
    expect(res.status).toBe(403);
  });

  it('GET /contract-documents allows agreements:read and 403s contracts:read', async () => {
    h.grants.add('agreements:read');
    expect((await contractRoutes.request(DOCUMENTS, { method: 'GET' })).status).toBe(200);

    h.grants.clear();
    h.grants.add('contracts:read');
    expect((await contractRoutes.request(DOCUMENTS, { method: 'GET' })).status).toBe(403);
  });
});
