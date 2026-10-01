/**
 * Partner data-residency requirement (spec §7, §11; W03 reads it in
 * loadPartnerFacts). W04 owns the only writer. Residency fails CLOSED in the
 * resolver, so turning it on can make features unavailable. The impact is
 * computed with W03's checkEligibility (residencyRequired: true), never with a
 * second copy of the residency rule.
 *
 * The write runs behind the partner registry lock (inPartnerRegistryWrite), and
 * the impact it gates on is recomputed inside it, so a concurrent assignment
 * write cannot slip an unacknowledged breakage past the check.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { AiResidencyImpactDto, AiSurface } from '@breeze/shared';
import { db } from '../../db';
import { aiModelAssignments, organizations, partners } from '../../db/schema';
import { isHosted } from '../../config/env';
import { loadOfferingCandidate, loadPartnerFacts, type LoadedCandidate } from './candidateLoader';
import { checkEligibility, type PartnerPlan } from './eligibility';
import { defaultTransport, transportCarries } from './transport';
import { listAssignmentRows } from './assignmentRows';
import { inPartnerRegistryWrite } from './offeringWrites';
import { RegistryWriteError } from './registryWriteErrors';

const NO_IMPACT: AiResidencyImpactDto = Object.freeze({ unavailableSurfaces: [], affectedOrgOverrides: [] }) as AiResidencyImpactDto;

/**
 * Would this offering, as a default on `surface`, be residency_unavailable?
 * Same context the resolver builds (transport carriage of the surface's
 * default transport), with residency forced on — W03's rule table, never a copy.
 * A row that already fails for another reason is not residency's impact.
 */
async function failsResidency(
  partnerId: string, plan: PartnerPlan, surface: AiSurface, offeringId: string,
  cache: Map<string, LoadedCandidate | null>,
): Promise<boolean> {
  let c = cache.get(offeringId);
  if (c === undefined) { c = await loadOfferingCandidate(offeringId, partnerId); cache.set(offeringId, c); }
  if (!c) return false;
  return checkEligibility(c.facts, {
    partnerId, surface, partnerPlan: plan, hosted: isHosted(),
    residencyRequired: true,
    geoCarriable: transportCarries(defaultTransport(surface)).inferenceGeo,
    userInitiated: false, userHoldsPermission: () => true,
  }) === 'residency_unavailable';
}

/**
 * Every assignment row with its own default counts, whatever its role (an
 * ai_agents triage role breaking is a broken feature too); a surface is
 * listed once. Reads run in the ambient DB context, pinned to partnerId.
 */
export async function previewResidencyImpact(partnerId: string): Promise<AiResidencyImpactDto> {
  const { plan } = await loadPartnerFacts(partnerId);
  const cache = new Map<string, LoadedCandidate | null>();

  const unavailable = new Set<AiSurface>();
  for (const row of await listAssignmentRows({ partnerId })) {
    const surface = row.surface as AiSurface;
    if (!row.defaultOfferingId || unavailable.has(surface)) continue;
    if (await failsResidency(partnerId, plan, surface, row.defaultOfferingId, cache)) unavailable.add(surface);
  }

  // Org overrides with their own default (Codex review finding 12): an org can
  // point a surface at a model on another connection than the partner default.
  const orgRows = await db
    .select({
      orgId: aiModelAssignments.orgId,
      orgName: organizations.name,
      surface: aiModelAssignments.surface,
      defaultOfferingId: aiModelAssignments.defaultOfferingId,
    })
    .from(aiModelAssignments)
    .leftJoin(organizations, eq(organizations.id, aiModelAssignments.orgId))
    .where(and(
      eq(aiModelAssignments.offeringPartnerId, partnerId),
      isNotNull(aiModelAssignments.orgId),
      isNotNull(aiModelAssignments.defaultOfferingId),
    ));
  const affectedOrgOverrides: AiResidencyImpactDto['affectedOrgOverrides'] = [];
  const seen = new Set<string>();
  for (const r of orgRows) {
    const surface = r.surface as AiSurface;
    const key = `${r.orgId}:${surface}`;
    if (seen.has(key)) continue;
    if (await failsResidency(partnerId, plan, surface, r.defaultOfferingId!, cache)) {
      seen.add(key);
      affectedOrgOverrides.push({ orgId: r.orgId!, orgName: r.orgName ?? null, surface });
    }
  }
  return { unavailableSurfaces: [...unavailable].sort(), affectedOrgOverrides };
}

/** Turning residency on with a non-empty impact needs acknowledgeImpact, else 409 'not_eligible' { unavailableSurfaces, affectedOrgOverrides }. */
export async function setResidencyRequired(input: { partnerId: string; required: boolean; acknowledgeImpact: boolean }):
  Promise<{ residencyRequired: boolean; impact: AiResidencyImpactDto }> {
  return inPartnerRegistryWrite(input.partnerId, 'aiModels.setResidencyRequired', 'Could not save the residency setting.', async () => {
    const impact = input.required ? await previewResidencyImpact(input.partnerId) : NO_IMPACT;
    const hasImpact = impact.unavailableSurfaces.length > 0 || impact.affectedOrgOverrides.length > 0;
    if (input.required && hasImpact && !input.acknowledgeImpact) {
      throw new RegistryWriteError(
        'Requiring residency would make some AI features unavailable.', 'not_eligible', 409,
        { unavailableSurfaces: impact.unavailableSurfaces, affectedOrgOverrides: impact.affectedOrgOverrides },
      );
    }
    // Merge one key into settings.ai, creating settings / settings.ai as needed
    // and never touching sibling keys.
    await db
      .update(partners)
      .set({
        settings: sql`COALESCE(${partners.settings}, '{}'::jsonb)
          || jsonb_build_object('ai', COALESCE(${partners.settings} -> 'ai', '{}'::jsonb)
          || jsonb_build_object('residencyRequired', ${input.required}::boolean))`,
        updatedAt: new Date(),
      })
      .where(eq(partners.id, input.partnerId));
    return { residencyRequired: input.required, impact };
  });
}
