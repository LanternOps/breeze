/**
 * Partner branding for the Assist caller-verification card (#6354 W02),
 * served on the authenticated `/helper/config` response.
 *
 * The org comes from the helper-authenticated device and is read under the
 * request's own RLS context; only the partner id that org resolves to enters
 * the partner-axis read. No client-supplied partner id is ever accepted. The
 * logo is passed only as a credential-free https URL.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { readWithPartnerAxisVisibility } from '../../db/partnerAxisRead';
import { organizations, partners, partnerLoginBranding } from '../../db/schema';

export type CallerHelperBranding = { partnerName: string; logoUrl: string | null };

export function safeLogo(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export async function callerHelperBranding(orgId: string): Promise<CallerHelperBranding | null> {
  const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const partnerId = org?.partnerId;
  if (!partnerId) return null;
  const [brand] = await readWithPartnerAxisVisibility(() => db.select({ name: partners.name, logo: partnerLoginBranding.logoUrl })
    .from(partners)
    .leftJoin(partnerLoginBranding, eq(partnerLoginBranding.partnerId, partners.id))
    .where(eq(partners.id, partnerId))
    .limit(1));
  const partnerName = brand?.name?.trim().slice(0, 120);
  return partnerName ? { partnerName, logoUrl: safeLogo(brand?.logo) } : null;
}
