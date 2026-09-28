import { configureStore, type Middleware, type UnknownAction } from '@reduxjs/toolkit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// #4052: the critical-tier re-auth secret rides into the approve POST through a
// one-shot getter, so the plain string never lands in a dispatched action's
// `meta.arg` (where any middleware, devtools or crash breadcrumb could see it).

const { apiApproveMock, gatherApprovalProofMock } = vi.hoisted(() => ({
  apiApproveMock: vi.fn(),
  gatherApprovalProofMock: vi.fn(),
}));

vi.mock('../services/approvals', () => ({
  approveRequest: apiApproveMock,
  denyRequest: vi.fn(),
  fetchApproval: vi.fn(),
  fetchPendingApprovals: vi.fn(),
  reportSuspicious: vi.fn(),
}));
vi.mock('../services/approverDevice', () => ({ gatherApprovalProof: gatherApprovalProofMock }));
vi.mock('../services/approvalCache', () => ({
  readCachedApprovals: vi.fn(async () => []),
  writeCachedApprovals: vi.fn(async () => undefined),
  clearCachedApproval: vi.fn(async () => undefined),
}));

import reducer, { approve } from './approvalsSlice';

function makeStore(seen: UnknownAction[]) {
  const recorder: Middleware = () => (next) => (action) => {
    seen.push(action as UnknownAction);
    return next(action);
  };
  return configureStore({
    reducer: { approvals: reducer },
    middleware: (gdm) => gdm().concat(recorder),
  });
}

describe('approve thunk critical-tier re-auth (#4052)', () => {
  beforeEach(() => {
    apiApproveMock.mockReset();
    gatherApprovalProofMock.mockReset();
    apiApproveMock.mockResolvedValue({ id: 'a1', status: 'approved' });
  });

  it('passes the re-auth factor to the approve call alongside the hardware proof', async () => {
    gatherApprovalProofMock.mockResolvedValue({ sig: 'x' });
    const store = makeStore([]);
    await store
      .dispatch(approve({ id: 'a1', takeReauth: () => ({ kind: 'password', value: 'hunter2' }) }))
      .unwrap();
    expect(apiApproveMock).toHaveBeenCalledWith(
      'a1',
      { proof: { sig: 'x' }, reauth: { kind: 'password', value: 'hunter2' } },
      undefined,
    );
  });

  it('sends the re-auth factor even when the device has no hardware key', async () => {
    gatherApprovalProofMock.mockResolvedValue(null);
    const store = makeStore([]);
    await store
      .dispatch(approve({ id: 'a1', takeReauth: () => ({ kind: 'totp', value: '123456' }) }))
      .unwrap();
    expect(apiApproveMock).toHaveBeenCalledWith('a1', { reauth: { kind: 'totp', value: '123456' } }, undefined);
  });

  it('never puts the secret in a dispatched action', async () => {
    gatherApprovalProofMock.mockResolvedValue(null);
    const seen: UnknownAction[] = [];
    const store = makeStore(seen);
    await store
      .dispatch(approve({ id: 'a1', takeReauth: () => ({ kind: 'password', value: 'hunter2' }) }))
      .unwrap();
    expect(seen.length).toBeGreaterThan(0);
    for (const action of seen) {
      expect(JSON.stringify(action)).not.toContain('hunter2');
    }
  });

  it('keeps the bare-id form working with no step-up at all (unchanged)', async () => {
    gatherApprovalProofMock.mockResolvedValue(null);
    const store = makeStore([]);
    await store.dispatch(approve('a1')).unwrap();
    expect(apiApproveMock).toHaveBeenCalledWith('a1', undefined, undefined);
  });
});
