import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { LEGACY_ALERTING_GONE } from '../legacyAlertingGone';

const { authRef } = vi.hoisted(() => ({ authRef: { current: {} as Record<string, unknown> } }));
vi.mock('../../middleware/auth', () => ({
  requireScope: () => async (c: any, next: any) => { c.set('auth', authRef.current); await next(); },
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
}));
// Retirement must not look up ownership or mutate any row.
vi.mock('../../db', () => ({ db: {} }));
vi.mock('../../db/schema', () => ({ alertTemplates: {} }));
import { templateRoutes } from './templates';

const TEMPLATE_ID = '5d4c3b2a-1111-4222-8333-444455556666';

describe('retired template ownership guards', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['organization', undefined],
    ['partner', 'all'],
    ['partner', 'selected'],
    ['system', undefined],
  ])('returns retirement guidance for %s scope with %s org access', async (scope, partnerOrgAccess) => {
    authRef.current = { scope, partnerOrgAccess, partnerId: 'partner-1', canAccessOrg: () => true };
    const app = new Hono();
    app.route('/alert-templates', templateRoutes);
    for (const method of ['PATCH', 'DELETE']) {
      const res = await app.request(`/alert-templates/templates/${TEMPLATE_ID}`, {
        method, headers: { 'content-type': 'application/json' },
        body: method === 'DELETE' ? undefined : '{}',
      });
      expect(res.status).toBe(410);
      expect(await res.json()).toEqual(LEGACY_ALERTING_GONE);
    }
  });
});
