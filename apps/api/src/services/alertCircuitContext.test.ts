import { describe, expect, it } from 'vitest';
import { resolveAlertCircuitContext, type AlertCircuitContextInput, type AlertCircuitOmitReason } from './alertCircuitContext';

const IF = '00000000-0000-4000-8000-000000000005';
const CIRCUIT = '00000000-0000-4000-8000-000000000006';

function input(overrides: Partial<AlertCircuitContextInput> = {}): AlertCircuitContextInput {
  return {
    stored: { interfaceId: IF, interfaceEpoch: 'gen:1' },
    alertOpen: true,
    currentInterface: { id: IF, epoch: 'gen:1', retiredAt: null, ownerNodeId: 'node-1' },
    ownerBound: true,
    terminations: [{ circuitId: CIRCUIT, terminationState: 'assigned' }],
    armed: { interfaceId: IF, interfaceEpoch: 'gen:1' },
    ...overrides,
  };
}

describe('resolveAlertCircuitContext', () => {
  it('resolves the exact current interface with one assigned termination', () => {
    expect(resolveAlertCircuitContext(input())).toEqual({ status: 'resolved', interfaceId: IF, circuitId: CIRCUIT });
  });

  const omitted: Array<[AlertCircuitOmitReason, Partial<AlertCircuitContextInput>]> = [
    ['no_provenance', { stored: null }],
    ['interface_missing', { currentInterface: null }],
    ['interface_retired', { currentInterface: { id: IF, epoch: 'gen:1', retiredAt: new Date(), ownerNodeId: 'node-1' } }],
    ['epoch_mismatch', { currentInterface: { id: IF, epoch: 'gen:2', retiredAt: null, ownerNodeId: 'node-1' } }],
    ['epoch_mismatch', { currentInterface: { id: 'other-interface', epoch: 'gen:1', retiredAt: null, ownerNodeId: 'node-1' } }],
    ['owner_unbound', { ownerBound: false }],
    ['termination_not_assigned', { terminations: [{ circuitId: CIRCUIT, terminationState: 'unassigned' }] }],
    ['no_termination', { terminations: [] }],
    ['ambiguous_termination', { terminations: [{ circuitId: CIRCUIT, terminationState: 'assigned' }, { circuitId: 'other', terminationState: 'assigned' }] }],
    ['termination_not_assigned', { terminations: [{ circuitId: CIRCUIT, terminationState: 'needs_reassociation' }] }],
    ['armed_context_mismatch', { armed: { interfaceId: IF, interfaceEpoch: 'gen:2' } }],
    ['armed_context_mismatch', { armed: { interfaceId: null, interfaceEpoch: null } }],
    ['armed_context_mismatch', { armed: null }],
  ];
  it.each(omitted)('omits with %s', (reason, overrides) => {
    expect(resolveAlertCircuitContext(input(overrides))).toEqual({ status: 'omitted', reason });
  });

  it('skips the armed-context check for a resolved alert', () => {
    expect(resolveAlertCircuitContext(input({ alertOpen: false, armed: null }))).toEqual({ status: 'resolved', interfaceId: IF, circuitId: CIRCUIT });
  });

  it('still enforces the other checks for a resolved alert', () => {
    expect(resolveAlertCircuitContext(input({ alertOpen: false, armed: null, ownerBound: false }))).toEqual({ status: 'omitted', reason: 'owner_unbound' });
    expect(resolveAlertCircuitContext(input({ alertOpen: false, currentInterface: null }))).toEqual({ status: 'omitted', reason: 'interface_missing' });
  });
});
