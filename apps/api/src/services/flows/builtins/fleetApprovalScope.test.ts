import { beforeEach, describe, expect, it, vi } from 'vitest';

const check = vi.hoisted(() => vi.fn());
vi.mock('../../aiGuardrails', () => ({ checkGuardrails: check }));

import { fleetApprovalScope } from './fleetApprovalScope';
import { builtinApprovalScope } from '../validateBuiltins';

/** Tool Catalog W06 (#5221, Decision 5): the fleet step's approval scope follows the script. */
describe('fleetApprovalScope', () => {
  beforeEach(() => check.mockReset());

  it('is core run_script\'s classification of the same script', () => {
    check.mockReturnValue({ approvalScope: 'supervised' });
    expect(fleetApprovalScope({ scriptId: 's1', deviceIds: ['d1'] })).toBe('supervised');
    expect(check).toHaveBeenCalledWith('run_script', { scriptId: 's1', deviceIds: ['d1'] });
    check.mockReturnValue({ approvalScope: 'four_eyes' });
    expect(fleetApprovalScope({ scriptId: 's1', target: { type: 'all' } })).toBe('four_eyes');
    expect(check).toHaveBeenLastCalledWith('run_script', { scriptId: 's1', deviceIds: [] });
  });

  it('an unclassified answer falls back to four_eyes', () => {
    check.mockReturnValue({ approvalScope: undefined });
    expect(fleetApprovalScope({ scriptId: 's1' })).toBe('four_eyes');
  });

  it('the step pin uses it for run_script_on_targets and supervised for other Tier-3 built-ins', () => {
    check.mockReturnValue({ approvalScope: 'four_eyes' });
    expect(builtinApprovalScope('run_script_on_targets', { scriptId: 's1' })).toBe('four_eyes');
    expect(builtinApprovalScope('http_request', { method: 'POST' })).toBe('supervised');
  });
});
