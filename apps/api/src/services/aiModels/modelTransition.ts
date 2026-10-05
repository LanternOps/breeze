/**
 * The single gate for a change of model inside one chat session (spec §9.2;
 * W05 spike constraints 1–3). It runs after resolveModel and BEFORE the
 * reservation, for a user's switch and for a §9.1 bounded fallback alike —
 * every path where the next turn's wire model may differ from the last
 * one's. Connection, config version, catalog revision and funding are never
 * crossed by a resume: that is always a continuation (a new chat seeded with
 * a summary).
 */
import { sql } from 'drizzle-orm';
import type { AiContinuationReason } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import type { AiBillingSource } from '../aiCostTracker';
import { captureException } from '../sentry';
import type { RateSnapshot } from './pricing';
import { MAX_FAILOVER_HOP } from './failover';
import type { ResolvedModel, ResolveModelResult } from './resolveModel';
import { checkTranscriptFit, defaultTranscriptFitDeps, type TranscriptFit, type TranscriptFitDeps } from './transcriptFit';
import { parseTurnBinding, type CarriedRate } from './turnBinding';

/** The messages route's reservation idempotency-key prefix (`chat:${sessionId}:${uuid}`). */
export const CHAT_TURN_KEY_PREFIX = 'chat:';

export interface PreviousTurn {
  reservationId: string;
  wireModel: string;
  connectionId: string | null;
  configVersion: number | null;
  catalogRevisionId: string | null;
  funding: AiBillingSource;
  rateSnapshot: RateSnapshot;
  carriedRates: CarriedRate[];
}

export type ModelTransition =
  | { kind: 'fresh' }
  | { kind: 'same_model'; carriedRates: CarriedRate[] }
  | { kind: 'switch_resume'; carriedRates: CarriedRate[]; fit: Extract<TranscriptFit, { kind: 'fits' }> }
  | { kind: 'continuation_required'; reason: AiContinuationReason; fit?: TranscriptFit };

function rowsOf<T>(r: unknown): T[] {
  return Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] }).rows ?? []);
}

/**
 * The last DISPATCHED CHAT TURN of a session: the newest chat-turn
 * reservation (never a ticket draft or another one-shot, which reserve on
 * the same session) that was not released unused.
 */
export async function readPreviousTurn(input: { orgId: string; sessionId: string }): Promise<PreviousTurn | null> {
  const result = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute<{ id: string; model_binding: unknown }>(sql`
    SELECT id, model_binding
    FROM ai_budget_reservations
    WHERE org_id = ${input.orgId}::uuid
      AND session_id = ${input.sessionId}::uuid
      AND starts_with(idempotency_key, ${CHAT_TURN_KEY_PREFIX})
      AND model_binding IS NOT NULL
      AND status <> 'released'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `)));
  const row = rowsOf<{ id: string; model_binding: unknown }>(result)[0];
  if (!row) return null;
  const b = parseTurnBinding(row.model_binding);
  if (!b) {
    // A binding this build cannot read (e.g. written by a newer build before a
    // rollback) reads as "no previous turn" — the switch guard agrees — but
    // it means the session's switch provenance is lost: report it.
    console.warn('[modelTransition] newest chat-turn binding does not parse; planning as if no previous turn', {
      orgId: input.orgId, sessionId: input.sessionId, reservationId: row.id,
    });
    captureException(new Error('chat-turn model binding does not parse'), undefined, {
      org_id: input.orgId, ai_reservation_id: row.id,
    });
    return null;
  }
  return {
    reservationId: row.id,
    wireModel: b.wireModel,
    connectionId: b.connectionId,
    configVersion: b.configVersion,
    catalogRevisionId: b.catalogRevisionId,
    funding: b.funding,
    rateSnapshot: b.rateSnapshot,
    carriedRates: b.carriedRates ?? [],
  };
}

/**
 * A chat turn of this session is in flight on ANY replica (its reservation is
 * still active). A reservation whose settlement was DEFERRED
 * (`pending_settlement` set by persistPendingSettlement, replayed later by the
 * sweep) stays 'active' but belongs to a FINISHED turn, so it is not in
 * flight. Same predicate as reserveAiBudget's switch guard.
 */
export async function hasActiveChatTurn(input: { orgId: string; sessionId: string }): Promise<boolean> {
  const result = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute<{ id: string }>(sql`
    SELECT id FROM ai_budget_reservations
    WHERE org_id = ${input.orgId}::uuid
      AND session_id = ${input.sessionId}::uuid
      AND starts_with(idempotency_key, ${CHAT_TURN_KEY_PREFIX})
      AND status = 'active' AND expires_at > now()
      AND pending_settlement IS NULL
    LIMIT 1
  `)));
  return rowsOf(result).length > 0;
}

/**
 * The session's CURRENT `ai_sessions.offering_id`, read fresh. The messages
 * route's preflight snapshot is taken BEFORE resolveModel's lazy partner
 * cutover stamps a pre-W03 session's offering, so planning against the
 * snapshot would refuse a plain same-offering message as fit_unverifiable.
 * Own system context, scoped by id AND org; undefined when there is no row.
 */
export async function readSessionOfferingId(input: { orgId: string; sessionId: string }): Promise<string | null | undefined> {
  const result = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute<{ offering_id: string | null }>(sql`
    SELECT offering_id FROM ai_sessions
    WHERE id = ${input.sessionId}::uuid AND org_id = ${input.orgId}::uuid
    LIMIT 1
  `)));
  const row = rowsOf<{ offering_id: string | null }>(result)[0];
  return row ? (row.offering_id ?? null) : undefined;
}

export async function planModelTransition(
  input: {
    orgId: string;
    sdkSessionId: string | null;
    /** ai_sessions.offering_id (W03 stamps it every claim; W02 backfilled live sessions). */
    sessionOfferingId: string | null;
    previous: PreviousTurn | null;
    target: ResolvedModel;
    systemPrompt: string;
    /** The user message this turn will send: counted in the fit (Codex review finding 5). */
    pendingUserTurn: string;
  },
  deps: TranscriptFitDeps = defaultTranscriptFitDeps,
): Promise<ModelTransition> {
  // Nothing persisted yet: the next query starts a fresh transcript.
  if (!input.sdkSessionId) return { kind: 'fresh' };
  const prev = input.previous;
  if (!prev) {
    // No chat-turn binding: the session predates W03's turn claim. Its stamped
    // OFFERING (not the logical model id — a BYOK and a platform offering can
    // share one, Codex review finding 1) is the only provenance; anything
    // else can't be proven same-connection, so it continues.
    return input.sessionOfferingId !== null && input.sessionOfferingId === input.target.offering.id
      ? { kind: 'same_model', carriedRates: [] }
      : { kind: 'continuation_required', reason: 'fit_unverifiable' };
  }
  const sameRoute = prev.connectionId === input.target.connection.id && prev.funding === input.target.funding;
  if (!sameRoute) return { kind: 'continuation_required', reason: 'cross_connection' };
  // Same model: W03's live-query rotation handles a config / revision change.
  if (prev.wireModel === input.target.wireModel) return { kind: 'same_model', carriedRates: prev.carriedRates };
  // A model SWITCH is resumable only within the same config_version and
  // catalog revision as well (spec §9.2, Codex review finding 8).
  const sameVersion = prev.configVersion === (input.target.configVersion ?? null)
    && prev.catalogRevisionId === (input.target.catalogRevisionId ?? null);
  if (!sameVersion) return { kind: 'continuation_required', reason: 'connection_changed' };

  const fit = await checkTranscriptFit({
    sdkSessionId: input.sdkSessionId, target: input.target, systemPrompt: input.systemPrompt,
    pendingUserTurn: input.pendingUserTurn, orgId: input.orgId,
  }, deps);
  if (fit.kind === 'fits') {
    return {
      kind: 'switch_resume',
      fit,
      carriedRates: [...prev.carriedRates, { wireModel: prev.wireModel, rateSnapshot: prev.rateSnapshot }],
    };
  }
  return {
    kind: 'continuation_required',
    reason: fit.kind === 'too_large' ? 'transcript_too_large' : 'fit_unverifiable',
    fit,
  };
}

/**
 * W09 (#7607): a resolution-time failover (the resolver walked to a backup
 * because the session's model is cooling or gone) must pass the SAME gate as
 * a user's switch. Each failover candidate is planned with W05's
 * planModelTransition; one that would need a continuation (another connection,
 * config version or catalog revision, or a transcript that does not fit) is
 * passed over by re-resolving with it excluded, so the walk moves on to the
 * next candidate — or back to a cooling primary, which never needs a
 * transition. The user's own model (`failover === null`) is planned once,
 * exactly as W05 does. If nothing else resolves, the FIRST candidate and its
 * continuation stand, so the client still offers a new chat on a working model.
 */
export async function planTransitionWithFailover(input: {
  first: ResolvedModel;
  plan: (target: ResolvedModel) => Promise<ModelTransition>;
  reResolve: (excludeOfferingIds: string[]) => Promise<ResolveModelResult>;
}): Promise<{ model: ResolvedModel; transition: ModelTransition }> {
  const firstTransition = await input.plan(input.first);
  let model = input.first;
  let transition = firstTransition;
  const excluded: string[] = [];
  for (let i = 0; i < MAX_FAILOVER_HOP && transition.kind === 'continuation_required' && model.failover !== null; i++) {
    if (!model.offering.id) break;
    excluded.push(model.offering.id);
    const next = await input.reResolve([...excluded]);
    if (!next.ok || next.offering.id === null || excluded.includes(next.offering.id)) break;
    model = next;
    transition = await input.plan(next);
    if (transition.kind !== 'continuation_required') return { model, transition };
  }
  return transition.kind === 'continuation_required'
    ? { model: input.first, transition: firstTransition }
    : { model, transition };
}

export function continuationMessage(reason: AiContinuationReason, targetName: string): string {
  const tail = 'Continue in a new chat that starts from a summary of this one.';
  switch (reason) {
    case 'cross_connection': return `${targetName} runs on a different AI connection. ${tail}`;
    case 'connection_changed': return `The AI connection changed since the last reply. ${tail}`;
    case 'transcript_too_large': return `This conversation is too long for ${targetName}. ${tail}`;
    case 'fit_unverifiable': return `Breeze couldn't confirm this conversation fits ${targetName}. ${tail}`;
  }
}
