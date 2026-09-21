import { and, eq, isNull, ne } from 'drizzle-orm';
import { db } from '../db';
import { organizations } from '../db/schema';

/** Exported so other partner-wide write routes (e.g. invoices/settings.ts's
 *  PATCH /partner/billing-settings) can write the same semantic audit shape
 *  this file uses for `partner.settings.update` — a partner-wide action has
 *  no orgId of its own, and the request-derived fallback in index.ts silently
 *  skips a multi-org partner (resolveFallbackOrgId requires auth.orgId or
 *  exactly one accessibleOrgIds entry), so a semantic audit here is the only
 *  way most partner admins get an audit_logs row at all (sweep paper cut #4). */
export async function resolveAuditOrgIdForPartner(partnerId: string | null): Promise<string | null> {
  if (!partnerId) {
    return null;
  }

  try {
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      // The hidden 'quick_support' org is a real row under the partner and could
      // easily be the oldest — never let it become the audit fallback org.
      .where(and(
        eq(organizations.partnerId, partnerId),
        ne(organizations.type, 'quick_support'),
        isNull(organizations.deletedAt),
      ))
      .orderBy(organizations.createdAt)
      .limit(1);

    return org?.id ?? null;
  } catch (err) {
    console.error('[audit] Failed to resolve orgId for partner:', partnerId, err);
    return null;
  }
}
