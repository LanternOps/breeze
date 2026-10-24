import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const h = vi.hoisted(() => {
  class EntitlementResolutionError extends Error {}
  return { hasEntitlement: vi.fn(), EntitlementResolutionError };
});

vi.mock('../services/entitlements', () => ({
  hasEntitlement: h.hasEntitlement,
  EntitlementResolutionError: h.EntitlementResolutionError
}));

import { requireEntitlement } from './entitlement';

const PARTNER = '22222222-2222-4222-8222-222222222222';

function buildApp(auth: Record<string, unknown> | undefined) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (auth) c.set('auth' as never, auth as never);
    await next();
  });
  app.use('*', requireEntitlement('wisp'));
  app.get('/x', (c) => c.json({ ok: true }));
  return app;
}

describe('requireEntitlement', () => {
  beforeEach(() => {
    h.hasEntitlement.mockReset();
  });

  it('passes when the partner is entitled', async () => {
    h.hasEntitlement.mockResolvedValue(true);
    const res = await buildApp({ partnerId: PARTNER, scope: 'partner' }).request('/x');
    expect(res.status).toBe(200);
    expect(h.hasEntitlement).toHaveBeenCalledWith(PARTNER, 'wisp');
  });

  it('403 entitlement_required with label + featureKey when not entitled', async () => {
    h.hasEntitlement.mockResolvedValue(false);
    const res = await buildApp({ partnerId: PARTNER, scope: 'partner' }).request('/x');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'entitlement_required', error: 'Wisp', featureKey: 'wisp' });
  });

  it('403 entitlement_required when auth.partnerId is null (fail closed), without calling the resolver', async () => {
    const res = await buildApp({ partnerId: null, scope: 'system' }).request('/x');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'entitlement_required', error: 'Wisp', featureKey: 'wisp' });
    expect(h.hasEntitlement).not.toHaveBeenCalled();
  });

  it('401 when no auth context', async () => {
    const res = await buildApp(undefined).request('/x');
    expect(res.status).toBe(401);
    expect(h.hasEntitlement).not.toHaveBeenCalled();
  });

  it('503 entitlement_check_failed with Retry-After: 30 when the resolver throws EntitlementResolutionError', async () => {
    h.hasEntitlement.mockRejectedValue(new h.EntitlementResolutionError('db down'));
    const res = await buildApp({ partnerId: PARTNER, scope: 'partner' }).request('/x');
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toEqual({
      code: 'entitlement_check_failed',
      error: 'Entitlement check temporarily unavailable',
      featureKey: 'wisp'
    });
  });

  it('a non-resolution error propagates (500), not a 403', async () => {
    h.hasEntitlement.mockRejectedValue(new Error('bug'));
    const app = buildApp({ partnerId: PARTNER, scope: 'partner' });
    app.onError((err, c) => c.json({ error: err.message }, 500));
    const res = await app.request('/x');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'bug' });
  });

  describe('partnerIdOf option (W04: entitlement of an org-scope caller\'s owning partner)', () => {
    function buildWith(auth: Record<string, unknown>, partnerIdOf: (c: unknown) => Promise<string | null>) {
      const app = new Hono();
      app.use('*', async (c, next) => {
        c.set('auth' as never, auth as never);
        await next();
      });
      app.use('*', requireEntitlement('wisp', { partnerIdOf }));
      app.get('/x', (c) => c.json({ ok: true }));
      return app;
    }

    it('checks the partner the resolver returns', async () => {
      h.hasEntitlement.mockResolvedValue(true);
      const res = await buildWith({ partnerId: null, scope: 'organization' }, async () => PARTNER).request('/x');
      expect(res.status).toBe(200);
      expect(h.hasEntitlement).toHaveBeenCalledWith(PARTNER, 'wisp');
    });

    it('fails closed (403) without consulting the entitlement resolver when it returns null', async () => {
      const res = await buildWith({ partnerId: null, scope: 'organization' }, async () => null).request('/x');
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: 'entitlement_required', error: 'Wisp', featureKey: 'wisp' });
      expect(h.hasEntitlement).not.toHaveBeenCalled();
    });

    it('401 without an auth context, before the resolver runs', async () => {
      const partnerIdOf = vi.fn(async () => PARTNER);
      const app = new Hono();
      app.use('*', requireEntitlement('wisp', { partnerIdOf }));
      app.get('/x', (c) => c.json({ ok: true }));
      expect((await app.request('/x')).status).toBe(401);
      expect(partnerIdOf).not.toHaveBeenCalled();
    });
  });
});
