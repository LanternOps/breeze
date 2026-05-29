import { describe, expect, it, vi } from 'vitest';

// expo-secure-store is pulled in transitively via the approval cache + service
// modules. Stub it so the slice file evaluates in node without RN.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

import type { ApprovalRequest } from '../services/approvals';
import reducer, {
  approve,
  clearApprovalsError,
  deny,
  fetchOne,
  hydrateFromCache,
  markExpired,
  refreshPending,
  reportSuspicious,
  setFocus,
  upsert,
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

const initial = reducer(undefined, { type: '@@INIT' });

describe('approvalsSlice — synchronous reducers', () => {
  it('setFocus updates focusId', () => {
    const s = reducer(initial, setFocus('abc'));
    expect(s.focusId).toBe('abc');
    const cleared = reducer(s, setFocus(null));
    expect(cleared.focusId).toBeNull();
  });

  it('markExpired flips status on a matching pending entry', () => {
    let s = reducer(initial, upsert(makeApproval({ id: 'a' })));
    s = reducer(s, markExpired('a'));
    expect(s.pending[0].status).toBe('expired');
  });

  it('markExpired is a no-op when id is unknown', () => {
    const s = reducer(initial, upsert(makeApproval({ id: 'a' })));
    const next = reducer(s, markExpired('does-not-exist'));
    expect(next.pending[0].status).toBe('pending');
  });

  it('upsert pushes a new approval and seeds focusId when empty', () => {
    const s = reducer(initial, upsert(makeApproval({ id: 'a' })));
    expect(s.pending).toHaveLength(1);
    expect(s.focusId).toBe('a');
  });

  it('upsert replaces an existing approval in place by id', () => {
    let s = reducer(initial, upsert(makeApproval({ id: 'a', riskTier: 'low' })));
    s = reducer(s, upsert(makeApproval({ id: 'a', riskTier: 'critical' })));
    expect(s.pending).toHaveLength(1);
    expect(s.pending[0].riskTier).toBe('critical');
  });

  it('upsert does not overwrite an explicit focusId', () => {
    let s = reducer(initial, setFocus('explicit'));
    s = reducer(s, upsert(makeApproval({ id: 'a' })));
    expect(s.focusId).toBe('explicit');
  });

  it('clearApprovalsError nulls the error field', () => {
    const dirty = { ...initial, error: 'boom' };
    const s = reducer(dirty, clearApprovalsError());
    expect(s.error).toBeNull();
  });

  it('upsert preserves the server-issued isRecursive flag round-trip', () => {
    const recursive = makeApproval({ id: 'r1', isRecursive: true });
    const normal = makeApproval({ id: 'r2', isRecursive: false });

    let s = reducer(initial, upsert(recursive));
    s = reducer(s, upsert(normal));

    const r1 = s.pending.find((a) => a.id === 'r1');
    const r2 = s.pending.find((a) => a.id === 'r2');
    expect(r1?.isRecursive).toBe(true);
    expect(r2?.isRecursive).toBe(false);
  });
});

describe('approvalsSlice — async thunk extraReducers', () => {
  it('hydrateFromCache.fulfilled seeds pending only when state is empty + not loading', () => {
    const cached = [makeApproval({ id: 'cached-1' })];
    const next = reducer(initial, {
      type: hydrateFromCache.fulfilled.type,
      payload: cached,
    });
    expect(next.pending).toHaveLength(1);
    expect(next.focusId).toBe('cached-1');
  });

  it('hydrateFromCache.fulfilled is ignored when a refresh is in flight', () => {
    const loading = { ...initial, loading: true };
    const next = reducer(loading, {
      type: hydrateFromCache.fulfilled.type,
      payload: [makeApproval({ id: 'cached-1' })],
    });
    expect(next.pending).toHaveLength(0);
  });

  it('hydrateFromCache.fulfilled is ignored when pending already has data', () => {
    const populated = reducer(initial, upsert(makeApproval({ id: 'live' })));
    const next = reducer(populated, {
      type: hydrateFromCache.fulfilled.type,
      payload: [makeApproval({ id: 'cached-1' })],
    });
    expect(next.pending).toHaveLength(1);
    expect(next.pending[0].id).toBe('live');
  });

  it('refreshPending.pending toggles loading + clears error', () => {
    const dirty = { ...initial, error: 'old' };
    const next = reducer(dirty, { type: refreshPending.pending.type });
    expect(next.loading).toBe(true);
    expect(next.error).toBeNull();
  });

  it('refreshPending.fulfilled replaces pending and seeds focusId', () => {
    const list = [makeApproval({ id: 'r-1' }), makeApproval({ id: 'r-2' })];
    const next = reducer(
      { ...initial, loading: true },
      { type: refreshPending.fulfilled.type, payload: list },
    );
    expect(next.loading).toBe(false);
    expect(next.pending).toHaveLength(2);
    expect(next.focusId).toBe('r-1');
  });

  it('refreshPending.fulfilled with an empty list nulls focusId', () => {
    const seeded = reducer(initial, upsert(makeApproval({ id: 'a' })));
    const next = reducer(seeded, {
      type: refreshPending.fulfilled.type,
      payload: [],
    });
    expect(next.pending).toHaveLength(0);
    expect(next.focusId).toBeNull();
  });

  it('refreshPending.rejected stores error.message', () => {
    const next = reducer(
      { ...initial, loading: true },
      { type: refreshPending.rejected.type, error: { message: 'network down' } },
    );
    expect(next.loading).toBe(false);
    expect(next.error).toBe('network down');
  });

  it('refreshPending.rejected falls back to a default message', () => {
    const next = reducer(
      { ...initial, loading: true },
      { type: refreshPending.rejected.type, error: {} },
    );
    expect(next.error).toBe('Failed to load approvals');
  });

  it('fetchOne.fulfilled dedups: replaces a matching id in place', () => {
    const seeded = reducer(initial, upsert(makeApproval({ id: 'a', riskTier: 'low' })));
    const next = reducer(seeded, {
      type: fetchOne.fulfilled.type,
      payload: makeApproval({ id: 'a', riskTier: 'critical' }),
    });
    expect(next.pending).toHaveLength(1);
    expect(next.pending[0].riskTier).toBe('critical');
  });

  it('fetchOne.fulfilled prepends when id is new', () => {
    const seeded = reducer(initial, upsert(makeApproval({ id: 'a' })));
    const next = reducer(seeded, {
      type: fetchOne.fulfilled.type,
      payload: makeApproval({ id: 'b' }),
    });
    expect(next.pending.map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('fetchOne.rejected with NOT_FOUND drops focus + sets a friendly error', () => {
    const seeded = { ...initial, focusId: 'a' };
    const next = reducer(seeded, {
      type: fetchOne.rejected.type,
      error: { message: 'NOT_FOUND' },
      meta: { arg: 'a' },
    });
    expect(next.focusId).toBeNull();
    expect(next.error).toBe('That approval is no longer available.');
  });

  it('fetchOne.rejected with a generic error preserves focus + surfaces the message', () => {
    const seeded = { ...initial, focusId: 'a' };
    const next = reducer(seeded, {
      type: fetchOne.rejected.type,
      error: { message: 'kaboom' },
      meta: { arg: 'b' },
    });
    expect(next.focusId).toBe('a');
    expect(next.error).toBe('kaboom');
  });

  it('approve.pending tracks decisionInFlight by id', () => {
    const next = reducer(initial, {
      type: approve.pending.type,
      meta: { arg: 'a' },
    });
    expect(next.decisionInFlight['a']).toBe('approve');
  });

  it('approve.fulfilled removes the approval and clears its in-flight flag', () => {
    let s = reducer(initial, upsert(makeApproval({ id: 'a' })));
    s = reducer(s, upsert(makeApproval({ id: 'b' })));
    s = reducer(s, { type: approve.pending.type, meta: { arg: 'a' } });
    const next = reducer(s, {
      type: approve.fulfilled.type,
      payload: makeApproval({ id: 'a', status: 'approved' }),
      meta: { arg: 'a' },
    });
    expect(next.pending.map((x) => x.id)).toEqual(['b']);
    expect(next.decisionInFlight['a']).toBeUndefined();
    // focus rolls forward to the next pending approval
    expect(next.focusId).toBe('b');
  });

  it('approve.fulfilled nulls focusId when nothing is left', () => {
    let s = reducer(initial, upsert(makeApproval({ id: 'a' })));
    s = reducer(s, { type: approve.pending.type, meta: { arg: 'a' } });
    const next = reducer(s, {
      type: approve.fulfilled.type,
      payload: makeApproval({ id: 'a', status: 'approved' }),
      meta: { arg: 'a' },
    });
    expect(next.pending).toHaveLength(0);
    expect(next.focusId).toBeNull();
  });

  it('approve.rejected clears in-flight + records error', () => {
    const seeded = {
      ...initial,
      decisionInFlight: { a: 'approve' as const },
    };
    const next = reducer(seeded, {
      type: approve.rejected.type,
      error: { message: 'cannot approve' },
      meta: { arg: 'a' },
    });
    expect(next.decisionInFlight['a']).toBeUndefined();
    expect(next.error).toBe('cannot approve');
  });

  it('deny.pending tracks decisionInFlight by id', () => {
    const next = reducer(initial, {
      type: deny.pending.type,
      meta: { arg: { id: 'a', reason: 'nope' } },
    });
    expect(next.decisionInFlight['a']).toBe('deny');
  });

  it('deny.fulfilled removes the approval + rolls focus forward', () => {
    let s = reducer(initial, upsert(makeApproval({ id: 'a' })));
    s = reducer(s, upsert(makeApproval({ id: 'b' })));
    s = reducer(s, { type: deny.pending.type, meta: { arg: { id: 'a' } } });
    const next = reducer(s, {
      type: deny.fulfilled.type,
      payload: makeApproval({ id: 'a', status: 'denied' }),
      meta: { arg: { id: 'a' } },
    });
    expect(next.pending.map((x) => x.id)).toEqual(['b']);
    expect(next.decisionInFlight['a']).toBeUndefined();
    expect(next.focusId).toBe('b');
  });

  it('deny.rejected clears in-flight + surfaces error', () => {
    const seeded = {
      ...initial,
      decisionInFlight: { a: 'deny' as const },
    };
    const next = reducer(seeded, {
      type: deny.rejected.type,
      error: { message: 'cannot deny' },
      meta: { arg: { id: 'a' } },
    });
    expect(next.decisionInFlight['a']).toBeUndefined();
    expect(next.error).toBe('cannot deny');
  });

  it('reportSuspicious.pending tracks decisionInFlight by id', () => {
    const next = reducer(initial, {
      type: reportSuspicious.pending.type,
      meta: { arg: 'a' },
    });
    expect(next.decisionInFlight['a']).toBe('deny');
  });

  it('reportSuspicious.fulfilled removes the approval + rolls focus forward', () => {
    let s = reducer(initial, upsert(makeApproval({ id: 'a' })));
    s = reducer(s, upsert(makeApproval({ id: 'b' })));
    s = reducer(s, { type: reportSuspicious.pending.type, meta: { arg: 'a' } });
    const next = reducer(s, {
      type: reportSuspicious.fulfilled.type,
      payload: { id: 'a' },
      meta: { arg: 'a' },
    });
    expect(next.pending.map((x) => x.id)).toEqual(['b']);
    expect(next.decisionInFlight['a']).toBeUndefined();
    expect(next.focusId).toBe('b');
  });

  it('reportSuspicious.fulfilled nulls focusId when nothing is left', () => {
    let s = reducer(initial, upsert(makeApproval({ id: 'a' })));
    s = reducer(s, { type: reportSuspicious.pending.type, meta: { arg: 'a' } });
    const next = reducer(s, {
      type: reportSuspicious.fulfilled.type,
      payload: { id: 'a' },
      meta: { arg: 'a' },
    });
    expect(next.pending).toHaveLength(0);
    expect(next.focusId).toBeNull();
  });

  it('reportSuspicious.rejected clears in-flight + surfaces error', () => {
    const seeded = {
      ...initial,
      decisionInFlight: { a: 'deny' as const },
    };
    const next = reducer(seeded, {
      type: reportSuspicious.rejected.type,
      error: { message: 'cannot revoke' },
      meta: { arg: 'a' },
    });
    expect(next.decisionInFlight['a']).toBeUndefined();
    expect(next.error).toBe('cannot revoke');
  });
});
