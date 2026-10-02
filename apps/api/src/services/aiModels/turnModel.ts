/**
 * What actually ran a turn (W05, spike constraint 5): the served model
 * (the CLI can swap it on a refusal by itself) and the applied options
 * (fast can be silently dropped on a 429). Built from the turn's OUTCOME,
 * never from the request, and never read back from ledger rows (D13: one
 * settlement writes one row per model key, all at the same timestamp).
 */
import { and, eq } from 'drizzle-orm';
import { aiTurnModelSchema, type AiTurnModel, type OfferingOptions } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiSessions } from '../../db/schema';
import type { TurnOutcome } from './invocationUsage';
import { getPlatformModelByModelId } from './platformModels';
import type { ResolvedModel } from './resolveModel';
import type { TurnBinding } from './turnBinding';

/** Display names of a turn's bound model and its configured refusal fallback (for `turn_model`). */
export interface TurnDisplay { requestedDisplayName: string; fallbackDisplayName: string | null }

export function turnDisplayFrom(r: ResolvedModel): TurnDisplay {
  return { requestedDisplayName: r.offering.displayName, fallbackDisplayName: r.refusalFallback?.displayName ?? null };
}

/**
 * The options the turn actually ran with. `binding.options` is already the
 * APPLIED set (resolveModel strips what the transport cannot carry, e.g.
 * budget thinking on messages_api); the outcome then says whether fast was
 * really served.
 */
export function appliedOptionsOf(b: TurnBinding, outcome: TurnOutcome): OfferingOptions {
  // A fallback model answered: the primary's options say nothing true about
  // that leg (and it never ran fast), so claim none (Codex review finding 15).
  if (outcome.servedModel !== b.wireModel) return {};
  return b.options.speed === 'fast' && outcome.fastDowngraded ? { ...b.options, speed: 'standard' } : b.options;
}

async function platformDisplayName(modelId: string): Promise<string | null> {
  // getPlatformModelByModelId opens its own system transaction; leave any
  // ambient context first (the manager runs outside requests anyway).
  const row = await runOutsideDbContext(() => getPlatformModelByModelId(modelId));
  return row?.displayName ?? null;
}

export async function describeTurnModel(
  input: { binding: TurnBinding; outcome: TurnOutcome; display: TurnDisplay },
  deps: { platformDisplayName(modelId: string): Promise<string | null> } = { platformDisplayName },
): Promise<AiTurnModel> {
  const { binding, outcome, display } = input;
  const served = outcome.servedModel;
  let servedDisplayName: string;
  if (served === binding.wireModel) servedDisplayName = display.requestedDisplayName;
  else if (binding.refusalFallback && served === binding.refusalFallback.wireModel && display.fallbackDisplayName) {
    servedDisplayName = display.fallbackDisplayName;
  } else {
    // An id the binding does not know (the CLI swapped on its own): the
    // catalog name if there is one, else the id — never the requested name.
    servedDisplayName = (await deps.platformDisplayName(served).catch(() => null)) ?? served;
  }
  return {
    requestedModel: binding.wireModel,
    requestedDisplayName: display.requestedDisplayName,
    servedModel: served,
    servedDisplayName,
    fallbackUsed: outcome.fallbackUsed,
    appliedOptions: appliedOptionsOf(binding, outcome),
    fastDowngraded: outcome.fastDowngraded,
  };
}

/**
 * Persist the turn's provenance on the session so a reload shows exactly what
 * was published. System context, scoped by id AND org: the manager runs
 * outside any request (W03 settlement does the same). Throws on failure; the
 * caller reports it and never fails the turn on it.
 */
export async function persistLastTurnModel(input: { orgId: string; sessionId: string; turnModel: AiTurnModel }): Promise<void> {
  await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    await db.update(aiSessions)
      .set({ lastTurnModel: input.turnModel })
      .where(and(eq(aiSessions.id, input.sessionId), eq(aiSessions.orgId, input.orgId)));
  }, 'aiModels.persistLastTurnModel'));
}

/** The persisted provenance of a loaded session row, or null when absent / unparseable. */
export function lastTurnModelOf(session: { lastTurnModel?: unknown }): AiTurnModel | null {
  const parsed = aiTurnModelSchema.safeParse(session.lastTurnModel);
  return parsed.success ? (parsed.data as AiTurnModel) : null;
}
