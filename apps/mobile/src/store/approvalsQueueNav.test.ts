import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

import type { ApprovalRequest } from '../services/approvals';
import reducer, {
  deferFocused,
  deny,
  focusNext,
  focusPrev,
  refreshPending,
  setFocus,
} from './approvalsSlice';

function makeApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'req-1',
    requestingClientLabel: 'Claude Web',
    requestingMachineLabel: null,
    actionLabel: 'Restart agent on box-1',
    actionToolName: 'restart_agent',
    actionArguments: {},
    riskTier: 'medium',
    riskSummary: 'Will reboot the agent service',
    customerTenant: null,
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    decidedAt: null,
    decisionReason: null,
    isRecursive: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// #6212: navigate between / defer pending approvals in the takeover.
describe('approvalsSlice — navigating and deferring pending approvals (#6212)', () => {
  const seed = (ids: string[], focusId: string | null, deferredIds: string[] = []) => ({
    ...reducer(undefined, { type: '@@init' }),
    pending: ids.map((id) => makeApproval({ id })),
    focusId,
    deferredIds,
  });

  it('focusNext / focusPrev walk pending and wrap around', () => {
    expect(reducer(seed(['a', 'b', 'c'], 'a'), focusNext()).focusId).toBe('b');
    expect(reducer(seed(['a', 'b', 'c'], 'c'), focusNext()).focusId).toBe('a');
    expect(reducer(seed(['a', 'b', 'c'], 'a'), focusPrev()).focusId).toBe('c');
    expect(reducer(seed(['a', 'b', 'c'], 'b'), focusPrev()).focusId).toBe('a');
  });

  it('focusNext skips non-pending rows and is a no-op with a single pending row', () => {
    const s = seed(['a', 'b', 'c'], 'a');
    s.pending[1].status = 'expired';
    expect(reducer(s, focusNext()).focusId).toBe('c');
    expect(reducer(seed(['a'], 'a'), focusNext()).focusId).toBe('a');
  });

  it('navigating onto a deferred approval clears its deferral', () => {
    const next = reducer(seed(['a', 'b'], 'a', ['b']), focusNext());
    expect(next.focusId).toBe('b');
    expect(next.deferredIds).toEqual([]);
  });

  it('deferFocused hides the focused row and advances to the next non-deferred one', () => {
    const next = reducer(seed(['a', 'b', 'c'], 'a', ['b']), deferFocused());
    expect(next.deferredIds).toEqual(['b', 'a']);
    expect(next.focusId).toBe('c');
    expect(next.pending.map((p) => p.id)).toEqual(['a', 'b', 'c']); // still listed
  });

  it('deferFocused is a no-op when the focused row is the only non-deferred one', () => {
    const s = seed(['a', 'b'], 'a', ['b']);
    expect(reducer(s, deferFocused())).toEqual(s);
    const single = seed(['a'], 'a');
    expect(reducer(single, deferFocused())).toEqual(single);
  });

  it('a deferred approval resurfaces when it becomes the only one left', () => {
    const s = seed(['a', 'b'], 'b', ['a']);
    const next = reducer(s, deny.fulfilled(makeApproval({ id: 'b', status: 'denied' }), 'r', { id: 'b' }));
    expect(next.focusId).toBe('a');
    expect(next.deferredIds).toEqual([]);
  });

  it('decision refocus prefers a non-deferred approval over a deferred one', () => {
    const s = seed(['a', 'b', 'c'], 'c', ['a']);
    const next = reducer(s, deny.fulfilled(makeApproval({ id: 'c', status: 'denied' }), 'r', { id: 'c' }));
    expect(next.focusId).toBe('b');
  });

  it('setFocus (e.g. a push tap) on a deferred approval brings it back', () => {
    const next = reducer(seed(['a', 'b'], 'a', ['b']), setFocus('b'));
    expect(next.focusId).toBe('b');
    expect(next.deferredIds).toEqual([]);
  });

  it('refreshPending drops deferrals for rows that are gone', () => {
    const next = reducer(seed(['a', 'b'], 'a', ['b']), refreshPending.fulfilled([makeApproval({ id: 'a' })], 'r'));
    expect(next.deferredIds).toEqual([]);
  });
});
