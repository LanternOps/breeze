import { describe, expect, it, vi } from 'vitest';

// services/approvals pulls expo-secure-store transitively; stub it so the
// module evaluates in node without RN (same approach as approvalsSlice.test).
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

import { isOperatorPlanApproval, type ApprovalRequest } from '../../services/approvals';
import { groupOperatorPlanEffects, isOperatorPlanReadable } from './operatorPlanCopy';

const effect = (ordinal: number, provider: string, extra: Record<string, unknown> = {}) => ({
  ordinal,
  provider,
  toolName: 't',
  targetLabel: `Target ${ordinal}`,
  principalLabel: null,
  rendering: `Render ${ordinal}`,
  ...extra,
});

describe('isOperatorPlanApproval', () => {
  const base = { actionToolName: 'operator_plan', actionArguments: {} } as unknown as ApprovalRequest;
  it('is true only for the operator_plan tool', () => {
    expect(isOperatorPlanApproval(base)).toBe(true);
    expect(isOperatorPlanApproval({ ...base, actionToolName: 'run_script' })).toBe(false);
  });
});

describe('groupOperatorPlanEffects', () => {
  it('groups in stable provider order breeze, m365, google, keeping every effect', () => {
    const groups = groupOperatorPlanEffects({
      effects: [effect(0, 'google'), effect(1, 'm365'), effect(2, 'breeze'), effect(3, 'google')],
    });
    expect(groups).not.toBeNull();
    expect(groups!.map((g) => g.provider)).toEqual(['breeze', 'm365', 'google']);
    expect(groups![2]!.effects.map((e) => e.ordinal)).toEqual([0, 3]);
  });

  it('sorts by ordinal inside a group and does not truncate 64 effects', () => {
    const many = Array.from({ length: 64 }, (_, i) => effect(63 - i, 'm365'));
    const groups = groupOperatorPlanEffects({ effects: many })!;
    expect(groups[0]!.effects).toHaveLength(64);
    expect(groups[0]!.effects[0]!.ordinal).toBe(0);
    expect(groups[0]!.effects[63]!.ordinal).toBe(63);
  });

  it('returns null (invalid) for a malformed payload instead of a partial plan', () => {
    expect(groupOperatorPlanEffects({ effects: 'nope' })).toBeNull();
    expect(groupOperatorPlanEffects({})).toBeNull();
    expect(groupOperatorPlanEffects({ effects: [effect(0, 'm365'), { ordinal: 1 }] })).toBeNull();
    expect(groupOperatorPlanEffects({ effects: [effect(0, 'okta')] })).toBeNull();
  });

  it('returns an empty list for an empty plan', () => {
    expect(groupOperatorPlanEffects({ effects: [] })).toEqual([]);
  });
});

describe('isOperatorPlanReadable (gates Approve)', () => {
  it('is true for a fully parseable, non-empty plan', () => {
    expect(isOperatorPlanReadable({ effects: [effect(0, 'm365')] })).toBe(true);
  });

  it('is false for missing, malformed, partially-malformed, or empty plans', () => {
    expect(isOperatorPlanReadable(null)).toBe(false);
    expect(isOperatorPlanReadable(undefined)).toBe(false);
    expect(isOperatorPlanReadable({})).toBe(false);
    expect(isOperatorPlanReadable({ effects: 'nope' })).toBe(false);
    expect(isOperatorPlanReadable({ effects: [effect(0, 'm365'), { ordinal: 1 }] })).toBe(false);
    expect(isOperatorPlanReadable({ effects: [] })).toBe(false);
  });
});
