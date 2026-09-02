import { describe, it, expect, vi } from 'vitest';
const evaluate = vi.hoisted(() => vi.fn());
vi.mock('./partnerTrust', () => ({ evaluateCapability: evaluate, partnerIdForDevice: async () => 'p1', isLifecycleCommand: (t: string) => t === 'self_uninstall' }));
import { assertDeviceExecuteAllowed, TrustDeniedError } from './partnerTrust.commands';

it('throws TrustDeniedError on deny', async () => {
  evaluate.mockResolvedValueOnce({ allow: false, code: 'TRUST_PROBATION', capability: 'device_execute', reason: 'probation_default_deny' });
  await expect(assertDeviceExecuteAllowed('d1', 'script', 'u1')).rejects.toBeInstanceOf(TrustDeniedError);
});
it('returns on allow', async () => {
  evaluate.mockResolvedValueOnce({ allow: true });
  await expect(assertDeviceExecuteAllowed('d1', 'script', 'u1')).resolves.toBeUndefined();
});
it('skips the lookup entirely for lifecycle commands', async () => {
  evaluate.mockClear();
  await assertDeviceExecuteAllowed('d1', 'self_uninstall');
  expect(evaluate).not.toHaveBeenCalled();
});
