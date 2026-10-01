/**
 * Spec §9 step 2 eligibility, as a pure function over facts the candidate
 * loader read LIVE. The first failing rule wins, in the order below, so the
 * reason a caller sees is deterministic. Ownership is checked first so a
 * foreign offering is never described by any other reason.
 */
import { TOOL_REQUIRING_SURFACES, type AiSurface, type OfferingEnableBlocker } from '@breeze/shared';
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

// ── W04 (#7602): the enable-time gate ────────────────────────────────────────
// Spec §8 / §5.1 / §6: enabling re-checks offered, lifecycle, price and plan.
// It REUSES checkEligibility (one rule table) by neutralising the inputs that
// are not decided at enable time:
//   enabled            → true            (that is what we are deciding)
//   connection status  → active/usable   (transient; reported, never blocking)
//                        — EXCEPT 'disconnected' (W03 soft-disconnect, #7601):
//                        that connection is gone (keyless, never listed), not
//                        unhealthy, so its offerings are refused as
//                        connection_unavailable and can never be re-enabled.
//   tools              → supported       (decided per surface at assignment)
//   requiredPermission → null            (decided per user at dispatch)
//   residency required → false           (decided per partner at dispatch)
// `chat` is only the surface label checkEligibility needs; with supportsTools
// forced true the tools rule cannot fire for any surface.
//
// NOT neutralised (ruling BD-1): the platform-geo rule. A platform offering
// whose configured AI_PLATFORM_INFERENCE_GEO the model cannot serve can never
// dispatch on the platform key, so it must not be enableable — and the gate
// reports the true reason, `residency_unavailable`.
export interface EnableEligibilityContext {
  partnerId: string;
  partnerPlan: PartnerPlan | null;
  hosted: boolean;
}
export type EnableGateReason =
  | 'not_permitted'
  | 'model_unavailable'
  | 'unpriced'
  | 'plan_required'
  | 'residency_unavailable'
  /** Only for a disconnected connection; every other connection_unavailable cause maps to model_unavailable. */
  | 'connection_unavailable';

/** W03 soft-disconnect: the connection row is kept as provenance only (status 'disconnected'). */
export function onDisconnectedConnection(c: CandidateFacts): boolean {
  return c.connection.status === 'disconnected';
}

function neutralised(c: CandidateFacts): CandidateFacts {
  return {
    ...c,
    enabled: true,
    connection: onDisconnectedConnection(c) ? c.connection : { ...c.connection, status: 'active', keyUsable: true },
    supportsTools: true,
    requiredPermission: null,
  };
}

function enableContext(ctx: EnableEligibilityContext): EligibilityContext {
  return {
    partnerId: ctx.partnerId,
    surface: 'chat',
    partnerPlan: ctx.partnerPlan,
    hosted: ctx.hosted,
    residencyRequired: false,
    geoCarriable: true,
    userInitiated: false,
    userHoldsPermission: () => true,
  };
}

/** The enable-time gate. Returns null when the offering may be enabled. Connection health never blocks; a disconnected connection does. */
export function checkEnableEligibility(c: CandidateFacts, ctx: EnableEligibilityContext): EnableGateReason | null {
  const reason = checkEligibility(neutralised(c), enableContext(ctx));
  if (reason === null) return null;
  switch (reason) {
    case 'not_permitted':
    case 'model_unavailable':
    case 'unpriced':
    case 'plan_required':
    case 'residency_unavailable':
      return reason;
    default:
      if (onDisconnectedConnection(c)) return 'connection_unavailable';
      // Otherwise connection_unavailable can only come from a non-dispatchable
      // kind (openai_compatible before W06). Treat it as unavailable for enabling.
      return 'model_unavailable';
  }
}

/** Same rules, reporting connection health too (for the snapshot DTO's enableBlocker). */
export function enableBlockerFor(c: CandidateFacts, ctx: EnableEligibilityContext): OfferingEnableBlocker | null {
  const gate = checkEnableEligibility(c, ctx);
  if (gate === 'not_permitted') return 'model_unavailable';
  if (gate) return gate;
  if (c.connection.kind !== 'platform' && (c.connection.status !== 'active' || !c.connection.keyUsable)) {
    return 'connection_unavailable';
  }
  return null;
}
