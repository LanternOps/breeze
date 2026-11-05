/**
 * Tool catalog W04 (#5219), Open Decision 14 — flow run ancestry for
 * everything a flow step causes.
 *
 * The runner and the flow branch of the intent release worker execute a
 * step's tool inside `withFlowExecutionContext({ runId, chainDepth })`.
 * `publishEvent` (services/eventBus.ts) stamps `metadata.flowRunId` /
 * `metadata.flowChainDepth` from the current frame, overriding whatever the
 * caller passed, so a flow → resolve_alert → alert.resolved → flow chain keeps
 * its depth through ordinary tool events, not only `flow.run.*` (quorum Q3).
 *
 * A LEAF module (node:async_hooks only): eventBus.ts is reachable from every
 * worker entrypoint.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface FlowExecutionFrame {
  readonly runId: string;
  /** 0..3 (spec §6.5 chain depth; flow_runs_chain_chk). */
  readonly chainDepth: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_FLOW_CHAIN_DEPTH = 3;

const storage = new AsyncLocalStorage<FlowExecutionFrame>();

/**
 * Runs `fn` with `frame` as the current flow execution frame. A malformed
 * frame is refused (rejected promise) rather than stamped onto events: a bad
 * ancestry is worse than none, because the event trigger trusts it to stop
 * loops.
 */
export async function withFlowExecutionContext<T>(frame: FlowExecutionFrame, fn: () => Promise<T>): Promise<T> {
  if (typeof frame.runId !== 'string' || !UUID_RE.test(frame.runId)) {
    throw new Error('withFlowExecutionContext: runId must be a uuid');
  }
  if (!Number.isInteger(frame.chainDepth) || frame.chainDepth < 0 || frame.chainDepth > MAX_FLOW_CHAIN_DEPTH) {
    throw new Error(`withFlowExecutionContext: chainDepth must be an integer 0..${MAX_FLOW_CHAIN_DEPTH}`);
  }
  return storage.run(Object.freeze({ runId: frame.runId, chainDepth: frame.chainDepth }), fn);
}

/** The frame of the flow step currently executing, if any. */
export function currentFlowExecutionFrame(): FlowExecutionFrame | undefined {
  return storage.getStore();
}
