/**
 * Real-Postgres coverage for the portal's logo and colour chain (#9673): partner
 * default, then the org's portal_branding row.
 *
 * `/portal/branding` runs in the portal user's org-scoped context, where
 * `partners` is invisible (the partner-axis policy), so the fallback depends on
 * loadPartnerPortalDefaults escaping to system scope. A mocked DB cannot tell
 * whether that read works or quietly degrades to "no partner".
 */
import './setup';

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import { partners, portalBranding } from '../../db/schema';
import { brandingRoutes } from '../../routes/portal/branding';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const PARTNER_LOGO = 'data:image/png;base64,UEFSVE5FUg==';
const ORG_LOGO = 'data:image/png;base64,T1JH';

function portalOrgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    currentPartnerId: null,
    userId: null,
  };
}

async function seedOrg(branding: Record<string, unknown>) {
  const admin = getTestDb();
  const partner = await createPartner();
  await admin.update(partners).set({ settings: { branding } }).where(eq(partners.id, partner.id));
  const org = await createOrganization({ partnerId: partner.id });
  return org.id;
}

async function getPortalBranding(orgId: string) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: { id: '00000000-0000-4000-8000-000000000000', orgId, email: 'c@example.test', name: 'Cust', contactId: null, receiveNotifications: true, status: 'active' },
      token: 't',
      authMethod: 'bearer',
      timezone: 'UTC',
    } as never);
    await next();
  });
  app.route('/', brandingRoutes);
  return withDbAccessContext(portalOrgContext(orgId), async () => app.request('/branding'));
}

describe('GET /portal/branding logo and colour chain (#9673)', () => {
  runDb("serves the partner's logo and colours to an org with no portal_branding row, and no visibility flags", async () => {
    const orgId = await seedOrg({ logoUrl: PARTNER_LOGO, primaryColor: '#7a1d18', secondaryColor: '#123456' });

    const res = await getPortalBranding(orgId);

    expect(res.status).toBe(200);
    expect((await res.json()).branding).toEqual({
      logoUrl: PARTNER_LOGO,
      primaryColor: '#7a1d18',
      secondaryColor: '#123456',
    });
  });

  runDb("the org's portal_branding values win field by field", async () => {
    const orgId = await seedOrg({ logoUrl: PARTNER_LOGO, primaryColor: '#7a1d18', secondaryColor: '#123456' });
    await getTestDb().insert(portalBranding).values({ orgId, logoUrl: ORG_LOGO, secondaryColor: '#654321' });

    const { branding } = await (await getPortalBranding(orgId)).json();

    expect(branding.logoUrl).toBe(ORG_LOGO);
    expect(branding.primaryColor).toBe('#7a1d18');
    expect(branding.secondaryColor).toBe('#654321');
  });

  runDb('still 404s when neither level has set anything', async () => {
    const orgId = await seedOrg({});

    expect((await getPortalBranding(orgId)).status).toBe(404);
  });
});
