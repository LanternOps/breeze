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
import { resolveModel, unavailableMessage, type ResolvedModel, type ResolveModelResult } from './resolveModel';
import type { DispatchTransport } from './transport';

export { InvalidSessionModelError } from './invalidSessionModelError';

export async function resolveSessionTurn(input: {
  sessionId: string;
  surface: AiSurface;
  userId: string | null;
  maxTokens?: number;
  transport?: DispatchTransport;
  /** W05: the composer's choice on this message (a fresh USER request). */
  choice?: AiModelChoice;
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
    if (r.reason === 'registry_unavailable') throw new LlmUnavailableError(r.message);
    if (requested) throw new InvalidSessionModelError(r.message, r.reason);
    if (r.reason === 'connection_unavailable' && !isPlatformLlmConfigured(process.env.ANTHROPIC_API_KEY, 'agent_sdk')) {
      throw new LlmNotConfiguredError();
    }
    throw new LlmUnavailableError(r.message);
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
