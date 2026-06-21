import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { customerEmailDomains, partners } from '../../db/schema';
import { portalUsers } from '../../db/schema/portal';

/** Lowercased domain part of an email address, or null if malformed. */
function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at < 0) return null;
  const domain = address.slice(at + 1).trim().toLowerCase();
  return domain || null;
}

/**
 * Resolve a sender's email domain to a mapped customer org (Phase 5).
 * Read-only; caller is in system context (the inbound worker).
 */
export async function resolveOrgBySenderDomain(
  fromAddress: string,
  partnerId: string,
): Promise<{ orgId: string; autoCreateContact: boolean } | null> {
  const domain = domainOf(fromAddress);
  if (!domain) return null;
  const rows = await db
    .select({ orgId: customerEmailDomains.orgId, autoCreateContact: customerEmailDomains.autoCreateContact })
    .from(customerEmailDomains)
    .where(
      and(
        eq(customerEmailDomains.partnerId, partnerId),
        eq(customerEmailDomains.domain, domain),
        eq(customerEmailDomains.isActive, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Find an existing portal user by (org, email) or create a password-less
 * contact for attribution + future thread matching. A null passwordHash is
 * inherently non-login (mirrors the Entra path's password-less rows); this is
 * NOT an auth-capable account. Returns the portal user id.
 */
export async function findOrCreateEmailContact(
  orgId: string,
  email: string,
  name: string | null,
): Promise<string> {
  const lower = email.toLowerCase();
  const existing = await db
    .select({ id: portalUsers.id })
    .from(portalUsers)
    .where(and(eq(portalUsers.orgId, orgId), eq(portalUsers.email, lower)))
    .limit(1);
  if (existing[0]) return existing[0].id;
  const inserted = await db
    .insert(portalUsers)
    .values({ orgId, email: lower, name, passwordHash: null, authMethod: 'password', status: 'active' })
    .returning({ id: portalUsers.id });
  return inserted[0].id;
}

/**
 * Read the partner's inbound triage policy from partners.settings JSONB
 * (settings.ticketing.inbound). Absent fields read as disabled.
 */
export async function loadPartnerInboundPolicy(
  partnerId: string,
): Promise<{ triageUnknownSenders: boolean; defaultTriageOrgId: string | null }> {
  const rows = await db
    .select({ settings: partners.settings })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);
  const settings = (rows[0]?.settings ?? {}) as Record<string, unknown>;
  const inbound =
    (((settings.ticketing as Record<string, unknown> | undefined)?.inbound) as
      | { defaultTriageOrgId?: string | null; triageUnknownSenders?: boolean }
      | undefined) ?? {};
  return {
    triageUnknownSenders: inbound.triageUnknownSenders === true,
    defaultTriageOrgId: inbound.defaultTriageOrgId ?? null,
  };
}
