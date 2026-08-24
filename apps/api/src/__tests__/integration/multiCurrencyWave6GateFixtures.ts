import './setup';

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
