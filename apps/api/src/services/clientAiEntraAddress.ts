import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { customerEmailDomains } from '../db/schema';
import type { ClientAiEntraClaims } from './clientAiEntraJwt';

/**
 * Whether an Entra token's address may be used to identify a PERSON (#3258).
 *
 * `unverified-address` and `unusable-address` are kept apart because they are
 * different operator stories: the token carried nothing we could use, versus
 * the token carried something we deliberately would not trust.
 */
export type EntraAddressDecision =
  | { kind: 'linkable'; email: string }
  | { kind: 'refused'; outcome: 'unusable-address' | 'unverified-address' };

/** Lowercased domain part of an address, or null when it is not address-shaped. */
function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at < 0) return null;
  const domain = address.slice(at + 1).trim().toLowerCase();
  return domain || null;
}

/**
 * Decide whether an Entra token's address may be linked to a `contacts` row.
 *
 * ── Why this gate exists ────────────────────────────────────────────────────
 * Linking a login to an existing contact is an AUTHORIZATION decision, not a
 * cosmetic one: `portalTicketOwnership` grants a login sight of every ticket
 * that names its contact, so matching an address is enough to inherit that
 * address's emailed ticket history. An identity claim that anyone can set is
 * therefore not good enough — this is the nOAuth class of account takeover.
 *
 * ── The two conditions ──────────────────────────────────────────────────────
 * BOTH must hold:
 *
 *  (a) The address is one Microsoft vouches for. Either it is the
 *      `preferred_username` (the UPN — Entra only issues one on a domain the
 *      tenant owns), or it is the `email` claim AND `xms_edov` is true, which
 *      is the claim Microsoft added so relying parties can tell a verified
 *      address from one an admin typed onto a user object. A bare `email`
 *      claim is refused even when it looks perfectly ordinary.
 *
 *  (b) The address's domain is one the PARTNER has declared this org owns, in
 *      the same `customer_email_domains` table inbound email trusts to route a
 *      sender to a tenant. (a) alone only proves the address belongs to the
 *      Entra tenant; it says nothing about whether that tenant is this Breeze
 *      org's customer, and a mapped tenant can hold addresses on many domains.
 *
 * Exact-domain match only — `bob@mail.acme.com` does NOT match an `acme.com`
 * mapping, matching `resolveOrgBySenderDomain`. A suffix match would accept
 * arbitrary subdomains the MSP never vetted.
 *
 * Read-only, and it makes at most ONE query — both refusals that can be decided
 * from the claims alone are decided before touching the database.
 */
export async function resolveLinkableEntraAddress(
  orgId: string,
  partnerId: string,
  claims: ClientAiEntraClaims,
): Promise<EntraAddressDecision> {
  // (a) Pick the address, by provenance rather than by preference order. The
  // UPN wins when present because it is the stronger claim, not merely first.
  const vouched = claims.upn ?? (claims.emailDomainOwnerVerified ? claims.emailClaim : null);

  if (!vouched) {
    // Distinguish "no address at all" from "an address we will not trust", so
    // the audit says which. An email claim exists but is unvouched => refused.
    return { kind: 'refused', outcome: claims.emailClaim ? 'unverified-address' : 'unusable-address' };
  }

  const domain = domainOf(vouched);
  if (!domain) return { kind: 'refused', outcome: 'unusable-address' };

  // (b) The partner's declaration that this org owns the domain.
  const rows = await db
    .select({ orgId: customerEmailDomains.orgId })
    .from(customerEmailDomains)
    .where(
      and(
        eq(customerEmailDomains.partnerId, partnerId),
        eq(customerEmailDomains.domain, domain),
        eq(customerEmailDomains.isActive, true),
      ),
    )
    .limit(1);

  // The row must name THIS org: the unique index is (partner_id, domain), so a
  // sibling org of the same MSP owning the domain is a real possibility and
  // must not verify.
  if (rows[0]?.orgId !== orgId) return { kind: 'refused', outcome: 'unverified-address' };

  return { kind: 'linkable', email: vouched };
}
