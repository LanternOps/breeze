/**
 * The durable dispatch intent shared by the accepting request path and the
 * worker that acts on it.
 *
 * Deliberately a dependency-free leaf: `diagnosticDispatch.ts` sits inside
 * `commandDispatch.ts`'s import closure, so it must not reach the request-side
 * modules (`access.ts`, `middleware/auth.ts`, the flag reader) that
 * `diagnosticRuns.ts` needs.
 */

/**
 * Outbox kind for a run's dispatch intent. Like the template application
 * journal it is inserted already `delivered_at`-stamped, so the unrelated
 * legacy graph replay stream never sees it; this feature's own worker selects
 * on `event_kind` instead.
 */
export const TOPOLOGY_DIAGNOSTIC_INTENT_EVENT = 'diagnostic.dispatch';

/** Intent lifecycle inside the outbox payload, advanced only by the worker. */
export type TopologyDiagnosticIntentState =
  | 'pending'
  | 'dispatched'
  | 'cancelling'
  | 'cancel_sent'
  | 'settled';

export type TopologyDiagnosticIntent = {
  version: 1;
  kind: typeof TOPOLOGY_DIAGNOSTIC_INTENT_EVENT;
  runId: string;
  requesterId: string;
  deviceId: string;
  state: TopologyDiagnosticIntentState;
};
