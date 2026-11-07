/**
 * Pure resolver: which single circuit, if any, may be shown as the context of a
 * topology alert. Spec: docs/superpowers/specs/monitoring/2026-10-07-physical-placement-circuits-design.md
 *   §5.4 (derived termination state), §6.4 / D13 (interface lifecycle), §7.2 (site visibility).
 *
 * No I/O: the caller loads the plain data below. Anything uncertain is omitted
 * (never guessed, never "most likely"). The result carries ids only; display
 * data (provider, CID, site names) is loaded separately and must apply §7.2.
 */

import type { TerminationState } from './circuits';

export type AlertCircuitOmitReason =
  | 'no_provenance'
  | 'interface_missing'
  | 'interface_retired'
  | 'epoch_mismatch'
  | 'owner_unbound'
  | 'no_termination'
  | 'ambiguous_termination'
  | 'termination_not_assigned'
  | 'armed_context_mismatch';

export type AlertCircuitContext =
  | { status: 'resolved'; interfaceId: string; circuitId: string }
  | { status: 'omitted'; reason: AlertCircuitOmitReason };

export interface AlertCircuitContextInput {
  /** `alerts.context.interface` as stored at open; null when the alert has none. */
  stored: { interfaceId: string; interfaceEpoch: string } | null;
  /** Open (active/acknowledged/suppressed) alerts are also checked against the armed routing context. */
  alertOpen: boolean;
  /** The interface row with `stored.interfaceId` today; null when it no longer exists. */
  currentInterface: { id: string; epoch: string; retiredAt: Date | null; ownerNodeId: string } | null;
  /** The node `currentInterface.ownerNodeId` has at least one topology_node_bindings row; the caller must compute it for that node. */
  ownerBound: boolean;
  /** Terminations on that interface with the §5.4 derived state (see `circuits.ts`). */
  terminations: Array<{ circuitId: string; terminationState: TerminationState }>;
  /** The pair's currently armed routing context; only consulted for open alerts. */
  armed: { interfaceId: string | null; interfaceEpoch: string | null } | null;
}

const omit = (reason: AlertCircuitOmitReason): AlertCircuitContext => ({ status: 'omitted', reason });

/**
 * D13 / §6.4: an interface removed by coalescing is gone (missing) or retired.
 * Current rule is to omit; the successor is NOT followed. A future "follow the
 * proven successor" change is an edit to this one predicate/its call site.
 */
function interfaceGone(row: AlertCircuitContextInput['currentInterface']): AlertCircuitOmitReason | null {
  if (!row) return 'interface_missing';
  if (row.retiredAt) return 'interface_retired';
  return null;
}

export function resolveAlertCircuitContext(input: AlertCircuitContextInput): AlertCircuitContext {
  const { stored, currentInterface } = input;
  if (!stored) return omit('no_provenance');

  const gone = interfaceGone(currentInterface);
  if (gone) return omit(gone);
  // interfaceGone() guarantees a non-null row here.
  if (!currentInterface || currentInterface.id !== stored.interfaceId || currentInterface.epoch !== stored.interfaceEpoch) return omit('epoch_mismatch');
  if (!input.ownerBound) return omit('owner_unbound');

  if (input.terminations.length === 0) return omit('no_termination');
  if (input.terminations.length > 1) return omit('ambiguous_termination');
  const [termination] = input.terminations;
  if (!termination || termination.terminationState !== 'assigned') return omit('termination_not_assigned');

  if (input.alertOpen) {
    const armed = input.armed;
    if (!armed || armed.interfaceId !== stored.interfaceId || armed.interfaceEpoch !== stored.interfaceEpoch) return omit('armed_context_mismatch');
  }
  return { status: 'resolved', interfaceId: stored.interfaceId, circuitId: termination.circuitId };
}
