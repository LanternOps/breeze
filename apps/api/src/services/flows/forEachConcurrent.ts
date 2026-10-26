/**
 * Tool Catalog W05 (#5220), plan Task A7 / Decision 11 — bounded parallel
 * for-each.
 *
 * `concurrency > 1` is honoured only for a step whose pinned tier is ≤ 2 and
 * whose tool is not `wait`: a Tier-3 item would park for approval and a wait
 * parks the run, and parallel parking would need several live intents per
 * run and a multi-intent wake. Effective parallelism is
 * `min(forEach.concurrency, FLOW_FOREACH_MAX_PARALLEL)` per batch and every
 * unit also takes one of the process-wide slots (`acquireUnit`).
 *
 * `runForEachItems` is the coordinator — scheduling only, no run state. The
 * caller (runSlice.ts `walkForEachConcurrent`) supplies the ledger's settled
 * items, the per-launch control check and the item executor, then writes the
 * cursor and active time ONCE for the batch. It is deliberately not
 * `Promise.all(walkUnit)`: walkUnit advances the shared cursor, accumulates
 * active time and can release the lease when parking (plan quorum risk 2).
 *
 * Semantics: items start in index order; `stop` ⇒ the first failure stops new
 * launches, in-flight items finish (a call cannot be aborted); a terminal
 * failure (policy, unknown outcome) halts under `continue` too; a lost lease
 * or a refused fenced write (`stop`) halts and nothing more is written.
 * Results keep item order.
 */
import type { FlowDocumentV1, FlowValue } from '@breeze/shared';
import { flowForEachMaxParallel } from '../../config/env';
import type { FlowStepPin } from '../flowValidator';
import { acquireUnit } from './unitSemaphore';

type FlowStep = FlowDocumentV1['steps'][number];

export type ForEachItemResult =
  | { kind: 'done'; status: 'completed' | 'skipped'; output: FlowValue | null }
  /** `terminal`: the run must end whatever onFailure says (a policy failure or an unknown outcome). */
  | { kind: 'failed'; terminal: boolean }
  /** The lease was lost or a fenced write was refused: write nothing more. */
  | { kind: 'stop' };

export type ForEachHalt = 'stop' | 'cancelled' | 'failure' | 'timeout';

export function effectiveForEachConcurrency(step: FlowStep, pin: Pick<FlowStepPin, 'tier'>): number {
  const requested = step.forEach?.concurrency ?? 1;
  if (requested <= 1 || pin.tier > 2 || step.tool === 'wait') return 1;
  return Math.max(1, Math.min(requested, flowForEachMaxParallel()));
}

export async function runForEachItems(i: {
  count: number;
  parallelism: number;
  stopOnFailure: boolean;
  /** The ledger's verdict for an item already settled (resume), else null. */
  settled: (index: number) => ForEachItemResult | null;
  /** Checked before every launch: cancel, the lease, a terminal run, the active-time budget. */
  beforeLaunch: () => Promise<'ok' | Exclude<ForEachHalt, 'failure'>>;
  runItem: (index: number) => Promise<ForEachItemResult>;
  acquire?: () => Promise<() => void>;
}): Promise<{ results: Array<ForEachItemResult | null>; halted: ForEachHalt | null }> {
  const acquire = i.acquire ?? acquireUnit;
  const results: Array<ForEachItemResult | null> = Array.from({ length: i.count }, (_, k) => i.settled(k));
  const pending = results.flatMap((r, k) => (r === null ? [k] : []));
  const state: { halted: ForEachHalt | null } = { halted: null };
  const halt = (why: ForEachHalt) => { state.halted ??= why; };
  const inFlight = new Set<Promise<void>>();
  const parallelism = Math.max(1, i.parallelism);

  let next = 0;
  while (next < pending.length && state.halted === null) {
    if (inFlight.size >= parallelism) {
      await Promise.race(inFlight);
      continue;
    }
    const gate = await i.beforeLaunch();
    if (gate !== 'ok') { halt(gate); break; }
    if (state.halted !== null) break;
    const release = await acquire();
    if (state.halted !== null) { release(); break; }
    const index = pending[next++]!;
    const unit = (async () => {
      try {
        const r = await i.runItem(index);
        results[index] = r;
        if (r.kind === 'stop') halt('stop');
        else if (r.kind === 'failed' && (i.stopOnFailure || r.terminal)) halt('failure');
      } catch {
        // An executor that throws never counts as a success.
        results[index] = { kind: 'stop' };
        halt('stop');
      } finally {
        release();
      }
    })();
    const tracked: Promise<void> = unit.then(() => { inFlight.delete(tracked); });
    inFlight.add(tracked);
  }
  await Promise.all(inFlight);
  return { results, halted: state.halted };
}
