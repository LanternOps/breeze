/**
 * Real-Postgres integration coverage for the partner-axis RLS gap in
 * server-rendered report branding (#6078 follow-up).
 *
 * The bug: `loadReportBrandingForOrg` (services/reportBranding.ts) resolved the
 * partner name/logo/colours/contact with a single LEFT JOIN from
 * `organizations` onto `partners`. `partners` is a partner-AXIS table whose
 * only policy is `breeze_has_partner_access(id)`
 * (migrations/2026-04-11-partners-rls.sql), and the portal request context
 * (routes/portal/auth.ts) is `scope: 'organization'` with
 * `accessiblePartnerIds: []` and `currentPartnerId: null`. The joined side
 * therefore evaluated to NULL — without raising — so `!row?.partnerName` sent
 * the function down its `empty` return and the portal lifecycle endpoint
 * reported `"contact": null`. The blast radius is the WHOLE branding object,
 * not just the closing line: `renderRunPdf`
 * (services/portal/reportsSelfService.ts) feeds the same result into
 * `buildReportPdf`, so portal-rendered PDFs lost the partner name, logo and
 * brand colours too and silently fell back to the Breeze palette.
 *
 * A mocked-DB unit test cannot catch this — reportBranding.test.ts stages the
 * row its assertions then read back, with no RLS evaluation anywhere, and the
 * pre-fix code passed all of it. Only a real `breeze_app` connection inside a
 * real org-scoped `withDbAccessContext` session can tell the two apart.
 *
 * Modelled on remoteAccessLauncherPartnerVisibility.integration.test.ts (#3419).
 */
import './setup';

import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { organizations, partners } from '../../db/schema';
import { loadReportBrandingForOrg } from '../../services/reportBranding';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/**
 * Mirrors the portal request context (routes/portal/auth.ts): organization
 * scope, no accessible partners, no current partner id. This is the exact
 * shape the defect was reproduced under.
 */
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

const CONTACT = { name: 'Dana Ops', email: 'dana@olive.example' };

const createdOrgIds: string[] = [];
const createdPartnerIds: string[] = [];

async function seedTenant(label: string): Promise<{ partnerId: string; orgId: string; partnerName: string }> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const partnerName = `Branding Partner ${label} ${unique}`;
  const ids = await withSystemDbAccessContext(async () => {
    const [partner] = await db
      .insert(partners)
      .values({
        name: partnerName,
        slug: `branding-partner-${label}-${unique}`,
        type: 'msp',
        plan: 'pro',
        status: 'active',
        settings: {
          branding: { primaryColor: '#7a1d18', secondaryColor: '#123456' },
          contact: CONTACT,
        },
      })
      .returning({ id: partners.id });
    const [org] = await db
      .insert(organizations)
      .values({
        currencyCode: 'USD',
        partnerId: partner!.id,
        name: `Branding Org ${label} ${unique}`,
        slug: `branding-org-${label}-${unique}`,
        type: 'customer',
        status: 'active',
      })
      .returning({ id: organizations.id });
    return { partnerId: partner!.id, orgId: org!.id };
  });
  createdPartnerIds.push(ids.partnerId);
  createdOrgIds.push(ids.orgId);
  return { ...ids, partnerName };
}

afterEach(async () => {
  if (createdOrgIds.length === 0 && createdPartnerIds.length === 0) return;
  // One transaction per row on purpose: the partner-export lock hierarchy
  // (breeze_partner_export_organizations_delete) refuses a second partner's
  // lock once an organization lock is held, so batching two tenants' deletes
  // into one transaction raises P0001.
  for (const id of createdOrgIds) {
    await withSystemDbAccessContext(() => db.delete(organizations).where(eq(organizations.id, id)));
  }
  for (const id of createdPartnerIds) {
    await withSystemDbAccessContext(() => db.delete(partners).where(eq(partners.id, id)));
  }
  createdOrgIds.length = 0;
  createdPartnerIds.length = 0;
});

describe('report branding — partner visibility under a portal org-scoped context (#6078)', () => {
  runDb(
    'resolves the partner name, colours AND contact for an org-scoped portal caller',
    async () => {
      const { orgId, partnerName } = await seedTenant('own');

      const branding = await withDbAccessContext(portalOrgContext(orgId), () =>
        loadReportBrandingForOrg(orgId),
      );

      // Pre-fix every one of these was null: the whole branding object
      // collapsed, not just the contact line.
      expect(branding.name).toBe(partnerName);
      expect(branding.primaryColor).toBe('#7a1d18');
      expect(branding.accentColor).toBe('#123456');
      expect(branding.contactEmail).toBe(CONTACT.email);
      expect(branding.contactName).toBe(CONTACT.name);
    },
  );

  runDb(
    'an orgId belonging to ANOTHER partner returns empty branding (the org read stays under the caller RLS)',
    async () => {
      const mine = await seedTenant('mine');
      const other = await seedTenant('other');

      // The caller is scoped to its own org; it asks for a foreign org that
      // happens to live under a different partner. The org lookup runs under
      // the caller's own context, so it finds nothing and the partner read
      // never happens — no cross-partner branding leak.
      const branding = await withDbAccessContext(portalOrgContext(mine.orgId), () =>
        loadReportBrandingForOrg(other.orgId),
      );

      expect(branding).toEqual({ name: null, logoDataUrl: null, logoAspect: null });
    },
  );

  runDb(
    'sanity check: the raw partners row IS invisible to that org-scoped context (proves the RLS premise)',
    async () => {
      const { orgId, partnerId } = await seedTenant('premise');

      const rows = await withDbAccessContext(portalOrgContext(orgId), () =>
        db.select({ id: partners.id }).from(partners).where(eq(partners.id, partnerId)),
      );

      // If this ever returns the row, the partners policy itself changed and
      // this file needs re-evaluating rather than green-lighting.
      expect(rows).toHaveLength(0);
    },
  );
});
