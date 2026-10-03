import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The heartbeat claim checks partner trust for every queued command while it
 * holds its claim transaction's pooled connection. The batch gate must never
 * reach the system-context readers in `partnerTrust.repo` (each of those
 * borrows a SECOND pooled connection), and must defer the denial audit write
 * until the caller's transaction has settled.
 */

const { audit, tryAutoPromote, afterExit, repo, modeFn } = vi.hoisted(() => ({
  audit: vi.fn(async () => {}),
  tryAutoPromote: vi.fn(async () => false),
  afterExit: vi.fn(),
  repo: {
    readTrust: vi.fn(),
    writeTrust: vi.fn(),
    partnerForDevice: vi.fn(),
    partnerForOrg: vi.fn(),
  },
  modeFn: vi.fn(() => 'enforce'),
}));

vi.mock('./auditService', () => ({ createAuditLog: audit }));
vi.mock('./redis', () => ({ getRedis: vi.fn(() => null) }));
vi.mock('../config/partnerTrustMode', () => ({ partnerTrustMode: modeFn }));
vi.mock('../db', () => ({
  db: {},
  withSystemDbAccessContext: vi.fn(),
  runOutsideDbContext: vi.fn(),
  runAfterDbContextExit: afterExit,
}));
vi.mock('./partnerTrust.repo', () => repo);
vi.mock('./partnerTrustPromotion', () => ({ tryAutoPromote }));

import { createDeviceExecuteBatchGate, TrustDeniedError } from './partnerTrust.commands';

const DEVICE = 'd1';
const PARTNER = 'p1';

/** Runs whatever the gate deferred, as the context exit would. */
async function flushDeferred() {
  for (const call of afterExit.mock.calls) await (call[1] as () => Promise<unknown>)();
}

function expectNoNestedReads() {
  expect(repo.readTrust).not.toHaveBeenCalled();
  expect(repo.partnerForDevice).not.toHaveBeenCalled();
  expect(repo.partnerForOrg).not.toHaveBeenCalled();
}

describe('createDeviceExecuteBatchGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    modeFn.mockReturnValue('enforce');
  });

  it('reads the trust snapshot once for the whole batch and never through the system-context readers', async () => {
    const read = vi.fn(async () => ({ partnerId: PARTNER, trustState: 'trusted' as const }));
    const gate = createDeviceExecuteBatchGate(DEVICE, read);
    await gate('script', 'u1');
    await gate('capture_pprof', 'u2');
    await gate('script', null);
    expect(read).toHaveBeenCalledTimes(1);
    expectNoNestedReads();
    expect(afterExit).not.toHaveBeenCalled();
  });

  it('denies a non-lifecycle command for a restricted partner and defers the audit until the transaction settles', async () => {
    const gate = createDeviceExecuteBatchGate(DEVICE, async () => ({ partnerId: PARTNER, trustState: 'restricted' }));
    const err = await gate('script', 'u1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TrustDeniedError);
    expect(err).toMatchObject({ code: 'TRUST_RESTRICTED', reason: 'restricted', deviceId: DEVICE, commandType: 'script' });
    // Nothing written while the claim transaction is still open.
    expect(audit).not.toHaveBeenCalled();
    expect(afterExit).toHaveBeenCalledTimes(1);
    await flushDeferred();
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'partner.trust.capability_denied',
      actorType: 'user',
      actorId: 'u1',
      resourceId: PARTNER,
      result: 'denied',
      details: expect.objectContaining({ capability: 'device_execute', deviceId: DEVICE, commandType: 'script', reason: 'restricted' }),
    }));
    expectNoNestedReads();
  });

  it('probation denies and schedules the auto-promotion check after the transaction', async () => {
    const gate = createDeviceExecuteBatchGate(DEVICE, async () => ({ partnerId: PARTNER, trustState: 'probation' }));
    await expect(gate('script', null)).rejects.toMatchObject({ code: 'TRUST_PROBATION', reason: 'probation_default_deny' });
    expect(tryAutoPromote).not.toHaveBeenCalled();
    await flushDeferred();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'system' }));
    expect(tryAutoPromote).toHaveBeenCalledWith(PARTNER);
  });

  it('shadow mode allows, but still records what enforce would have denied', async () => {
    modeFn.mockReturnValue('shadow');
    const gate = createDeviceExecuteBatchGate(DEVICE, async () => ({ partnerId: PARTNER, trustState: 'restricted' }));
    await expect(gate('script', 'u1')).resolves.toBeUndefined();
    await flushDeferred();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ result: 'success' }));
  });

  it('lifecycle commands and mode=off never read the snapshot', async () => {
    const read = vi.fn(async () => ({ partnerId: PARTNER, trustState: 'restricted' as const }));
    const gate = createDeviceExecuteBatchGate(DEVICE, read);
    await expect(gate('self_uninstall', 'u1')).resolves.toBeUndefined();
    modeFn.mockReturnValue('off');
    await expect(gate('script', 'u1')).resolves.toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(afterExit).not.toHaveBeenCalled();
  });

  it('an unresolvable partner is denied under enforce (and audited after the transaction)', async () => {
    const gate = createDeviceExecuteBatchGate(DEVICE, async () => ({ partnerId: null, trustState: null }));
    await expect(gate('script', 'u1')).rejects.toMatchObject({ code: 'TRUST_RESTRICTED', reason: 'partner_unresolved' });
    expect(audit).not.toHaveBeenCalled();
    await flushDeferred();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'partner.trust.capability_denied',
      details: expect.objectContaining({ reason: 'partner_unresolved' }),
    }));
  });

  it('a partner row that no longer exists is denied as unresolved', async () => {
    const gate = createDeviceExecuteBatchGate(DEVICE, async () => ({ partnerId: PARTNER, trustState: null }));
    await expect(gate('script', 'u1')).rejects.toMatchObject({ code: 'TRUST_RESTRICTED', reason: 'partner_unresolved' });
  });

  it('a snapshot read failure is a plain error (never a TrustDeniedError, never an allow) for every gated row', async () => {
    const read = vi.fn(async () => { throw new Error('db down'); });
    const gate = createDeviceExecuteBatchGate(DEVICE, read);
    for (const type of ['script', 'capture_pprof']) {
      const err = await gate(type, 'u1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(TrustDeniedError);
    }
    expect(read).toHaveBeenCalledTimes(1);
    expectNoNestedReads();
  });
});
