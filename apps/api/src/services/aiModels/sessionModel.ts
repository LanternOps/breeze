/**
 * Session ⇄ model registry. A session stores the offering + options it was
 * created (or last dispatched) with; every turn re-resolves them through
 * resolveModel as a SESSION-origin request, so an offering that went
 * ineligible takes the §9.1 bounded fallback or comes back recoverable.
 *
 * Session CREATION (chooseSessionModel) is the other half: a requested
 * offering is a fresh USER choice, so it is strict — no fallback, and an
 * ineligible / foreign / not-permitted id is a 400 that stores nothing.
 */
import type { AiModelChoice, AiSurface, OfferingOptions } from '@breeze/shared';
import type { AiBillingSource } from '../aiCostTracker';
import { isPlatformLlmConfigured, LlmNotConfiguredError } from '../llm/llmAvailability';
import { LlmUnavailableError } from '../llm/llmUnavailableError';
import { readOrgPartnerId, readSessionModelRow } from './candidateLoader';
import { InvalidSessionModelError } from './invalidSessionModelError';
import type { ProviderFailureCause } from './failover';
import { resolveModel, unavailableMessage, type FailoverOrigin, type ResolvedModel, type ResolveModelResult } from './resolveModel';
import { defaultTransport, type DispatchTransport } from './transport';

export { InvalidSessionModelError } from './invalidSessionModelError';

export async function resolveSessionTurn(input: {
  sessionId: string;
  surface: AiSurface;
  userId: string | null;
  maxTokens?: number;
  transport?: DispatchTransport;
  /** W05: the composer's choice on this message (a fresh USER request). */
  choice?: AiModelChoice;
  /** W09 (#7607): a dispatch failover's re-resolution (ticket draft): what was tried, why, and the first hop. */
  excludeOfferingIds?: readonly string[];
  failoverCause?: ProviderFailureCause;
  failoverOrigin?: FailoverOrigin;
}): Promise<ResolveModelResult> {
  const row = await readSessionModelRow(input.sessionId);
  if (!row) throw new Error(`AI session ${input.sessionId} not found`);
  const partnerId = await readOrgPartnerId(row.orgId);
  if (!partnerId) {
    return {
      ok: false, reason: 'no_eligible_model', recoverable: true, offeringId: null,
      message: unavailableMessage('no_eligible_model'),
    };
  }
  const options = row.options;
  // W05: a composer choice is a fresh USER request — strict (no bounded
  // fallback), subject to allow_user_choice and the permitted set. Without
  // one, the stored offering + options are a SESSION request (W03).
  const requested = input.choice
    ? {
        offeringId: input.choice.offeringId,
        ...(input.choice.options ? { options: input.choice.options } : {}),
        origin: 'user' as const,
      }
    : row.offeringId || options
      ? {
          ...(row.offeringId ? { offeringId: row.offeringId } : {}),
          ...(options ? { options } : {}),
          origin: 'session' as const,
        }
      : undefined;
  return resolveModel({
    partnerId,
    orgId: row.orgId,
    userId: input.userId,
    surface: input.surface,
    ...(requested ? { requested } : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    ...(input.transport ? { transport: input.transport } : {}),
    // W09 (D5): a resumed SDK session with history may fail over only within
    // its connection: a cross-connection resume is W05's continuation, never a
    // silent failover. A Messages API one-shot (ticket draft) sends its
    // transcript explicitly, so it may cross. The chat route additionally
    // runs every failover candidate through W05's planModelTransition.
    ...((input.transport ?? defaultTransport(input.surface)) === 'agent_sdk' && (row.turnCount > 0 || row.sdkSessionId !== null)
      ? { sameConnectionOnly: true }
      : {}),
    ...(input.excludeOfferingIds ? { excludeOfferingIds: input.excludeOfferingIds } : {}),
    ...(input.failoverCause ? { failoverCause: input.failoverCause } : {}),
    ...(input.failoverOrigin ? { failoverOrigin: input.failoverOrigin } : {}),
  });
}

export interface SessionModelChoice {
  resolved: ResolvedModel;
  offeringId: string | null;
  offeringPartnerId: string;
  /** What the USER asked for; null = follow the assignment on every turn. */
  options: Partial<OfferingOptions> | null;
  /** Provenance snapshot (= resolved.logicalModel); routing reads offering_id. */
  model: string;
  billingSource: AiBillingSource;
}

/**
 * Session creation (spec §12 "Cost abuse": replaces the free-form session
 * model). A requested offering is a fresh USER choice: strict, no fallback.
 * The resolver's refusal carries no detail about an offering the partner does
 * not own (it is simply `not_permitted`), and the caller stores nothing.
 */
export async function chooseSessionModel(input: {
  partnerId: string;
  orgId: string;
  userId: string | null;
  surface: AiSurface;
  offeringId?: string;
  options?: Partial<OfferingOptions>;
}): Promise<SessionModelChoice> {
  const offeringId = input.offeringId;
  const requested = offeringId || input.options
    ? { ...(offeringId ? { offeringId } : {}), ...(input.options ? { options: input.options } : {}), origin: 'user' as const }
    : undefined;
  const r = await resolveModel({
    partnerId: input.partnerId, orgId: input.orgId, userId: input.userId, surface: input.surface,
    ...(requested ? { requested } : {}),
  });
  if (!r.ok) {
    // A cutover in progress is transient for every caller: retryable 503, never a 400.
    if (r.reason === 'registry_unavailable') throw new LlmUnavailableError(r.message, r.reason);
    if (requested) throw new InvalidSessionModelError(r.message, r.reason);
    if (r.reason === 'connection_unavailable' && !isPlatformLlmConfigured(process.env.ANTHROPIC_API_KEY, 'agent_sdk')) {
      throw new LlmNotConfiguredError();
    }
    // #7793: carry the reason so a route can show the resolver's text (e.g.
    // "cannot use tools") instead of a bare `ai_unavailable`.
    throw new LlmUnavailableError(r.message, r.reason);
  }
  return {
    resolved: r,
    offeringId: r.offering.id,
    offeringPartnerId: input.partnerId,
    options: input.options ?? null,
    model: r.logicalModel,
    billingSource: r.funding,
  };
}
