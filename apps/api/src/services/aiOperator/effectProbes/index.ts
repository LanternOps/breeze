/**
 * The provider-neutral effect-probe registry (Recipe Library spec §6.6,
 * wave E4 #6169).
 *
 * "There is no executor-side dedup store and neither Graph nor the Google
 * Directory API takes an idempotency key. Every effect is therefore
 * probe → write → probe."
 *
 * THE DEFAULT IS `unknown`, AND THAT IS THE DESIGN. An unregistered tool, a
 * throwing probe and a slow probe all answer `unknown`, and `unknown` can
 * never produce a verified outcome (Operator spec §13). The cost of the
 * default being `unknown` is a handoff; the cost of it being `satisfied`
 * would be telling an MSP a departed employee's access was revoked when
 * nobody looked.
 *
 * Keyed by TOOL NAME (the approved effect set and `ai_operator_operations` are
 * both keyed by tool name), never by a provider action id.
 */
import { captureException } from '../../sentry';
import type { PlannedEffect } from '../recipes/types';

export type EffectProbeState = 'satisfied' | 'unsatisfied' | 'unknown';

export interface EffectProbeResult {
  state: EffectProbeState;
  observedAt: Date;
  detail: string;
}

export interface EffectProbeContext {
  orgId: string;
  taskId: string;
  planRevision: number;
  /** When the write was (or is about to be) requested; session-style criteria compare against it. */
  effectRequestedAt: Date;
  /** `pre` decides whether to skip the write; `post` is the verification adapter. */
  phase: 'pre' | 'post';
}

export type EffectProbe = (effect: PlannedEffect, ctx: EffectProbeContext) => Promise<EffectProbeResult>;

/** The detail lands in a task event / step row / operation result. */
const MAX_PROBE_DETAIL_CHARS = 1000;

/**
 * A provider read that has not answered in 30s will not improve the decision.
 * The coordinator holds no lease-bound resource while waiting on it, but a
 * hung probe would still delay a dispatch behind a third-party outage.
 */
export const PROBE_TIMEOUT_MS = 30_000;

const PROBES = new Map<string, EffectProbe>();

export function registerEffectProbe(toolName: string, probe: EffectProbe): void {
  if (PROBES.has(toolName)) {
    // Two probes for one tool is a merge accident; whichever loaded last would
    // silently decide verification for a destructive identity effect.
    throw new Error(`effect probe for '${toolName}' is already registered`);
  }
  PROBES.set(toolName, probe);
}

export function getEffectProbe(toolName: string): EffectProbe | undefined {
  return PROBES.get(toolName);
}

export function listProbedTools(): string[] {
  return [...PROBES.keys()].sort();
}

/** Test-only. Never called from product code. */
export function __resetEffectProbesForTest(): void {
  PROBES.clear();
}

function unknown(detail: string): EffectProbeResult {
  return { state: 'unknown', observedAt: new Date(), detail: detail.slice(0, MAX_PROBE_DETAIL_CHARS) };
}

export async function probeEffect(effect: PlannedEffect, ctx: EffectProbeContext): Promise<EffectProbeResult> {
  const probe = PROBES.get(effect.toolName);
  if (!probe) {
    return unknown(
      `no verification probe is registered for '${effect.toolName}', so this effect cannot be proven; `
      + 'the task will hand off rather than report it verified',
    );
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      probe(effect, ctx),
      new Promise<EffectProbeResult>((resolve) => {
        timer = setTimeout(
          () => resolve(unknown(`verification probe for '${effect.toolName}' did not answer within ${PROBE_TIMEOUT_MS}ms`)),
          PROBE_TIMEOUT_MS,
        );
      }),
    ]);
    if (result.state !== 'satisfied' && result.state !== 'unsatisfied' && result.state !== 'unknown') {
      return unknown(`verification probe for '${effect.toolName}' returned an unrecognised state`);
    }
    return { ...result, detail: String(result.detail ?? '').slice(0, MAX_PROBE_DETAIL_CHARS) };
  } catch (err) {
    // A provider outage is not a verification failure: `unsatisfied` would say
    // "we looked and it is not done", inviting a retry of a possibly-completed
    // destructive effect.
    captureException(err instanceof Error ? err : new Error(String(err)));
    return unknown(
      `verification probe for '${effect.toolName}' failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}
