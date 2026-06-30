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
 *
 * Matches the EXACT sender domain only — `bob@mail.acme.com` does NOT match an
 * `acme.com` mapping (it falls through to triage/quarantine). This is deliberate:
 * a suffix match would route arbitrary subdomains the MSP never vetted into the org.
 * Do not "fix" this into an endsWith() match.
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
 *
 * SELECT-then-INSERT is not atomic and `portal_users` has no (org_id, email)
 * unique index (the login path already tolerates duplicates — see
 * portal/auth.ts). The inbound worker processes one message per transaction, so
 * the only way to double-insert is two distinct first-time emails from the SAME
 * new sender arriving concurrently — rare, and the dup is benign (both rows point
 * at the same org; attribution binds to one). A real fix is a partial unique index
 * on portal_users, which is a broader, auth-table change tracked separately.
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
  return inserted[0]!.id;
}

/**
 * How an inbound email from an UNKNOWN sender (no live thread, no closed-ticket
 * reply, no portal user, no mapped customer domain) is handled:
 *  - 'quarantine' — route to the review queue for manual convert/dismiss (default)
 *  - 'triage'     — auto-create a ticket in the partner's default triage org
 *                   (only effective when defaultTriageOrgId is set)
 *  - 'drop'       — silently ignore: no ticket, no review-queue row, no
 *                   autoresponse (an 'ignored' audit row is still written)
 */
export type UnknownSenderMode = 'quarantine' | 'triage' | 'drop';

const UNKNOWN_SENDER_MODES: readonly UnknownSenderMode[] = ['quarantine', 'triage', 'drop'];

export interface PartnerInboundPolicy {
  unknownSenderMode: UnknownSenderMode;
  defaultTriageOrgId: string | null;
  /**
   * When true, an inbound email whose sender fails the SPF/DKIM/DMARC gate is
   * silently dropped ('ignored' audit row) instead of quarantined. Applies to
   * ALL unverified senders (known or not), since the auth gate runs before any
   * sender matching. Default false (preserves the quarantine-for-review behavior).
   */
  dropUnverifiedSenders: boolean;
}

/**
 * Read the partner's inbound routing policy from partners.settings JSONB
 * (settings.ticketing.inbound). Absent fields read as the safe default
 * (quarantine; never drop). Back-compat: a partner that only has the legacy
 * `triageUnknownSenders` boolean (set before the 3-way mode existed) maps
 * true -> 'triage', false/absent -> 'quarantine'. The first save from the UI
 * replaces the inbound object wholesale, retiring the legacy key.
 */
export async function loadPartnerInboundPolicy(
  partnerId: string,
): Promise<PartnerInboundPolicy> {
  const rows = await db
    .select({ settings: partners.settings })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);
  const settings = (rows[0]?.settings ?? {}) as Record<string, unknown>;
  const inbound =
    (((settings.ticketing as Record<string, unknown> | undefined)?.inbound) as
      | {
          defaultTriageOrgId?: string | null;
          triageUnknownSenders?: boolean;
          unknownSenderMode?: string;
          dropUnverifiedSenders?: boolean;
        }
      | undefined) ?? {};

  // Prefer the explicit 3-way mode; fall back to the legacy boolean. An
  // unrecognized stored value falls through to the safe 'quarantine' default.
  const mode = UNKNOWN_SENDER_MODES.includes(inbound.unknownSenderMode as UnknownSenderMode)
    ? (inbound.unknownSenderMode as UnknownSenderMode)
    : inbound.triageUnknownSenders === true
      ? 'triage'
      : 'quarantine';

  return {
    unknownSenderMode: mode,
    defaultTriageOrgId: inbound.defaultTriageOrgId ?? null,
    dropUnverifiedSenders: inbound.dropUnverifiedSenders === true,
  };
}
