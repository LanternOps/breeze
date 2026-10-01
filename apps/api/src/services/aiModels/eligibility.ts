/**
 * Spec §9 step 2 eligibility, as a pure function over facts the candidate
 * loader read LIVE. The first failing rule wins, in the order below, so the
 * reason a caller sees is deterministic. Ownership is checked first so a
 * foreign offering is never described by any other reason.
 */
import { TOOL_REQUIRING_SURFACES, type AiSurface } from '@breeze/shared';
import type { RateSnapshot } from './pricing';

/** Ascending. Pinned to planTypeEnum by eligibility.test.ts. */
export const PARTNER_PLAN_ORDER = ['free', 'starter', 'community', 'pro', 'enterprise', 'unlimited'] as const;
export type PartnerPlan = (typeof PARTNER_PLAN_ORDER)[number];

export function planSatisfies(plan: PartnerPlan, minPlan: PartnerPlan | null): boolean {
  if (minPlan === null) return true;
  return PARTNER_PLAN_ORDER.indexOf(plan) >= PARTNER_PLAN_ORDER.indexOf(minPlan);
}

export type ResolveFailureReason =
  | 'no_eligible_model'
  | 'not_permitted'
  | 'permission_required'
  | 'plan_required'
  | 'residency_unavailable'
  | 'unpriced'
  | 'connection_unavailable'
  | 'model_unavailable'
  | 'tools_unsupported'
  /** Task 6A: the partner has not been cut over to the registry yet and could not be now. */
  | 'registry_unavailable';

export type ConnectionKind = 'platform' | 'anthropic_byok' | 'catalog' | 'openai_compatible';

/** v1 dispatches these. openai_compatible arrives in W06, cloud kinds in W07. */
const DISPATCHABLE_KINDS: ReadonlySet<ConnectionKind> = new Set(['platform', 'anthropic_byok', 'catalog']);

export interface CandidateFacts {
  ownerPartnerId: string | null;
  enabled: boolean;
  lifecycle: 'available' | 'missing' | 'retired';
  requiredPermission: string | null;
  platform: {
    platformOffered: boolean;
    lifecycle: 'available' | 'missing' | 'retired';
    minPlan: PartnerPlan | null;
  } | null;
  connection: { kind: ConnectionKind; status: string; keyUsable: boolean };
  catalog: { usable: boolean } | null;
  rate: RateSnapshot | null;
  supportsTools: boolean;
  inferenceGeo: string | null;
  supportedInferenceGeos: readonly string[];
}

export interface EligibilityContext {
  partnerId: string | null;
  surface: AiSurface;
  partnerPlan: PartnerPlan | null;
  hosted: boolean;
  residencyRequired: boolean;
  geoCarriable: boolean;
  userInitiated: boolean;
  userHoldsPermission: (permissionKey: string) => boolean;
}

export function checkEligibility(c: CandidateFacts, ctx: EligibilityContext): ResolveFailureReason | null {
  if (c.ownerPartnerId !== ctx.partnerId) return 'not_permitted';
  if (!c.enabled || c.lifecycle !== 'available') return 'model_unavailable';
  if (c.platform && (!c.platform.platformOffered || c.platform.lifecycle !== 'available')) {
    return 'model_unavailable';
  }
  if (!DISPATCHABLE_KINDS.has(c.connection.kind)) return 'connection_unavailable';
  if (c.connection.status !== 'active' || !c.connection.keyUsable) return 'connection_unavailable';
  if (c.connection.kind === 'catalog' && !c.catalog?.usable) return 'model_unavailable';
  if (c.rate === null) return 'unpriced';
  if ((TOOL_REQUIRING_SURFACES as readonly string[]).includes(ctx.surface) && !c.supportsTools) {
    return 'tools_unsupported';
  }
  if (ctx.userInitiated && c.requiredPermission && !ctx.userHoldsPermission(c.requiredPermission)) {
    return 'permission_required';
  }
  // Hosted plan gate on PLATFORM-funded models only: a BYOK partner pays the
  // provider directly, so a Breeze plan cannot gate their own key.
  if (ctx.hosted && c.platform && ctx.partnerPlan !== null && !planSatisfies(ctx.partnerPlan, c.platform.minPlan)) {
    return 'plan_required';
  }
  // Residency fails CLOSED: required + no geography, or a geography the model
  // cannot honour, is ineligible — never silently sent elsewhere (§7, §12).
  if (ctx.residencyRequired) {
    if (!ctx.geoCarriable || c.inferenceGeo === null || !c.supportedInferenceGeos.includes(c.inferenceGeo)) {
      return 'residency_unavailable';
    }
  }
  // Platform key (W01 D3): a configured platform geography the key cannot
  // serve (e.g. `eu`, which the API rejects with HTTP 400) fails closed even
  // when residency is not required: never a provider 400 at dispatch and
  // never a silent drop to the provider default. Connection offerings keep
  // spec §7's rule (an unlisted geography is simply not sent) because their
  // supported list is the model's, not a property of the key.
  if (
    c.connection.kind === 'platform'
    && c.inferenceGeo !== null
    && !c.supportedInferenceGeos.includes(c.inferenceGeo)
  ) {
    return 'residency_unavailable';
  }
  return null;
}
