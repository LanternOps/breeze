import './setup';

import { withSystemDbAccessContext } from '../../db';
import { assignProfileToOrg, createProfile } from '../../services/billingProfileService';
import { eq } from 'drizzle-orm';
import { partners } from '../../db/schema';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

export interface GateOrgFixture {
  partnerId: string;
  orgId: string;
  siteId: string;
  userId: string;
  currencyCode: string;
  actor: { userId: string; partnerId: string; accessibleOrgIds: string[] };
}

/** USD partner by default (spec §14: "a non-USD org on a USD partner"). */
export async function seedGateOrg(
  currencyCode: string,
  opts: { partnerCurrency?: string; partnerLanguage?: string } = {},
): Promise<GateOrgFixture> {
  const partner = await createPartner({ currencyCode: opts.partnerCurrency ?? 'USD' });

  if (opts.partnerLanguage) {
    await getTestDb()
      .update(partners)
      .set({ settings: { language: opts.partnerLanguage } })
      .where(eq(partners.id, partner.id));
  }

  const organization = await createOrganization({ partnerId: partner.id, currencyCode });
  const site = await createSite({ orgId: organization.id });
  const user = await createUser({ partnerId: partner.id, orgId: null });

  return {
    partnerId: partner.id,
    orgId: organization.id,
    siteId: site.id,
    userId: user.id,
    currencyCode,
    actor: {
      userId: user.id,
      partnerId: partner.id,
      accessibleOrgIds: [organization.id],
    },
  };
}

export function gateLabel(
  slice: 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7',
  name: string,
): string {
  return `[wave6 gate][${slice}] ${name}`;
}

/** Exercise the real profile validation and organization assignment paths. */
export async function assignGateBillingProfile(fixture: GateOrgFixture, rate: number) {
  return withSystemDbAccessContext(async () => {
    const profile = await createProfile({ scope: 'system' }, fixture.partnerId, {
      name: 'Gate rates', currencyCode: fixture.currencyCode,
      baseCoverage: 'billable', baseHourlyRate: String(rate),
    });
    await assignProfileToOrg(fixture.orgId, fixture.partnerId, profile.id, fixture.userId);
    return profile;
  });
}
