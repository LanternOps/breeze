import { and, eq } from 'drizzle-orm';
import { db, getCurrentDbAccessContext } from '../../db';
import { readWithPartnerAxisVisibility } from '../../db/partnerAxisRead';
import { partners, partnerSenderIdentities, partnerSendingDomains } from '../../db/schema';
import { evaluateCapabilityContinuationForState } from '../partnerTrust';
import type { PartnerMailStream } from './mailPurposes';

/**
 * Everything in the partner branch of `resolveSender` that touches the database
 * or the trust service (spec §8.3, conditions 2 and 3).
 *
 * WHY THIS IS A SEPARATE MODULE: `senderResolution.ts` imports it ONLY through
 * `await import(...)`, inside the partner branch. `db/index.ts` runs dotenv and
 * constructs a postgres client at module load, and `services/partnerTrust.ts`
 * pulls in the audit service, the trust repo and Redis — none of which may be
 * loaded by a platform-purpose send. Keeping the boundary here is what makes
 * spec §8.1's first property ("a platform purpose returns before any database
 * read") true of the MODULE GRAPH and not merely of the control flow, and it
 * keeps every existing EmailService unit suite loading exactly what it loads
 * today. See plan amendment 1.
 */

/** Domain statuses that may send on the partner lane (spec §5.2). */
const SENDABLE_DOMAIN_STATUSES = new Set(['verified', 'at_risk']);

export type PartnerLaneLookup =
  | { ok: false; reason: 'partner_ineligible' | 'no_identity' | 'domain_not_sendable' }
  | {
      ok: true;
      partnerName: string;
      localPart: string;
      displayName: string | null;
      replyTo: string | null;
      domainId: string;
      domain: string;
    };

/**
 * Does the ambient DB context already grant RLS visibility of this partner?
 *
 * `getCurrentDbAccessContext()` mirrors exactly what `breeze_has_partner_access`
 * evaluates (db/index.ts:923-935), so an allowlist hit here means the read will
 * return the row.
 */
export function partnerLaneAmbientCanSee(partnerId: string): boolean {
  const ambient = getCurrentDbAccessContext();
  if (!ambient) return false;
  if (ambient.scope === 'system') return true;
  if (ambient.scope !== 'partner') return false;
  return (ambient.accessiblePartnerIds ?? []).includes(partnerId);
}

/**
 * Run `fn` where it can see the partner.
 *
 * - system scope, or partner scope that already lists this partner: in place.
 * - PARTNER scope that does NOT list it: STILL in place. This is the case a
 *   naive reading of §8.3 would escalate, and escalating would hand partner B
 *   partner A's sender identity — `readWithPartnerAxisVisibility` runs as
 *   `system`. RLS returns zero rows instead and the caller falls back to the
 *   platform lane. Fail closed; see plan amendment 2.
 * - org scope, portal, or no context at all: the sanctioned partner-axis escape
 *   (db/partnerAxisRead.ts). It holds a SECOND pooled connection for one indexed
 *   read, which is why it is taken only when it is actually needed.
 */
function inPartnerVisibleContext<T>(partnerId: string, fn: () => Promise<T>): Promise<T> {
  if (partnerLaneAmbientCanSee(partnerId)) return fn();
  if (getCurrentDbAccessContext()?.scope === 'partner') return fn();
  return readWithPartnerAxisVisibility(fn);
}

export async function lookupPartnerLaneIdentity(
  partnerId: string,
  stream: PartnerMailStream,
): Promise<PartnerLaneLookup> {
  // ONE read (spec §8.3). LEFT JOINs so an eligible partner with no identity is
  // distinguishable from an invisible/absent partner: the first yields a row
  // with null identity columns, the second yields no row at all.
  const rows = await inPartnerVisibleContext(partnerId, () =>
    db
      .select({
        partnerName: partners.name,
        partnerStatus: partners.status,
        trustState: partners.trustState,
        probationEnrollments: partners.probationEnrollments,
        localPart: partnerSenderIdentities.localPart,
        displayName: partnerSenderIdentities.displayName,
        identityReplyTo: partnerSenderIdentities.replyTo,
        domainId: partnerSendingDomains.id,
        domain: partnerSendingDomains.domain,
        domainStatus: partnerSendingDomains.status,
      })
      .from(partners)
      .leftJoin(
        partnerSenderIdentities,
        and(
          eq(partnerSenderIdentities.partnerId, partners.id),
          eq(partnerSenderIdentities.stream, stream),
        ),
      )
      .leftJoin(
        partnerSendingDomains,
        and(
          eq(partnerSendingDomains.id, partnerSenderIdentities.sendingDomainId),
          eq(partnerSendingDomains.partnerId, partners.id),
        ),
      )
      .where(eq(partners.id, partnerId))
      .limit(1),
  );

  const row = rows[0];
  // No row: the partner does not exist, is soft-deleted out of view, or this
  // context cannot see it. All three are "we cannot establish eligibility".
  if (!row) return { ok: false, reason: 'partner_ineligible' };

  // Condition 2 (spec §8.3): active partner AND the capability continuation.
  if (row.partnerStatus !== 'active') return { ok: false, reason: 'partner_ineligible' };
  const decision = evaluateCapabilityContinuationForState(
    'custom_sending_domain',
    { partnerId },
    { trustState: row.trustState, probationEnrollments: row.probationEnrollments },
  );
  // The CONTINUATION evaluator on purpose: `evaluateCapability` writes a
  // `partner.trust.capability_denied` audit row and may fire auto-promotion.
  // Sending an email must do neither — a restricted partner would otherwise
  // mint an audit row per outbound message.
  if (!decision.allow) return { ok: false, reason: 'partner_ineligible' };

  // Condition 3: an identity for the stream, on a sendable domain.
  if (!row.localPart || !row.domainId || !row.domain) return { ok: false, reason: 'no_identity' };
  if (!row.domainStatus || !SENDABLE_DOMAIN_STATUSES.has(row.domainStatus)) {
    return { ok: false, reason: 'domain_not_sendable' };
  }

  return {
    ok: true,
    partnerName: row.partnerName,
    localPart: row.localPart,
    displayName: row.displayName,
    replyTo: row.identityReplyTo,
    domainId: row.domainId,
    domain: row.domain,
  };
}
