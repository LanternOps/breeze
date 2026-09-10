import './setup';

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

let activeOrgId: string | null = null;
let activeAllowedSiteIds: string[] | undefined;

vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  const { withDbAccessContext } = await import('../../db');
  const establishContext = async (c: any, next: any) => {
    if (!activeOrgId) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', {
      principal: { kind: 'user_session' },
      scope: 'organization',
      orgId: activeOrgId,
      partnerId: null,
      accessibleOrgIds: [activeOrgId],
      user: { id: randomUUID(), email: 'onboarding-scope@test.invalid' },
      token: { mfa: true },
      canAccessOrg: (orgId: string) => orgId === activeOrgId,
    });
    return withDbAccessContext({
      scope: 'organization',
      orgId: activeOrgId,
      accessibleOrgIds: [activeOrgId],
      accessiblePartnerIds: null,
      userId: null,
    }, () => next());
  };
  return {
    ...actual,
    authMiddleware: establishContext,
    requireScope: () => async (_c: any, next: any) => next(),
    requirePermission: () => async (c: any, next: any) => {
      c.set('permissions', { allowedSiteIds: activeAllowedSiteIds });
      return next();
    },
    requireMfa: () => async (_c: any, next: any) => next(),
  };
});

vi.mock('../../services/partnerTrust', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/partnerTrust')>()),
  requireCapability: () => async (_c: any, next: any) => next(),
}));

vi.mock('../../services/enrollmentDefaults', () => ({
  assertTtlWithinCap: vi.fn(async () => null),
}));

import { getTestDb } from './setup';
import { enrollmentKeys } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';

async function onboardingApp() {
  const { coreRoutes } = await import('../../routes/devices/core');
  const app = new Hono();
  app.route('/devices', coreRoutes);
  return app;
}

describe('POST /devices/onboarding-token site scope as breeze_app', () => {
  beforeEach(() => {
    activeOrgId = null;
    activeAllowedSiteIds = undefined;
  });

  it('mints only into an accessible site and denies empty or foreign-site ceilings', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner!.id });
    const otherOrg = await createOrganization({ partnerId: partner!.id });
    await createSite({ orgId: org!.id });
    const allowedSite = await createSite({ orgId: org!.id });
    const foreignSite = await createSite({ orgId: otherOrg!.id });

    activeOrgId = org!.id;
    activeAllowedSiteIds = [allowedSite!.id];
    const app = await onboardingApp();

    const allowed = await app.request('/devices/onboarding-token', { method: 'POST' });
    expect(allowed.status).toBe(200);
    let rows = await getTestDb()
      .select({ siteId: enrollmentKeys.siteId })
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.orgId, org!.id));
    expect(rows).toEqual([{ siteId: allowedSite!.id }]);

    activeAllowedSiteIds = [];
    const empty = await app.request('/devices/onboarding-token', { method: 'POST' });
    expect(empty.status).toBe(403);

    activeAllowedSiteIds = [foreignSite!.id];
    const foreignOnly = await app.request('/devices/onboarding-token', { method: 'POST' });
    expect(foreignOnly.status).toBe(403);

    rows = await getTestDb()
      .select({ siteId: enrollmentKeys.siteId })
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.orgId, org!.id));
    expect(rows).toEqual([{ siteId: allowedSite!.id }]);
  });
});
