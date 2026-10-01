/**
 * Session ⇄ model registry. A session stores the offering + options it was
 * created (or last dispatched) with; every turn re-resolves them through
 * resolveModel as a SESSION-origin request, so an offering that went
 * ineligible takes the §9.1 bounded fallback or comes back recoverable.
 * (Task 9 adds the create half.)
 */
import type { AiSurface } from '@breeze/shared';
import { readOrgPartnerId, readSessionModelRow } from './candidateLoader';
import { resolveModel, unavailableMessage, type ResolveModelResult } from './resolveModel';
import type { DispatchTransport } from './transport';

export async function resolveSessionTurn(input: {
  sessionId: string;
  surface: AiSurface;
  userId: string | null;
  maxTokens?: number;
  transport?: DispatchTransport;
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
  const requested = row.offeringId || options
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
