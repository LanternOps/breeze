import { describe, it, expect, vi, beforeEach } from 'vitest';

const getApprovalAssertion = vi.fn();
const runAction = vi.fn();
vi.mock('../stores/authenticator', () => ({
  getApprovalAssertion: (...args: unknown[]) => getApprovalAssertion(...args),
}));
vi.mock('./runAction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runAction')>();
  return { ...actual, runAction: (...args: unknown[]) => runAction(...args) };
});
vi.mock('../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import { decideIntentApproval } from './intentApprovals';

const PROOF = { type: 'webauthn_platform', credentialId: 'c1' };

beforeEach(() => {
  vi.clearAllMocks();
  runAction.mockResolvedValue(undefined);
});

describe('decideIntentApproval', () => {
  it('approve: runs the assertion ceremony against /mobile/approvals and POSTs the proof', async () => {
    getApprovalAssertion.mockResolvedValue(PROOF);
    const outcome = await decideIntentApproval('ap-1', 'approve');
    expect(outcome).toBe('decided');
    expect(getApprovalAssertion).toHaveBeenCalledWith('/mobile/approvals', 'ap-1');
    expect(runAction).toHaveBeenCalledTimes(1);
  });

  it('approve: returns needs_device (no POST) when no approver device is registered', async () => {
    const err = new Error('No registered approver device');
    err.name = 'NoApproverDeviceError';
    getApprovalAssertion.mockRejectedValue(err);
    const outcome = await decideIntentApproval('ap-1', 'approve');
    expect(outcome).toBe('needs_device');
    expect(runAction).not.toHaveBeenCalled();
  });

  it('approve: rethrows a cancelled/failed ceremony without POSTing', async () => {
    getApprovalAssertion.mockRejectedValue(new DOMException('cancelled', 'NotAllowedError'));
    await expect(decideIntentApproval('ap-1', 'approve')).rejects.toBeInstanceOf(DOMException);
    expect(runAction).not.toHaveBeenCalled();
  });

  it('deny: POSTs without any ceremony', async () => {
    const outcome = await decideIntentApproval('ap-1', 'deny');
    expect(outcome).toBe('decided');
    expect(getApprovalAssertion).not.toHaveBeenCalled();
    expect(runAction).toHaveBeenCalledTimes(1);
  });
});
