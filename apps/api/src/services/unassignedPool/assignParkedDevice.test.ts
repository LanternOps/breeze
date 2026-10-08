import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
const ledgerRows: any[] = [];
const fakeTx = {
  insert: vi.fn(() => ({
    values: (values: any) => ({
      returning: async () => {
        calls.push('ledger');
        ledgerRows.push(values);
        return [{ id: 'ledger-1' }];
      },
    }),
  })),
};

// A model of the db module's ambient context: runOutsideDbContext clears it,
// withSystemDbAccessContext and db.transaction nest inside it. Recorded at the
// moment post-commit work starts, so the test sees which context it ran in.
const { ctx } = vi.hoisted(() => ({ ctx: { stack: [] as string[] } }));
vi.mock('../../db', () => ({
  db: {
    transaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
      ctx.stack.push('tx');
      try { return await cb(fakeTx); } finally { ctx.stack.pop(); }
    }),
  },
  runOutsideDbContext: vi.fn(async (fn: () => unknown) => {
    const saved = [...ctx.stack];
    ctx.stack.length = 0;
    ctx.stack.push('outside');
    try { return await fn(); } finally { ctx.stack.length = 0; ctx.stack.push(...saved); }
  }),
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => {
    ctx.stack.push('system');
    try { return await fn(); } finally { ctx.stack.pop(); }
  }),
}));

vi.mock('./assignParkedDeviceSteps', () => ({
  lockPartnerHoldingArea: vi.fn(async () => { calls.push('partnerLock'); }),
  lockDeviceForAssignment: vi.fn(),
  lockTargetOrg: vi.fn(),
  siteBelongsToOrg: vi.fn(),
  findIdentityCollisions: vi.fn(),
  lockLiveUserSession: vi.fn(),
}));

vi.mock('../deviceOrgMove/moveDeviceOrgInTransaction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../deviceOrgMove/moveDeviceOrgInTransaction')>();
  return { ...actual, moveDeviceOrgInTransaction: vi.fn() };
});

vi.mock('../partnerDeviceCapacity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../partnerDeviceCapacity')>();
  return { ...actual, admitPartnerDeviceCapacity: vi.fn(), previewPartnerDeviceCapacity: vi.fn() };
});

vi.mock('../stepUpActorAssurance', () => ({ lockActorAssurance: vi.fn() }));
vi.mock('../mfaStepUpGrant', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mfaStepUpGrant')>();
  return { ...actual, consumeStepUpGrant: vi.fn() };
});
vi.mock('../deviceUninstallDrain', () => ({ isDeviceUninstallDraining: vi.fn() }));
vi.mock('../../jobs/deviceGroupJobs', () => ({ requestDeviceGroupReevaluation: vi.fn(async () => 'job') }));
vi.mock('../agentOrgRateLimit', () => ({ invalidateOrgDeviceCount: vi.fn(async () => undefined) }));
vi.mock('../redis', () => ({ getRedis: vi.fn(() => ({ redis: true })) }));
vi.mock('../../routes/agentWs', () => ({ disconnectAgent: vi.fn(() => 'disconnected') }));
vi.mock('../deviceIdentityCollisionAlert', () => ({
  raiseDeviceIdentityCollisionAlert: vi.fn(async () => { calls.push(`alert:${ctx.stack.join('>')}`); return 'alert'; }),
}));
vi.mock('../auditEvents', () => ({ writeAuditEvent: vi.fn() }));
vi.mock('../../jobs/peripheralJobs', () => ({ schedulePeripheralPolicyDevice: vi.fn(async () => 'job') }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import {
  assignParkedDevice,
  assignParkedDevicesBulk,
} from './assignParkedDevice';
import { PARKED_DEVICE_TTL_DAYS } from './limits';
import * as steps from './assignParkedDeviceSteps';
import {
  DevicePoolMembershipRefusedError,
  moveDeviceOrgInTransaction,
  OrgVanishedDuringMoveError,
} from '../deviceOrgMove/moveDeviceOrgInTransaction';
import { TicketMoveCurrencyBlockedError } from '../ticketMoveCurrencyGuard';
import { TicketMoveHourBlockError } from '../ticketMoveHourBlockGuard';
import { PamDeviceMoveBlockedError } from '../pamDeviceMoveGuard';
import { TicketServiceError } from '../ticketService';
import { admitPartnerDeviceCapacity, previewPartnerDeviceCapacity } from '../partnerDeviceCapacity';
import { lockActorAssurance } from '../stepUpActorAssurance';
import { consumeStepUpGrant } from '../mfaStepUpGrant';
import { isDeviceUninstallDraining } from '../deviceUninstallDrain';
import { requestDeviceGroupReevaluation } from '../../jobs/deviceGroupJobs';
import { captureException } from '../sentry';
import { invalidateOrgDeviceCount } from '../agentOrgRateLimit';
import { disconnectAgent } from '../../routes/agentWs';
import { raiseDeviceIdentityCollisionAlert } from '../deviceIdentityCollisionAlert';
import { writeAuditEvent } from '../auditEvents';
import { db } from '../../db';

const PARTNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_PARTNER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HOLDING_ORG = '11111111-1111-4111-8111-111111111111';
const HOLDING_SITE = '12121212-1212-4212-8212-121212121212';
const TARGET_ORG = '22222222-2222-4222-8222-222222222222';
const TARGET_SITE = '33333333-3333-4333-8333-333333333333';
const DEVICE = '44444444-4444-4444-8444-444444444444';
const DEVICE_2 = '55555555-5555-4555-8555-555555555555';
const GRANT = '99999999-9999-4999-8999-999999999999';

const auth = {
  scope: 'partner',
  partnerId: PARTNER,
  partnerOrgAccess: 'all',
  allowedSiteIds: undefined,
  user: { id: 'user-1', email: 'admin@example.com' },
  token: { aep: 1, mep: 1, sid: 'sid-1' },
} as any;

const binding = {
  userId: 'user-1',
  operation: 'parked_device_assign' as const,
  authEpoch: 1,
  mfaEpoch: 1,
  sid: 'sid-1',
  resourceDigest: 'sha256:x',
};

const request = { req: { header: () => undefined } };
const createdAt = new Date(Date.now() - 3600_000);

function parkedDevice(overrides: Partial<steps.LockedParkedDevice> = {}): steps.LockedParkedDevice {
  return {
    id: DEVICE,
    agentId: 'agent-1',
    hostname: 'host-1',
    status: 'online',
    createdAt,
    orgId: HOLDING_ORG,
    siteId: HOLDING_SITE,
    linkGroupId: null,
    orgType: 'unassigned_pool',
    orgPartnerId: PARTNER,
    ...overrides,
  };
}

function targetOrg(overrides: Partial<steps.LockedTargetOrg> = {}): steps.LockedTargetOrg {
  return { id: TARGET_ORG, name: 'Acme', partnerId: PARTNER, type: 'customer', status: 'active', deletedAt: null, ...overrides };
}

function single(overrides: Record<string, unknown> = {}) {
  return assignParkedDevice({
    actor: { auth, partnerId: PARTNER, allowedSiteIds: undefined },
    item: { deviceId: DEVICE, targetOrgId: TARGET_ORG, targetSiteId: TARGET_SITE },
    stepUp: { grantId: GRANT, binding },
    audit: request,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  ledgerRows.length = 0;
  ctx.stack.length = 0;
  vi.mocked(steps.lockLiveUserSession).mockImplementation(async () => { calls.push('sessionLock'); return true; });
  vi.mocked(steps.lockDeviceForAssignment).mockImplementation(async (_tx, id) => {
    calls.push(`deviceLock:${id}`);
    return parkedDevice({ id, agentId: `agent-${id.slice(0, 4)}` });
  });
  vi.mocked(steps.lockTargetOrg).mockImplementation(async () => { calls.push('targetOrgLock'); return targetOrg(); });
  vi.mocked(steps.siteBelongsToOrg).mockImplementation(async () => { calls.push('siteCheck'); return true; });
  vi.mocked(steps.findIdentityCollisions).mockImplementation(async () => { calls.push('collisions'); return []; });
  vi.mocked(previewPartnerDeviceCapacity).mockImplementation(async () => {
    calls.push('capacityPreview');
    return { allowed: true, partnerId: PARTNER, maxDevices: null, activeCount: null };
  });
  vi.mocked(admitPartnerDeviceCapacity).mockImplementation(async () => {
    calls.push('capacity');
    return { allowed: true, partnerId: PARTNER, maxDevices: null, activeCount: null };
  });
  vi.mocked(lockActorAssurance).mockImplementation(async () => { calls.push('actorLock'); return true; });
  vi.mocked(consumeStepUpGrant).mockImplementation(async () => { calls.push('consume'); return true; });
  vi.mocked(isDeviceUninstallDraining).mockResolvedValue(false);
  vi.mocked(moveDeviceOrgInTransaction).mockImplementation(async () => {
    calls.push('engine');
    return {
      updated: { id: DEVICE, agentId: 'agent-1' } as any,
      linkGroupDissolved: false,
      currencyGuard: null,
      alertChildRewrite: null,
      customFieldRehome: { rehomed: 0, dropped: 0 },
    };
  });
});

describe('assignParkedDevice', () => {
  it('refuses a caller who is not a full partner admin, before any transaction', async () => {
    const result = await assignParkedDevice({
      actor: { auth: { ...auth, partnerOrgAccess: 'selected' }, partnerId: PARTNER, allowedSiteIds: undefined },
      item: { deviceId: DEVICE, targetOrgId: TARGET_ORG, targetSiteId: TARGET_SITE },
      stepUp: { grantId: GRANT, binding },
      audit: request,
    });
    expect(result).toMatchObject({ ok: false, code: 'PARTNER_WIDE_WRITE_DENIED' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('runs every step in one transaction, in lock order, and writes the ledger row inside it', async () => {
    const result = await single();
    expect(result).toEqual({ ok: true, deviceId: DEVICE, targetOrgId: TARGET_ORG, targetSiteId: TARGET_SITE, ledgerEventId: 'ledger-1' });
    expect(calls).toEqual([
      'partnerLock', `deviceLock:${DEVICE}`, 'targetOrgLock', 'siteCheck', 'collisions',
      'capacityPreview', 'actorLock', 'sessionLock', 'consume', 'engine', 'capacity', 'ledger',
    ]);
    expect(steps.lockLiveUserSession).toHaveBeenCalledWith(fakeTx, { userId: 'user-1', sid: 'sid-1' });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(steps.lockPartnerHoldingArea).toHaveBeenCalledWith(fakeTx, PARTNER);
    // Admitted after the move, with the moved device left out of the count, so
    // the partner row lock is held only from the admission to commit.
    expect(admitPartnerDeviceCapacity).toHaveBeenCalledWith(fakeTx, { orgId: TARGET_ORG, expectedPartnerId: PARTNER, excludeDeviceId: DEVICE });
    expect(consumeStepUpGrant).toHaveBeenCalledWith(GRANT, binding);
    expect(moveDeviceOrgInTransaction).toHaveBeenCalledWith(fakeTx, expect.objectContaining({
      deviceId: DEVICE,
      sourceOrgId: HOLDING_ORG,
      targetOrgId: TARGET_ORG,
      targetSiteId: TARGET_SITE,
      targetOrgName: 'Acme',
      via: 'pool_assignment',
      stepUp: null,
      actor: { userId: 'user-1', allowedSiteIds: undefined },
    }));
    const ledger = ledgerRows[0];
    expect(ledger).toMatchObject({
      eventType: 'assigned',
      partnerId: PARTNER,
      deviceId: DEVICE,
      fromOrgId: HOLDING_ORG,
      toOrgId: TARGET_ORG,
      assignmentMethod: 'manual',
      assignedByUserId: 'user-1',
      stepUpGrantRef: GRANT,
      parkedAt: createdAt,
    });
    expect(ledger.parkedDurationSeconds).toBeGreaterThanOrEqual(3599);
  });

  it('after commit: re-evaluates groups, drops both device-count caches, disconnects the agent, audits the target org', async () => {
    await single();
    expect(requestDeviceGroupReevaluation).toHaveBeenCalledWith({
      deviceId: DEVICE, orgId: TARGET_ORG, eventType: 'device.updated', reason: 'parked_device_assigned',
    });
    expect(vi.mocked(invalidateOrgDeviceCount).mock.calls.map((c) => c[1]).sort()).toEqual([HOLDING_ORG, TARGET_ORG].sort());
    expect(disconnectAgent).toHaveBeenCalledWith(`agent-${DEVICE.slice(0, 4)}`, 4040, expect.any(String));
    expect(writeAuditEvent).toHaveBeenCalledWith(request, expect.objectContaining({
      orgId: TARGET_ORG,
      action: 'device.parked.assigned',
      resourceId: DEVICE,
      actorId: 'user-1',
      details: expect.objectContaining({ possessionConfirmed: true, fromOrgId: HOLDING_ORG, method: 'manual', stepUp: 'grant' }),
    }));
  });

  it('refuses a device that is not parked, without consuming the grant', async () => {
    vi.mocked(steps.lockDeviceForAssignment).mockResolvedValueOnce(parkedDevice({ orgType: 'customer' }));
    expect(await single()).toMatchObject({ ok: false, code: 'DEVICE_NOT_PARKED' });
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
    expect(moveDeviceOrgInTransaction).not.toHaveBeenCalled();
    expect(writeAuditEvent).not.toHaveBeenCalled();
    expect(disconnectAgent).not.toHaveBeenCalled();
  });

  it("answers another partner's parked device, or a missing one, as not found", async () => {
    vi.mocked(steps.lockDeviceForAssignment).mockResolvedValueOnce(parkedDevice({ orgPartnerId: OTHER_PARTNER }));
    expect(await single()).toMatchObject({ ok: false, code: 'DEVICE_NOT_FOUND' });
    vi.mocked(steps.lockDeviceForAssignment).mockResolvedValueOnce(null);
    expect(await single()).toMatchObject({ ok: false, code: 'DEVICE_NOT_FOUND' });
  });

  it.each(['decommissioned', 'quarantined'])('refuses a %s device', async (status) => {
    vi.mocked(steps.lockDeviceForAssignment).mockResolvedValueOnce(parkedDevice({ status }));
    expect(await single()).toMatchObject({ ok: false, code: 'DEVICE_NOT_ASSIGNABLE' });
  });

  it('refuses a device whose removal is draining', async () => {
    vi.mocked(isDeviceUninstallDraining).mockResolvedValueOnce(true);
    expect(await single()).toMatchObject({ ok: false, code: 'DEVICE_NOT_ASSIGNABLE' });
  });

  it('refuses a device parked longer than the parking window', async () => {
    const old = new Date(Date.now() - (PARKED_DEVICE_TTL_DAYS * 86_400_000 + 60_000));
    vi.mocked(steps.lockDeviceForAssignment).mockResolvedValueOnce(parkedDevice({ createdAt: old }));
    expect(await single()).toMatchObject({ ok: false, code: 'DEVICE_PARKING_EXPIRED' });
  });

  it.each([
    ['another partner', { partnerId: OTHER_PARTNER }],
    ['a holding org', { type: 'unassigned_pool' }],
    ['a Quick Support org', { type: 'quick_support' }],
    ['a suspended org', { status: 'suspended' }],
    ['an archived org', { status: 'archived' }],
    ['a deleted org', { deletedAt: new Date() }],
  ])('refuses a destination in %s', async (_label, overrides) => {
    vi.mocked(steps.lockTargetOrg).mockResolvedValueOnce(targetOrg(overrides as Partial<steps.LockedTargetOrg>));
    expect(await single()).toMatchObject({ ok: false, code: 'TARGET_ORG_INVALID' });
    expect(moveDeviceOrgInTransaction).not.toHaveBeenCalled();
  });

  it('accepts a trial destination org', async () => {
    vi.mocked(steps.lockTargetOrg).mockResolvedValueOnce(targetOrg({ status: 'trial' }));
    expect(await single()).toMatchObject({ ok: true });
  });

  it('refuses a site outside the destination org', async () => {
    vi.mocked(steps.siteBelongsToOrg).mockResolvedValueOnce(false);
    expect(await single()).toMatchObject({ ok: false, code: 'TARGET_SITE_INVALID' });
  });

  it('refuses a destination site outside a site-restricted caller\'s allowlist', async () => {
    const restricted = await assignParkedDevice({
      actor: { auth, partnerId: PARTNER, allowedSiteIds: ['66666666-6666-4666-8666-666666666666'] },
      item: { deviceId: DEVICE, targetOrgId: TARGET_ORG, targetSiteId: TARGET_SITE },
      stepUp: { grantId: GRANT, binding },
      audit: request,
    });
    expect(restricted).toMatchObject({ ok: false, code: 'TARGET_SITE_INVALID' });
    const allowed = await assignParkedDevice({
      actor: { auth, partnerId: PARTNER, allowedSiteIds: [TARGET_SITE] },
      item: { deviceId: DEVICE, targetOrgId: TARGET_ORG, targetSiteId: TARGET_SITE },
      stepUp: { grantId: GRANT, binding },
      audit: request,
    });
    expect(allowed).toMatchObject({ ok: true });
    expect(moveDeviceOrgInTransaction).toHaveBeenLastCalledWith(fakeTx, expect.objectContaining({
      actor: { userId: 'user-1', allowedSiteIds: [TARGET_SITE] },
    }));
  });

  it('refuses a hostname collision unless the caller accepts it, then raises the collision alert after commit', async () => {
    vi.mocked(steps.findIdentityCollisions).mockResolvedValue([{ id: DEVICE_2, status: 'online' }]);
    expect(await single()).toMatchObject({ ok: false, code: 'DEVICE_IDENTITY_COLLISION' });
    expect(raiseDeviceIdentityCollisionAlert).not.toHaveBeenCalled();

    const accepted = await assignParkedDevice({
      actor: { auth, partnerId: PARTNER, allowedSiteIds: undefined },
      item: { deviceId: DEVICE, targetOrgId: TARGET_ORG, targetSiteId: TARGET_SITE, acceptIdentityCollision: true },
      stepUp: { grantId: GRANT, binding },
      audit: request,
    });
    expect(accepted).toMatchObject({ ok: true });
    // Raised after the assignment committed, in a FRESH system context — never
    // inside the assignment transaction or a caller's ambient context.
    expect(calls.indexOf('alert:outside>system')).toBeGreaterThan(calls.lastIndexOf('ledger'));
    expect(calls.filter((c) => c.startsWith('alert:'))).toEqual(['alert:outside>system']);
    expect(raiseDeviceIdentityCollisionAlert).toHaveBeenCalledWith({
      orgId: TARGET_ORG,
      siteId: TARGET_SITE,
      hostname: 'host-1',
      newDeviceId: DEVICE,
      existingDeviceId: DEVICE_2,
      collidingDeviceIds: [DEVICE_2],
    });
  });

  it('refuses when licensed capacity is already full, without consuming the grant', async () => {
    vi.mocked(previewPartnerDeviceCapacity).mockResolvedValueOnce({ allowed: false, partnerId: PARTNER, maxDevices: 5, activeCount: 5 });
    expect(await single()).toMatchObject({ ok: false, code: 'PARTNER_DEVICE_LIMIT_REACHED' });
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
    expect(moveDeviceOrgInTransaction).not.toHaveBeenCalled();
  });

  it('a lock timeout on the partner row after the grant was spent is a retryable refusal, not a failure', async () => {
    vi.mocked(admitPartnerDeviceCapacity).mockRejectedValueOnce(
      Object.assign(new Error('canceling statement due to lock timeout'), { cause: { code: '55P03' } }),
    );
    expect(await single()).toMatchObject({ ok: false, code: 'ASSIGNMENT_BUSY' });
    expect(ledgerRows).toEqual([]);
  });

  it('refuses when the locked admission after the move finds the cap reached, writing nothing', async () => {
    vi.mocked(admitPartnerDeviceCapacity).mockResolvedValueOnce({ allowed: false, partnerId: PARTNER, maxDevices: 5, activeCount: 5 });
    expect(await single()).toMatchObject({ ok: false, code: 'PARTNER_DEVICE_LIMIT_REACHED' });
    expect(ledgerRows).toEqual([]);
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });

  it('refuses when the grant cannot be consumed inside the transaction', async () => {
    vi.mocked(consumeStepUpGrant).mockResolvedValueOnce(false);
    expect(await single()).toMatchObject({ ok: false, code: 'STEP_UP_REQUIRED' });
    expect(moveDeviceOrgInTransaction).not.toHaveBeenCalled();
    expect(ledgerRows).toEqual([]);
  });

  it('with 2FA off (no grant) records the ledger row without a grant reference', async () => {
    expect(await single({ stepUp: null })).toMatchObject({ ok: true });
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
    expect(ledgerRows[0].stepUpGrantRef).toBeNull();
  });

  it('a failure after the ledger insert propagates and runs no post-commit effect', async () => {
    await expect(assignParkedDevice({
      actor: { auth, partnerId: PARTNER, allowedSiteIds: undefined },
      item: { deviceId: DEVICE, targetOrgId: TARGET_ORG, targetSiteId: TARGET_SITE },
      stepUp: { grantId: GRANT, binding },
      audit: request,
    }, { hooks: { afterLedgerInsert: async () => { throw new Error('forced'); } } })).rejects.toThrow('forced');
    expect(requestDeviceGroupReevaluation).not.toHaveBeenCalled();
    expect(disconnectAgent).not.toHaveBeenCalled();
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });

  it('system scope binds the partner the route resolved, not the caller token', async () => {
    const systemAuth = { ...auth, scope: 'system', partnerId: null, partnerOrgAccess: undefined };
    const result = await assignParkedDevice({
      actor: { auth: systemAuth, partnerId: PARTNER, allowedSiteIds: undefined },
      item: { deviceId: DEVICE, targetOrgId: TARGET_ORG, targetSiteId: TARGET_SITE },
      stepUp: null,
      audit: request,
    });
    expect(result).toMatchObject({ ok: true });
    expect(steps.lockPartnerHoldingArea).toHaveBeenCalledWith(fakeTx, PARTNER);
  });
});

describe('assignParkedDevicesBulk', () => {
  const bulkBinding = { ...binding, operation: 'parked_device_assign_bulk' as const };
  const items = [
    { deviceId: DEVICE, targetOrgId: TARGET_ORG, targetSiteId: TARGET_SITE },
    { deviceId: DEVICE_2, targetOrgId: TARGET_ORG, targetSiteId: TARGET_SITE },
  ];

  it('consumes the batch grant once, then assigns each device in its own transaction', async () => {
    const out = await assignParkedDevicesBulk({ actor: { auth, partnerId: PARTNER, allowedSiteIds: undefined }, items, stepUp: { grantId: GRANT, binding: bulkBinding }, audit: request });
    expect(out).toEqual({
      ok: true,
      results: [
        { ok: true, deviceId: DEVICE, targetOrgId: TARGET_ORG, targetSiteId: TARGET_SITE, ledgerEventId: 'ledger-1' },
        { ok: true, deviceId: DEVICE_2, targetOrgId: TARGET_ORG, targetSiteId: TARGET_SITE, ledgerEventId: 'ledger-1' },
      ],
    });
    expect(consumeStepUpGrant).toHaveBeenCalledTimes(1);
    expect(consumeStepUpGrant).toHaveBeenCalledWith(GRANT, bulkBinding);
    expect(db.transaction).toHaveBeenCalledTimes(2);
    // The actor's assurance is re-locked inside every per-device transaction.
    expect(lockActorAssurance).toHaveBeenCalledTimes(2);
    expect(ledgerRows.map((r) => r.assignmentMethod)).toEqual(['bulk', 'bulk']);
    expect(ledgerRows.map((r) => r.stepUpGrantRef)).toEqual([GRANT, GRANT]);
  });

  it('reports per-item refusals without stopping the batch', async () => {
    vi.mocked(steps.lockDeviceForAssignment).mockResolvedValueOnce(parkedDevice({ status: 'decommissioned' }));
    const out = await assignParkedDevicesBulk({ actor: { auth, partnerId: PARTNER, allowedSiteIds: undefined }, items, stepUp: { grantId: GRANT, binding: bulkBinding }, audit: request });
    expect(out.ok && out.results.map((r) => [r.deviceId, r.ok, r.ok ? undefined : r.code])).toEqual([
      [DEVICE, false, 'DEVICE_NOT_ASSIGNABLE'],
      [DEVICE_2, true, undefined],
    ]);
  });

  it('refuses the whole batch when the batch grant cannot be consumed', async () => {
    vi.mocked(consumeStepUpGrant).mockResolvedValueOnce(false);
    const out = await assignParkedDevicesBulk({ actor: { auth, partnerId: PARTNER, allowedSiteIds: undefined }, items, stepUp: { grantId: GRANT, binding: bulkBinding }, audit: request });
    expect(out).toEqual({ ok: false, code: 'STEP_UP_REQUIRED' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('reports an unexpected per-item failure as ASSIGNMENT_FAILED and continues', async () => {
    vi.mocked(moveDeviceOrgInTransaction).mockRejectedValueOnce(new Error('boom'));
    const out = await assignParkedDevicesBulk({ actor: { auth, partnerId: PARTNER, allowedSiteIds: undefined }, items, stepUp: { grantId: GRANT, binding: bulkBinding }, audit: request });
    expect(out.ok && out.results.map((r) => (r.ok ? 'ok' : r.code))).toEqual(['ASSIGNMENT_FAILED', 'ok']);
  });

  it('refuses a caller who is not a full partner admin', async () => {
    const out = await assignParkedDevicesBulk({ actor: { auth: { ...auth, partnerOrgAccess: 'selected' }, partnerId: PARTNER, allowedSiteIds: undefined }, items, stepUp: { grantId: GRANT, binding: bulkBinding }, audit: request });
    expect(out).toEqual({ ok: false, code: 'PARTNER_WIDE_WRITE_DENIED' });
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
  });
});

describe('assignParkedDevice — refusals raised by the move engine', () => {
  const pgPamViolation = Object.assign(new Error('violates check constraint'), {
    cause: { code: '23514', constraint_name: 'devices_pam_history_move_guard' },
  });
  it.each([
    ['holding-area rule', new DevicePoolMembershipRefusedError({ code: 'POOL_EXIT_REQUIRES_ASSIGNMENT', message: 'm' }), 'POOL_MEMBERSHIP_REFUSED'],
    ['target org gone', new OrgVanishedDuringMoveError('target'), 'TARGET_ORG_INVALID'],
    ['holding org gone', new OrgVanishedDuringMoveError('source'), 'DEVICE_NOT_FOUND'],
    ['currency block', new TicketMoveCurrencyBlockedError('m', {} as any), 'TICKET_MOVE_CURRENCY_BLOCKED'],
    ['block-drawn time', new TicketMoveHourBlockError({ drawnTimeEntries: 1 }), 'HOUR_BLOCK_DRAWN_TIME'],
    ['PAM evidence', new PamDeviceMoveBlockedError(), 'PAM_DEVICE_MOVE_BLOCKED'],
    ['PAM evidence (database guard)', pgPamViolation, 'PAM_DEVICE_MOVE_BLOCKED'],
    ['a lock timeout', Object.assign(new Error('canceling statement due to lock timeout'), { cause: { code: '55P03' } }), 'ASSIGNMENT_BUSY'],
    ['a deadlock', Object.assign(new Error('deadlock detected'), { cause: { code: '40P01' } }), 'ASSIGNMENT_BUSY'],
    ['pinned ticket', new TicketServiceError('m', 409, 'DELIVERABLE_TICKET_PINNED'), 'DELIVERABLE_TICKET_PINNED'],
  ])('single: %s becomes a refusal, not an error', async (_label, err, code) => {
    vi.mocked(moveDeviceOrgInTransaction).mockRejectedValueOnce(err);
    expect(await single()).toMatchObject({ ok: false, code });
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });

  it('bulk: an engine refusal is reported with its code, not ASSIGNMENT_FAILED', async () => {
    vi.mocked(moveDeviceOrgInTransaction).mockRejectedValueOnce(new PamDeviceMoveBlockedError());
    const out = await assignParkedDevicesBulk({
      actor: { auth, partnerId: PARTNER, allowedSiteIds: undefined },
      items: [
        { deviceId: DEVICE, targetOrgId: TARGET_ORG, targetSiteId: TARGET_SITE },
        { deviceId: DEVICE_2, targetOrgId: TARGET_ORG, targetSiteId: TARGET_SITE },
      ],
      stepUp: { grantId: GRANT, binding: { ...binding, operation: 'parked_device_assign_bulk' } },
      audit: request,
    });
    expect(out.ok && out.results.map((r) => (r.ok ? 'ok' : r.code))).toEqual(['PAM_DEVICE_MOVE_BLOCKED', 'ok']);
  });
});

describe('assignParkedDevice — post-commit work never turns a committed assignment into a failure', () => {
  it('single: a throwing post-commit effect still answers ok', async () => {
    vi.mocked(disconnectAgent).mockImplementationOnce(() => { throw new Error('socket registry down'); });
    expect(await single()).toMatchObject({ ok: true, ledgerEventId: 'ledger-1' });
  });

  it('bulk: a throwing post-commit effect still reports the moved device as assigned', async () => {
    vi.mocked(disconnectAgent).mockImplementationOnce(() => { throw new Error('socket registry down'); });
    const out = await assignParkedDevicesBulk({
      actor: { auth, partnerId: PARTNER, allowedSiteIds: undefined },
      items: [
        { deviceId: DEVICE, targetOrgId: TARGET_ORG, targetSiteId: TARGET_SITE },
        { deviceId: DEVICE_2, targetOrgId: TARGET_ORG, targetSiteId: TARGET_SITE },
      ],
      stepUp: null,
      audit: request,
    });
    expect(out.ok && out.results.map((r) => r.ok)).toEqual([true, true]);
  });
  it('a rejected async post-commit effect is reported, not left unhandled', async () => {
    const failure = new Error('queue unavailable');
    vi.mocked(requestDeviceGroupReevaluation).mockImplementationOnce(async () => { throw failure; });
    expect(await single()).toMatchObject({ ok: true, ledgerEventId: 'ledger-1' });
    await vi.waitFor(() => expect(captureException).toHaveBeenCalledWith(failure));
  });
});

describe('assignParkedDevice — the signed-in session must still be live', () => {
  it('single: a revoked session refuses before the grant is consumed', async () => {
    vi.mocked(steps.lockLiveUserSession).mockResolvedValueOnce(false);
    expect(await single()).toMatchObject({ ok: false, code: 'STEP_UP_REQUIRED' });
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
    expect(moveDeviceOrgInTransaction).not.toHaveBeenCalled();
  });

  it('bulk: re-checks the session for every device, so revoking it stops the rest of the batch', async () => {
    vi.mocked(steps.lockLiveUserSession).mockResolvedValueOnce(true).mockResolvedValue(false);
    const out = await assignParkedDevicesBulk({
      actor: { auth, partnerId: PARTNER, allowedSiteIds: undefined },
      items: [
        { deviceId: DEVICE, targetOrgId: TARGET_ORG, targetSiteId: TARGET_SITE },
        { deviceId: DEVICE_2, targetOrgId: TARGET_ORG, targetSiteId: TARGET_SITE },
      ],
      stepUp: { grantId: GRANT, binding: { ...binding, operation: 'parked_device_assign_bulk' } },
      audit: request,
    });
    expect(out.ok && out.results.map((r) => (r.ok ? 'ok' : r.code))).toEqual(['ok', 'STEP_UP_REQUIRED']);
    expect(steps.lockLiveUserSession).toHaveBeenCalledTimes(2);
  });
});
