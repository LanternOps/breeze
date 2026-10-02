/**
 * The ONE place a model is chosen for a call (spec §9). Every surface calls
 * this before admission; funding, wire parameters and the rate snapshot it
 * returns are what admission, dispatch and settlement use. Nothing here
 * caches: every call re-reads assignment, offering, platform row, connection
 * and catalog revision (quorum #2, #7).
 */
import {
  AI_SURFACE_ROLES,
  type AiSurface,
  type OfferingOptions,
  type OptionSupport,
} from '@breeze/shared';
import { isHosted } from '../../config/env';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import type { AiBillingSource } from '../aiCostTracker';
import { getEffectiveAssignment, isPermitted } from './assignments';
import type { DerivedCapabilities, ThinkingMode } from './capabilities';
import {
  loadOfferingCandidate,
  loadPartnerFacts,
  loadPlatformDefaultCandidate,
  loadUserPermissionPredicate,
  type AllowedOptions,
  type LoadedCandidate,
  type ResolvedConnection,
} from './candidateLoader';
import { checkEligibility, type EligibilityContext, type ResolveFailureReason } from './eligibility';
import { ensurePartnerCutover } from './registryCutover';
import type { RateSnapshot } from './pricing';
import type { PromptProfile } from './promptProfiles';
import { defaultTransport, transportCarries, type DispatchTransport, type TransportCarriage } from './transport';
import { buildWireParams, type WireParams } from './wireParams';

export const PLATFORM_ONLY_SURFACES = ['patch_test'] as const satisfies readonly AiSurface[];
export type RequestOrigin = 'user' | 'session' | 'policy';

export interface ResolveModelInput {
  partnerId: string | null;
  orgId: string | null;
  userId?: string | null;
  surface: AiSurface;
  role?: string;
  requested?: { offeringId?: string; options?: Partial<OfferingOptions>; origin?: RequestOrigin };
  maxTokens?: number;
  transport?: DispatchTransport;
}

export interface ResolvedOffering { id: string | null; displayName: string }

export interface ResolvedRefusalFallback {
  offeringId: string;
  displayName: string;
  wireModel: string;
  wireParams: WireParams;
  options: OfferingOptions;
  rateSnapshot: RateSnapshot;
}

export interface ResolvedModel {
  ok: true;
  surface: AiSurface;
  role: string;
  transport: DispatchTransport;
  partnerId: string | null;
  orgId: string | null;
  offering: ResolvedOffering;
  connection: ResolvedConnection;
  funding: AiBillingSource;
  logicalModel: string;
  wireModel: string;
  thinking: ThinkingMode;
  wireParams: WireParams;
  options: OfferingOptions;
  inferenceGeo: string | null;
  refusalFallback?: ResolvedRefusalFallback;
  promptProfile: PromptProfile;
  rateSnapshot: RateSnapshot;
  capabilities: DerivedCapabilities;
  limits: { maxInputTokens: number | null; maxOutputTokens: number | null };
  catalogRevisionId?: string;
  configVersion?: number;
  fellBack: boolean;
}

export interface ModelUnavailable {
  ok: false;
  reason: ResolveFailureReason;
  recoverable: true;
  offeringId: string | null;
  message: string;
}

export type ResolveModelResult = ResolvedModel | ModelUnavailable;

/** Used when neither the caller nor the model states an output cap. */
const DEFAULT_MAX_TOKENS = 8192;

export function unavailableMessage(reason: ResolveFailureReason, displayName?: string): string {
  switch (reason) {
    case 'model_unavailable':
      return displayName
        ? `Model ${displayName} is no longer available — choose another.`
        : 'This AI model is no longer available. Choose another model.';
    case 'not_permitted': return 'This AI model is not available here. Choose another model.';
    case 'permission_required': return 'Your role does not allow this AI model. Choose another model.';
    case 'plan_required': return 'This AI model requires a higher plan.';
    case 'residency_unavailable': return 'No AI model is available that keeps data in the required region.';
    case 'unpriced': return 'This AI model has no price set and cannot be used yet.';
    case 'connection_unavailable':
      return 'The AI provider connection for this model is unavailable. Reconnect it under AI Providers & Models.';
    case 'tools_unsupported': return 'This AI model cannot use tools, which this feature needs.';
    case 'no_eligible_model': return 'No AI model is available for this feature. Ask an administrator to enable one.';
    case 'registry_unavailable': return 'AI configuration is being upgraded. Try again in a moment.';
  }
}

function unavailable(reason: ResolveFailureReason, offeringId: string | null, displayName?: string): ModelUnavailable {
  return { ok: false, reason, recoverable: true, offeringId, message: unavailableMessage(reason, displayName) };
}

function intersect<T>(support: readonly T[], allowed: readonly T[] | undefined): T[] {
  return allowed === undefined ? [...support] : support.filter((v) => allowed.includes(v));
}

/**
 * §7: support clamped to allowed_options; fast only where it has a rate; and
 * nothing the dispatch transport cannot carry (W01's adapters throw on it), so
 * an option is never applied — or priced — unless it will actually be sent.
 */
function clampSupport(c: LoadedCandidate, carriage: TransportCarriage): OptionSupport {
  const allowed: AllowedOptions | null = c.allowedOptions;
  return {
    effort: intersect(c.optionSupport.effort, allowed?.effort),
    thinkingDisplay: intersect(c.optionSupport.thinkingDisplay, allowed?.thinkingDisplay)
      .filter((d) => d !== 'updates' || carriage.thinkingDisplayUpdates),
    speed: intersect(c.optionSupport.speed, allowed?.speed)
      .filter((s) => s !== 'fast' || (carriage.speed && Boolean(c.optionRates?.['speed:fast']))),
    inferenceGeo: carriage.inferenceGeo ? [...c.optionSupport.inferenceGeo] : [],
  };
}

/** §7: request → assignment → offering default → omitted, per key. */
function requestedOptions(
  c: LoadedCandidate,
  fromRequest: Partial<OfferingOptions> | undefined,
  fromAssignment: Partial<OfferingOptions> | undefined,
): OfferingOptions {
  const out: Record<string, unknown> = {};
  for (const key of ['effort', 'thinkingDisplay', 'speed', 'budgetThinking'] as const) {
    const value = fromRequest?.[key] ?? fromAssignment?.[key] ?? c.defaultOptions?.[key];
    if (value !== undefined) out[key] = value;
  }
  return out as OfferingOptions;
}

function rateFor(c: LoadedCandidate, applied: OfferingOptions): RateSnapshot {
  const base = c.facts.rate!;   // callers run eligibility (rate !== null → else 'unpriced') first
  const fast = applied.speed === 'fast' ? c.optionRates?.['speed:fast'] : undefined;
  return fast ? { ...base, option: { key: 'speed:fast', rates: fast } } : base;
}

function wireFor(
  c: LoadedCandidate,
  requested: OfferingOptions,
  maxTokens: number | undefined,
  carriage: TransportCarriage,
): WireParams {
  // W05: an option is never applied — or reported as applied — unless the
  // dispatch transport will actually send it.
  const carried: OfferingOptions = carriage.budgetThinking ? requested : { ...requested, budgetThinking: undefined };
  return buildWireParams({
    thinkingMode: c.capabilities.thinkingMode,
    optionSupport: clampSupport(c, carriage),
    requested: carried,
    inferenceGeo: c.facts.inferenceGeo,
    maxTokens: maxTokens ?? c.limits.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
  });
}

function sameRates(a: RateSnapshot, b: RateSnapshot): boolean {
  return JSON.stringify([a.standard, a.option ?? null]) === JSON.stringify([b.standard, b.option ?? null]);
}

async function refusalFallbackFor(
  primary: LoadedCandidate,
  partnerId: string,
  ctx: EligibilityContext,
  maxTokens: number | undefined,
  carriage: TransportCarriage,
  transport: DispatchTransport,
  primaryRate: RateSnapshot,
): Promise<ResolvedRefusalFallback | undefined> {
  const id = primary.refusalFallbackOfferingId;
  if (!id) return undefined;
  const fb = await loadOfferingCandidate(id, partnerId);
  const sameRoute = fb !== null && fb.connectionId === primary.connectionId && fb.funding === primary.funding;
  if (!fb || !sameRoute || checkEligibility(fb.facts, ctx) !== null) {
    console.warn('[resolveModel] refusal fallback skipped (ineligible or crosses connection/funding)', {
      offeringId: primary.offeringId, fallbackOfferingId: id,
    });
    return undefined;
  }
  const wireParams = wireFor(fb, requestedOptions(fb, undefined, undefined), maxTokens, carriage);
  const fbRate = rateFor(fb, wireParams.applied);
  // Review finding 3: the Agent SDK's `fallbackModel` also fires on OVERLOAD,
  // and its per-turn usage cannot say which model served — so on the SDK
  // transport a fallback is only carried when it bills at the primary's
  // rates (then the attribution question cannot change the price). The
  // Messages API attributes per iteration/attempt, so it carries any.
  if (transport === 'agent_sdk' && !sameRates(fbRate, primaryRate)) {
    console.warn('[resolveModel] refusal fallback dropped on the Agent SDK transport: priced differently from the primary', {
      offeringId: primary.offeringId, fallbackOfferingId: id,
    });
    return undefined;
  }
  return {
    offeringId: id,
    displayName: fb.displayName,
    wireModel: fb.wireModel,
    wireParams,
    options: wireParams.applied,
    rateSnapshot: fbRate,
  };
}

async function finalize(
  c: LoadedCandidate,
  input: ResolveModelInput,
  role: string,
  assignmentOptions: Partial<OfferingOptions> | undefined,
  ctx: EligibilityContext,
  fellBack: boolean,
  transport: DispatchTransport,
): Promise<ResolveModelResult> {
  const carriage = transportCarries(transport);
  // Eligibility guarantees both; restated so the types narrow without `!` and
  // so no path can ever return ok without a connection or a bound rate.
  if (!c.facts.rate) return unavailable('unpriced', c.offeringId, c.displayName);
  if (!c.connection) return unavailable('connection_unavailable', c.offeringId, c.displayName);
  // A stored choice's options survive a fallback: clamping to the fallback
  // model's support drops anything it cannot honour.
  const requested = requestedOptions(c, input.requested?.options, assignmentOptions);
  const wireParams = wireFor(c, requested, input.maxTokens, carriage);
  const primaryRate = rateFor(c, wireParams.applied);
  const refusalFallback = input.partnerId
    ? await refusalFallbackFor(c, input.partnerId, ctx, input.maxTokens, carriage, transport, primaryRate)
    : undefined;
  return {
    ok: true,
    surface: input.surface,
    role,
    transport,
    partnerId: input.partnerId,
    orgId: input.orgId,
    offering: { id: c.offeringId, displayName: c.displayName },
    connection: c.connection,
    funding: c.funding,
    logicalModel: c.logicalModel,
    wireModel: c.wireModel,
    thinking: c.capabilities.thinkingMode,
    wireParams,
    options: wireParams.applied,
    inferenceGeo: wireParams.inferenceGeo ?? null,
    ...(refusalFallback ? { refusalFallback } : {}),
    promptProfile: c.promptProfile,
    rateSnapshot: primaryRate,
    capabilities: c.capabilities,
    limits: c.limits,
    ...(c.catalogRevisionId ? { catalogRevisionId: c.catalogRevisionId } : {}),
    ...(c.configVersion !== undefined ? { configVersion: c.configVersion } : {}),
    fellBack,
  };
}

export async function resolveModel(input: ResolveModelInput): Promise<ResolveModelResult> {
  const role = input.role ?? 'default';
  if (!(AI_SURFACE_ROLES[input.surface] as readonly string[]).includes(role)) {
    throw new Error(`'${role}' is not a role of ${input.surface}`);
  }
  const transport = input.transport ?? defaultTransport(input.surface);
  const geoCarriable = transportCarries(transport).inferenceGeo;

  // Platform-only system surfaces: no partner, no assignment, platform default.
  if ((PLATFORM_ONLY_SURFACES as readonly string[]).includes(input.surface)) {
    const ctx: EligibilityContext = {
      partnerId: null, surface: input.surface, partnerPlan: null, hosted: isHosted(),
      residencyRequired: false, geoCarriable, userInitiated: false, userHoldsPermission: () => false,
    };
    const c = await loadPlatformDefaultCandidate();
    if (!c) return unavailable('no_eligible_model', null);
    const reason = checkEligibility(c.facts, ctx);
    if (reason) return unavailable(reason, null, c.displayName);
    return finalize(c, { ...input, partnerId: null }, role, undefined, ctx, false, transport);
  }
  if (!input.partnerId) throw new Error(`${input.surface} requires a partner to resolve a model`);
  const partnerId = input.partnerId;
  // Task 6A: no registry-routed dispatch for a partner that has not been cut
  // over (projected from legacy config once, durably). Cuts it over on demand.
  if (!(await ensurePartnerCutover(partnerId))) return unavailable('registry_unavailable', null);

  // System-context read, like the loader's: getEffectiveAssignment uses the
  // ambient db, and the resolver must never hold a second pooled connection
  // under a request transaction (or read nothing under a context-less RLS one).
  const assignment = await runOutsideDbContext(() => withSystemDbAccessContext(
    () => getEffectiveAssignment({ partnerId, orgId: input.orgId, surface: input.surface, role }),
  ));

  const userInitiated = typeof input.userId === 'string' && input.userId.length > 0;
  const [partnerFacts, userHoldsPermission] = await Promise.all([
    loadPartnerFacts(partnerId),
    userInitiated
      ? loadUserPermissionPredicate(input.userId!, partnerId, input.orgId)
      : Promise.resolve((_key: string) => false),
  ]);
  const ctx: EligibilityContext = {
    partnerId,
    surface: input.surface,
    partnerPlan: partnerFacts.plan,
    hosted: isHosted(),
    residencyRequired: partnerFacts.residencyRequired,
    geoCarriable,
    userInitiated,
    userHoldsPermission,
  };

  const origin: RequestOrigin = input.requested?.origin ?? 'user';
  // W05 (spec §11): a locked surface hides the menu AND the option controls.
  // Hiding is not the gate — a user-origin request may not carry options,
  // and options stored on the session by an earlier (unlocked) turn no
  // longer apply. Agent policies (origin 'policy') are configuration, not a
  // per-turn choice, and are unaffected. A user-origin request for a
  // NON-default offering on a locked surface is refused below (W03 rule).
  const requestedOpts = input.requested?.options;
  const carriesOptions = requestedOpts !== undefined
    && Object.values(requestedOpts).some((v) => v !== undefined);
  if (!assignment.allowUserChoice && carriesOptions && origin === 'user') {
    return unavailable('not_permitted', input.requested?.offeringId ?? null);
  }
  // Every later use of the request's options goes through `effective`.
  const effective: ResolveModelInput = !assignment.allowUserChoice && carriesOptions && origin === 'session'
    ? { ...input, requested: { ...input.requested, options: undefined } }
    : input;
  const requestedId = input.requested?.offeringId;
  const defaultId = assignment.defaultOfferingId;
  const permitted = (id: string) => isPermitted(assignment.permitted, id);

  const tryDefault = async (
    stored: LoadedCandidate | null,
    storedReason: ResolveFailureReason,
  ): Promise<ResolveModelResult> => {
    const storedName = stored?.displayName;
    // A missing stored offering cannot prove its connection: never guess.
    if (!stored || !defaultId || defaultId === requestedId) return unavailable(storedReason, requestedId ?? null, storedName);
    const fallback = await loadOfferingCandidate(defaultId, partnerId);
    const sameRoute = fallback !== null
      && fallback.connectionId === stored.connectionId
      && fallback.funding === stored.funding;
    if (!fallback || !sameRoute || checkEligibility(fallback.facts, ctx) !== null) {
      return unavailable(storedReason, requestedId ?? null, storedName);
    }
    return finalize(fallback, effective, role, assignment.options, ctx, true, transport);
  };

  if (requestedId && requestedId !== defaultId) {
    const choiceAllowed = origin === 'policy' || assignment.allowUserChoice;
    if (!choiceAllowed || !permitted(requestedId)) {
      if (origin === 'user') return unavailable('not_permitted', requestedId);
      return tryDefault(await loadOfferingCandidate(requestedId, partnerId), 'not_permitted');
    }
  }

  const primaryId = requestedId ?? defaultId;
  if (!primaryId) return unavailable('no_eligible_model', null);
  const primary = await loadOfferingCandidate(primaryId, partnerId);
  const reason: ResolveFailureReason | null = primary ? checkEligibility(primary.facts, ctx) : 'not_permitted';
  if (primary && reason === null) return finalize(primary, effective, role, assignment.options, ctx, false, transport);
  if (!requestedId || origin === 'user' || requestedId === defaultId) {
    return unavailable(reason!, primaryId, primary?.displayName);
  }
  return tryDefault(primary, reason!);
}
