import { describe, it, expect, vi } from 'vitest';
const evaluate = vi.hoisted(() => vi.fn());
const partnerIdForDeviceMock = vi.hoisted(() => vi.fn());
const modeFunc = vi.hoisted(() => vi.fn());
const unresolvedPartnerDecisionMock = vi.hoisted(() => vi.fn());
vi.mock('./partnerTrust', () => ({
  evaluateCapability: evaluate,
  partnerIdForDevice: partnerIdForDeviceMock,
  isLifecycleCommand: (t: string) => t === 'self_uninstall',
  unresolvedPartnerDecision: unresolvedPartnerDecisionMock,
}));
vi.mock('../config/partnerTrustMode', () => ({ partnerTrustMode: modeFunc }));
import { assertDeviceExecuteAllowed, TrustDeniedError } from './partnerTrust.commands';

describe('assertDeviceExecuteAllowed', () => {
  it('throws TrustDeniedError on deny', async () => {
    modeFunc.mockReturnValueOnce('enforce');
    partnerIdForDeviceMock.mockResolvedValueOnce('p1');
    evaluate.mockResolvedValueOnce({ allow: false, code: 'TRUST_PROBATION', capability: 'device_execute', reason: 'probation_default_deny' });
    await expect(assertDeviceExecuteAllowed('d1', 'script', 'u1')).rejects.toBeInstanceOf(TrustDeniedError);
  });
  it('returns on allow', async () => {
    modeFunc.mockReturnValueOnce('enforce');
    partnerIdForDeviceMock.mockResolvedValueOnce('p1');
    evaluate.mockResolvedValueOnce({ allow: true });
    await expect(assertDeviceExecuteAllowed('d1', 'script', 'u1')).resolves.toBeUndefined();
  });
  it('skips the lookup entirely for lifecycle commands', async () => {
    modeFunc.mockReturnValueOnce('enforce');
    evaluate.mockClear();
    partnerIdForDeviceMock.mockClear();
    await assertDeviceExecuteAllowed('d1', 'self_uninstall');
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('returns early when partnerTrustMode is off without calling DB', async () => {
    modeFunc.mockReturnValueOnce('off');
    partnerIdForDeviceMock.mockClear();
    evaluate.mockClear();
    await assertDeviceExecuteAllowed('d1', 'script', 'u1');
    expect(partnerIdForDeviceMock).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('throws TrustDeniedError when the device partner cannot be resolved under enforce', async () => {
    modeFunc.mockReturnValueOnce('enforce');
    partnerIdForDeviceMock.mockResolvedValueOnce(null);
    unresolvedPartnerDecisionMock.mockResolvedValueOnce({
      allow: false, code: 'TRUST_RESTRICTED', capability: 'device_execute', reason: 'partner_unresolved',
    });
    await expect(assertDeviceExecuteAllowed('d1', 'script', 'u1')).rejects.toBeInstanceOf(TrustDeniedError);
    expect(unresolvedPartnerDecisionMock).toHaveBeenCalledWith('device_execute');
  });
  it('allows when the device partner cannot be resolved under shadow', async () => {
    modeFunc.mockReturnValueOnce('shadow');
    partnerIdForDeviceMock.mockResolvedValueOnce(null);
    unresolvedPartnerDecisionMock.mockResolvedValueOnce({ allow: true });
    await expect(assertDeviceExecuteAllowed('d1', 'script', 'u1')).resolves.toBeUndefined();
    expect(unresolvedPartnerDecisionMock).toHaveBeenCalledWith('device_execute');
  });
});
