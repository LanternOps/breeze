import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ trust: vi.fn(), active: vi.fn(), propagate: vi.fn() }));
vi.mock('./partnerTrust.commands', () => ({ createDeviceExecuteBatchGate: () => mocks.trust, TrustDeniedError: class extends Error {} }));
vi.mock('./commandCancelPropagation', () => ({ propagateCancelledDeviceCommands: (...a: unknown[]) => mocks.propagate(...a) }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
import { partitionClaimable, TEARDOWN_CLAIM_EXEMPT_TYPES } from './commandClaimEligibility';
const tx = {
  update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: 'release' }] }) }) }),
  transaction: async (fn: (sp: unknown) => unknown) => fn({ execute: mocks.active }),
} as never;
const baseDevice = { id: 'device', orgId: 'org', status: 'online', orgType: 'customer', installIncarnation: 1 };
const baseRow = { id: 'release', type: 'release_containment', payload: { isolationId: 'episode', generation: 2, reason: 'Operator release' }, createdBy: 'requester', deviceIncarnation: 1, submittedOrgId: 'org', deliverBy: new Date(Date.now() + 3600_000) };
beforeEach(() => { vi.clearAllMocks(); mocks.trust.mockRejectedValue(new Error('trust unavailable')); mocks.active.mockResolvedValue([{ active: false }]); });
describe('release containment claim exemption', () => {
  it.each(['requester_deactivated','org_drift','erased_org','quarantined','restricted_partner'])('delivers under %s', async gate => {
    const device = { ...baseDevice, ...(gate === 'quarantined' ? { status: 'quarantined' } : {}) };
    const row = { ...baseRow, ...(gate === 'org_drift' ? { submittedOrgId: 'old-org' } : {}), ...(gate === 'erased_org' ? { submittedOrgId: null } : {}) };
    const result = await partitionClaimable(tx, device, [row]);
    expect(result.claimable).toEqual([row]); expect(result.cancelled).toEqual([]); expect(result.held).toEqual([]);
    expect(mocks.trust).not.toHaveBeenCalled(); expect(mocks.active).not.toHaveBeenCalled();
  });
  it('still cancels release while the device is parked', async () => {
    const result = await partitionClaimable(tx, { ...baseDevice, orgType: 'unassigned_pool' }, [baseRow]);
    expect(result.cancelled).toEqual([{ id: 'release', reason: 'device_pending_assignment' }]);
  });
  it('exempts only release, never execute_containment', () => {
    expect(TEARDOWN_CLAIM_EXEMPT_TYPES.has('release_containment')).toBe(true);
    expect(TEARDOWN_CLAIM_EXEMPT_TYPES.has('execute_containment')).toBe(false);
  });
});
