/**
 * P2-6 (#4193, Task A6) — partner impact weights.
 *
 * `partners.ai_impact_weights` prices the six read-time-estimate outcomes
 * (`ImpactWeights`, @breeze/shared) for one partner. Reads go through the
 * partner-axis escape (`readWithPartnerAxisVisibility`) because an org-scoped
 * RLS context has `accessible_partner_ids = []` and would otherwise read ZERO
 * ROWS, not an error (#2822). Writes run under the CALLER's own context —
 * `canManagePartnerWidePolicies` only returns true for system scope or a
 * full-partner-admin (`partnerOrgAccess: 'all'`), and both of those already
 * pass `breeze_has_partner_access` for their own partner row, so the write
 * never needs (and must never take) the read escape.
 */
import { eq } from 'drizzle-orm';
import {
  DEFAULT_IMPACT_WEIGHTS,
  normalizeImpactWeightOverrides,
  resolveImpactWeights,
  type ImpactWeightOverrides,
  type ImpactWeights,
} from '@breeze/shared';
import { db } from '../../db';
import { readWithPartnerAxisVisibility } from '../../db/partnerAxisRead';
// Direct module import, not the ../../db/schema barrel — same reason as
// effectivePolicy.ts: keeps a partial-mock unit test from having to stub the
// entire schema surface.
import { organizations, partners } from '../../db/schema/orgs';
import type { AuthContext } from '../../middleware/auth';
import { canManagePartnerWidePolicies, PartnerWideWriteDeniedError } from '../partnerWideAccess';

export interface ResolvedImpactWeights {
  partnerId: string;
  effective: ImpactWeights;
  overrides: ImpactWeightOverrides | null;
}

/** Thrown when no single partner can be resolved for an impact request. */
export class ImpactPartnerUnresolvedError extends Error {
  constructor(message = 'Unable to resolve a single partner for this impact request') {
    super(message);
    this.name = 'ImpactPartnerUnresolvedError';
  }
}

/**
 * The partner whose weights price this request. `auth.partnerId` for
 * organization and partner scope (an org token carries a partnerId even
 * though it can never pass breeze_has_partner_access); for system scope the
 * caller MUST pass an orgId and the partner is read off that org row under
 * the caller's own context. Throws ImpactPartnerUnresolvedError when neither
 * yields one — a system-wide estimate cannot use one weight set across
 * multiple partners.
 */
export async function resolveImpactPartnerId(auth: AuthContext, orgId?: string): Promise<string> {
  if (auth.scope === 'organization' || auth.scope === 'partner') {
    if (!auth.partnerId) throw new ImpactPartnerUnresolvedError();
    return auth.partnerId;
  }

  // System scope has no partner of its own — the caller must name the org
  // whose estimate this is for, and the partner is read off that org row.
  if (!orgId) throw new ImpactPartnerUnresolvedError();

  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw new ImpactPartnerUnresolvedError();
  return org.partnerId;
}

/**
 * Reads partners.ai_impact_weights through readWithPartnerAxisVisibility. An
 * org-scoped RLS context has accessible_partner_ids = [] and would read ZERO
 * ROWS (not an error) without the escape — #2822.
 */
export async function loadImpactWeights(partnerId: string): Promise<ResolvedImpactWeights> {
  const [row] = await readWithPartnerAxisVisibility(() =>
    db
      .select({ aiImpactWeights: partners.aiImpactWeights })
      .from(partners)
      .where(eq(partners.id, partnerId))
      .limit(1)
  );

  const stored = row?.aiImpactWeights ?? null;
  return {
    partnerId,
    effective: resolveImpactWeights(stored),
    overrides: normalizeImpactWeightOverrides(stored),
  };
}

/**
 * Writes under the CALLER's own context (partner scope passes
 * breeze_has_partner_access) — never the system escape. `overrides: null`
 * resets to defaults. Throws PartnerWideWriteDeniedError when
 * canManagePartnerWidePolicies(auth) is false. Returns before/after for the
 * route's audit row.
 */
export async function saveImpactWeights(
  auth: AuthContext,
  partnerId: string,
  overrides: ImpactWeightOverrides | null
): Promise<{ before: ImpactWeightOverrides | null; after: ImpactWeightOverrides | null; effective: ImpactWeights }> {
  if (!canManagePartnerWidePolicies(auth)) throw new PartnerWideWriteDeniedError();

  const normalized = overrides === null ? null : normalizeImpactWeightOverrides(overrides);

  // A plain select under the caller's own context — never the partner-axis
  // read escape. A caller who passed the gate above already has direct RLS
  // access to their own partner row (system scope, or a full-partner-admin
  // whose accessible_partner_ids includes partnerId).
  const [existing] = await db
    .select({ aiImpactWeights: partners.aiImpactWeights })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);
  const before = normalizeImpactWeightOverrides(existing?.aiImpactWeights ?? null);

  await db
    .update(partners)
    .set({ aiImpactWeights: normalized })
    .where(eq(partners.id, partnerId));

  return {
    before,
    after: normalized,
    effective: normalized ? resolveImpactWeights(normalized) : { ...DEFAULT_IMPACT_WEIGHTS },
  };
}
