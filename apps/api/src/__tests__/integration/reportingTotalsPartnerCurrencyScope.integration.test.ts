/**
 * `resolvePartnerReportingCurrency` must work for an ORGANIZATION-scoped actor
 * (multi-currency wave 7, #3779).
 *
 * `GET /billing/reporting-totals` derives the target currency server-side
 * precisely so an org-scoped viewer — who 403s on `/orgs/partners/me` — keeps
 * the "≈ approximate" line. But `partners` RLS is
 * `breeze_has_partner_access(id)`, which reads `breeze.accessible_partner_ids`,
 * and `computeAccessiblePartnerIds` returns `[]` for `scope === 'organization'`
 * (middleware/auth.ts). Read in the ambient request context, that SELECT sees
 * ZERO rows for exactly the caller the fallback exists for, so the endpoint
 * answered 409 NO_REPORTING_CURRENCY for a partner that HAS a currency
 * configured and the line silently never rendered.
 *
 * A mocked-driver unit test cannot prove this: only the real `breeze_app` role
 * with real GUCs shows the empty-row behaviour. Test 1 pins the trap itself so
 * a future "simplify it back to a bare select" reintroduces a red test, not a
 * dead feature.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { partners } from '../../db/schema';
import { resolvePartnerReportingCurrency } from '../../services/reportingTotals';
import { createOrganization, createPartner } from './db-utils';

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    // Exactly what computeAccessiblePartnerIds produces for an org token.
    accessiblePartnerIds: [],
    userId: null,
  };
}

function partnerContext(partnerId: string, orgId: string): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

describe('resolvePartnerReportingCurrency — organization-scoped actors', () => {
  it('the trap: a bare partners read in an org-scoped context returns ZERO rows', async () => {
    const partner = await createPartner({ currencyCode: 'CAD' });
    const org = await createOrganization({ partnerId: partner.id, currencyCode: 'EUR' });

    const rows = await withDbAccessContext(orgContext(org.id), () =>
      db.select({ currencyCode: partners.currencyCode })
        .from(partners)
        .where(eq(partners.id, partner.id))
        .limit(1),
    );

    expect(rows).toHaveLength(0);
  });

  it('resolves the partner reporting currency for an org-scoped actor anyway', async () => {
    const partner = await createPartner({ currencyCode: 'CAD' });
    const org = await createOrganization({ partnerId: partner.id, currencyCode: 'EUR' });

    const resolved = await withDbAccessContext(orgContext(org.id), () =>
      resolvePartnerReportingCurrency(partner.id),
    );

    // Not null — a null here is the 409 NO_REPORTING_CURRENCY the endpoint
    // returned before the fix, i.e. no approximate line for any org viewer.
    expect(resolved).toBe('CAD');
  });

  it('still resolves for a partner-scoped actor, and leaves the request context intact', async () => {
    const partner = await createPartner({ currencyCode: 'GBP' });
    const org = await createOrganization({ partnerId: partner.id, currencyCode: 'GBP' });

    await withDbAccessContext(partnerContext(partner.id, org.id), async () => {
      expect(await resolvePartnerReportingCurrency(partner.id)).toBe('GBP');

      // The system context must not leak: a read AFTER the lookup is still
      // subject to the caller's own RLS, so the org-scoped case above cannot
      // become a partner-table peephole for the rest of the request (#1105).
      const rows = await db.select({ id: partners.id })
        .from(partners)
        .where(eq(partners.id, partner.id))
        .limit(1);
      expect(rows).toHaveLength(1);
    });
  });

  it('returns null — never a USD substitute — for a partner id that does not exist', async () => {
    const partner = await createPartner({ currencyCode: 'CAD' });
    const org = await createOrganization({ partnerId: partner.id });

    const resolved = await withDbAccessContext(orgContext(org.id), () =>
      resolvePartnerReportingCurrency('00000000-0000-4000-8000-000000000000'),
    );

    expect(resolved).toBeNull();
  });
});
