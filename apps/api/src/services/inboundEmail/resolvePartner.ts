import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { partnerInboundDomains, partners } from '../../db/schema';
import { getConfig } from '../../config/validate';

/** Single tenant-identity chokepoint (spec §4). Read-only; caller is in system context. */
export async function resolvePartnerByRecipient(recipient: string): Promise<string | null> {
  const addr = recipient.trim().toLowerCase();
  const at = addr.indexOf('@');
  if (at < 0) return null;
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);

  // (1) Model-B custom domain (empty in v1)
  const dom = await db.select({ partnerId: partnerInboundDomains.partnerId })
    .from(partnerInboundDomains).where(eq(partnerInboundDomains.domain, domain)).limit(1);
  if (dom[0]) return dom[0].partnerId;

  // (2) platform slug address: {slug}@TICKETS_INBOUND_DOMAIN
  if (getConfig().TICKETS_INBOUND_DOMAIN && domain === getConfig().TICKETS_INBOUND_DOMAIN) {
    const byAlias = await db.select({ id: partners.id }).from(partners)
      .where(and(eq(partners.inboundLocalPart, local), isNull(partners.deletedAt))).limit(1);
    if (byAlias[0]) return byAlias[0].id;

    const bySlug = await db.select({ id: partners.id }).from(partners)
      .where(and(eq(partners.slug, local), isNull(partners.deletedAt))).limit(1);
    if (bySlug[0]) return bySlug[0].id;
  }
  return null;
}
