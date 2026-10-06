import { eq } from 'drizzle-orm';
import type { AutopayBranding } from '@breeze/shared';
import { partners, portalBranding } from '../../db/schema';
import type { Tx } from './types';

/** Who a client-facing autopay page speaks for: the MSP's name, the org's portal
 * logo and the MSP billing email (the reply-to of every billing notice). Callers
 * pass ids taken from an authorized invoice, link or portal identity. */
export async function loadAutopayBranding(db: Tx, ids: { orgId: string; partnerId: string }): Promise<AutopayBranding> {
  const [partner] = await db.select({ name: partners.name, billingEmail: partners.billingEmail })
    .from(partners).where(eq(partners.id, ids.partnerId)).limit(1);
  const [brand] = await db.select({ logoUrl: portalBranding.logoUrl })
    .from(portalBranding).where(eq(portalBranding.orgId, ids.orgId)).limit(1);
  return { partnerName: partner?.name ?? '', logoUrl: brand?.logoUrl ?? null, supportEmail: partner?.billingEmail ?? null };
}
