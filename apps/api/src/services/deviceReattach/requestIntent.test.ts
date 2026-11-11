/**
 * requestDeviceReattach (#8318 wave 2-2): the §8 refusals, the typed
 * confirmations and the `device_reattach` step-up, with the database and Redis
 * seams mocked. What this pins: every refusal answers its code and leaves the
 * grant untouched (neither validated nor consumed), a matching grant is
 * consumed exactly once just before the insert, and a grant whose binding no
 * longer matches the locked rows is refused WITHOUT being consumed.
 * deviceReattachRoute.integration.test.ts proves the same against real
 * PostgreSQL and Redis.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);

const state = vi.hoisted(() => ({
  source: null as Record<string, unknown> | null,
  target: null as Record<string, unknown> | null,
  access: { allowed: true, fullAdmin: true } as { allowed: true; fullAdmin: boolean } | { allowed: false; code: string },
  openIntent: false,
  retired: false,
  liveness: { state: 'silent' } as { state: string },
  redis: { ok: true } as unknown,
  assured: true,
  validate: true,
  consume: true,
}));

const tx = vi.hoisted(() => ({
  select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [{ partnerId: 'partner-1' }] }) }) })),
  insert: vi.fn(() => ({
    values: (values: Record<string, unknown>) => {
      calls.push('insert');
      return { returning: async () => [{ ...values, sourceParked: false }] };
    },
  })),
}));

vi.mock('../../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (state.target ? [{ agentId: state.target.agentId }] : []) }) }) }),
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

vi.mock('../unassignedPool/holdingAreaLock', () => ({
  lockPartnerHoldingArea: vi.fn(async () => { calls.push('holdingLock'); }),
}));

vi.mock('./intentStore', () => ({
  lockReattachDevices: vi.fn(async () => {
    calls.push('deviceLocks');
    const map = new Map<string, unknown>();
    if (state.source) map.set(state.source.id as string, state.source);
    if (state.target) map.set(state.target.id as string, state.target);
    return map;
  }),
  anyDeviceInOpenIntent: vi.fn(async () => state.openIntent),
  wasRetiredReattachSource: vi.fn(async () => state.retired),
  endIntentInTransaction: vi.fn(),
  readIntentForUpdate: vi.fn(),
  revokeCertificatesAfterCommit: vi.fn(),
}));

vi.mock('./access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./access')>()),
  loadReattachActor: vi.fn(async () => ({})),
  canActorReattach: vi.fn(() => state.access),
}));

vi.mock('./liveness', () => ({
  readRedisLivenessSignals: vi.fn(async () => state.redis),
  decideTargetLiveness: vi.fn(() => state.liveness),
}));

vi.mock('./sourceMarker', () => ({
  setReattachSourceMarker: vi.fn(async () => true),
  clearReattachSourceMarker: vi.fn(async () => true),
}));

vi.mock('./audit', () => ({ writeReattachAudit: vi.fn(async () => undefined) }));

vi.mock('../stepUpActorAssurance', () => ({
  lockActorAssurance: vi.fn(async () => { calls.push('actorLock'); return state.assured; }),
}));

vi.mock('../unassignedPool/assignParkedDeviceSteps', () => ({
  lockLiveUserSession: vi.fn(async () => { calls.push('sessionLock'); return true; }),
}));

vi.mock('../mfaStepUpGrant', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mfaStepUpGrant')>();
  return {
    ...actual,
    validateStepUpGrant: vi.fn(async () => { calls.push('validate'); return state.validate; }),
    consumeStepUpGrant: vi.fn(async () => { calls.push('consume'); return state.consume; }),
  };
});

import { requestDeviceReattach, type RequestDeviceReattachInput } from './requestIntent';
import { consumeStepUpGrant, deviceReattachResourceDigest, validateStepUpGrant } from '../mfaStepUpGrant';

const SOURCE = '00000000-0000-4000-8000-000000000001';
const TARGET = '00000000-0000-4000-8000-000000000002';
const GRANT = '00000000-0000-4000-8000-0000000000aa';

function device(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    agentId: `agent-${id.slice(-1)}`,
    orgId: 'org-a',
    siteId: 'site-a',
    hostname: id === TARGET ? 'PC-OLD' : 'PC-NEW',
    osType: 'windows',
    status: 'offline',
    isEphemeral: false,
    agentTokenSuspendedAt: null,
    installIncarnation: 3,
    rebindProtocolVersion: 1,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    decommissionedAt: null,
    lastSeenAt: null,
    watchdogLastSeen: null,
    orgType: 'customer',
    orgPartnerId: 'partner-1',
    orgStatus: 'active',
    orgDeletedAt: null,
    ...over,
  };
}

const auth = { user: { id: 'user-1' }, token: { aep: 1, mep: 2, sid: 'sid-1' } } as never;

function input(over: Partial<RequestDeviceReattachInput> = {}): RequestDeviceReattachInput {
  return {
    actor: { userId: 'user-1' },
    sourceDeviceId: SOURCE,
    targetDeviceId: TARGET,
    evidenceLevel: 'hint',
    restoreDecommissioned: false,
    confirmTargetName: 'PC-OLD',
    stepUp: { grantId: GRANT, auth, binding: { authEpoch: 1, mfaEpoch: 2, sid: 'sid-1' } },
    ...over,
  };
}

const expectedBinding = () => ({
  userId: 'user-1',
  operation: 'device_reattach',
  authEpoch: 1,
  mfaEpoch: 2,
  sid: 'sid-1',
  resourceDigest: deviceReattachResourceDigest({
    sourceDeviceId: SOURCE,
    targetDeviceId: TARGET,
    targetAgentId: 'agent-2',
    targetIncarnation: 3,
    evidenceLevel: 'hint',
    restoreDecommissioned: false,
  }),
});

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
  Object.assign(state, {
    source: device(SOURCE),
    target: device(TARGET),
    access: { allowed: true, fullAdmin: true },
    openIntent: false,
    retired: false,
    liveness: { state: 'silent' },
    redis: { ok: true },
    assured: true,
    validate: true,
    consume: true,
  });
});

describe('requestDeviceReattach — step-up (#8318 §8)', () => {
  it('consumes a matching grant once, after every lock and check, just before the insert, and records it', async () => {
    const result = await requestDeviceReattach(input());
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['holdingLock', 'deviceLocks', 'actorLock', 'sessionLock', 'validate', 'consume', 'insert']);
    expect(validateStepUpGrant).toHaveBeenCalledWith(GRANT, expectedBinding());
    expect(consumeStepUpGrant).toHaveBeenCalledWith(GRANT, expectedBinding());
    if (result.ok) expect(result.intent.stepUpGrantRef).toBe(GRANT);
  });

  it('binds the target install as it is under the lock: a re-enrolled target never matches', async () => {
    state.target = device(TARGET, { installIncarnation: 4 });
    state.validate = false;
    const result = await requestDeviceReattach(input());
    expect(result).toMatchObject({ ok: false, status: 403, code: 'STEP_UP_REQUIRED' });
    expect(validateStepUpGrant).toHaveBeenCalledWith(GRANT, expect.objectContaining({
      resourceDigest: deviceReattachResourceDigest({
        sourceDeviceId: SOURCE, targetDeviceId: TARGET, targetAgentId: 'agent-2', targetIncarnation: 4, evidenceLevel: 'hint', restoreDecommissioned: false,
      }),
    }));
    // A mismatched grant is not burned, and nothing is written.
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
    expect(calls).not.toContain('insert');
  });

  it('binds the restore choice', async () => {
    state.target = device(TARGET, { status: 'decommissioned', decommissionedAt: new Date() });
    await requestDeviceReattach(input({ restoreDecommissioned: true }));
    expect(validateStepUpGrant).toHaveBeenCalledWith(GRANT, expect.objectContaining({
      resourceDigest: deviceReattachResourceDigest({
        sourceDeviceId: SOURCE, targetDeviceId: TARGET, targetAgentId: 'agent-2', targetIncarnation: 3, evidenceLevel: 'hint', restoreDecommissioned: true,
      }),
    }));
  });

  it('answers STEP_UP_REQUIRED for a missing grant, after every other refusal', async () => {
    expect(await requestDeviceReattach(input({ stepUp: { grantId: undefined, auth, binding: { authEpoch: 1, mfaEpoch: 2, sid: 'sid-1' } } })))
      .toMatchObject({ ok: false, status: 403, code: 'STEP_UP_REQUIRED' });
    expect(validateStepUpGrant).not.toHaveBeenCalled();
    // …and a refusal still wins over the missing grant.
    state.openIntent = true;
    expect(await requestDeviceReattach(input({ stepUp: { grantId: undefined, auth, binding: { authEpoch: 1, mfaEpoch: 2, sid: 'sid-1' } } })))
      .toMatchObject({ code: 'device_in_open_intent' });
  });

  it('refuses when the actor assurance or the session no longer holds, without touching the grant', async () => {
    state.assured = false;
    expect(await requestDeviceReattach(input())).toMatchObject({ ok: false, status: 403, code: 'STEP_UP_REQUIRED' });
    expect(validateStepUpGrant).not.toHaveBeenCalled();
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
  });

  it('refuses when the consume loses a race (the grant was spent meanwhile)', async () => {
    state.consume = false;
    expect(await requestDeviceReattach(input())).toMatchObject({ ok: false, status: 403, code: 'STEP_UP_REQUIRED' });
    expect(calls).not.toContain('insert');
  });

  it('asks for no grant when the deployment has two-factor authentication off', async () => {
    const result = await requestDeviceReattach(input({ stepUp: null }));
    expect(result.ok).toBe(true);
    expect(validateStepUpGrant).not.toHaveBeenCalled();
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
  });

  it('never accepts a step-up of another user', async () => {
    await expect(requestDeviceReattach(input({ actor: { userId: 'user-2' } }))).rejects.toThrow(/not the requester/);
  });
});

describe('requestDeviceReattach — every refusal leaves the grant unspent (#8318 §8)', () => {
  const cases: Array<[string, number, () => void | Partial<RequestDeviceReattachInput>]> = [
    ['partner_mismatch', 409, () => { state.target = device(TARGET, { orgPartnerId: 'partner-2' }); }],
    ['org_draining', 409, () => { state.target = device(TARGET, { orgStatus: 'suspended' }); }],
    ['target_ineligible', 409, () => { state.target = device(TARGET, { orgType: 'unassigned_pool' }); }],
    ['full_admin_required', 403, () => { state.access = { allowed: false, code: 'full_admin_required' }; }],
    ['org_access_denied', 403, () => { state.access = { allowed: false, code: 'org_access_denied' }; }],
    ['permission_denied', 403, () => { state.access = { allowed: false, code: 'permission_denied' }; }],
    ['rebind_unsupported', 409, () => { state.source = device(SOURCE, { rebindProtocolVersion: 0 }); }],
    ['source_decommissioned', 409, () => { state.source = device(SOURCE, { status: 'decommissioned' }); }],
    ['source_ineligible', 409, () => { state.source = device(SOURCE, { isEphemeral: true }); }],
    ['device_quarantined', 409, () => { state.target = device(TARGET, { status: 'quarantined' }); }],
    ['device_suspended', 409, () => { state.source = device(SOURCE, { agentTokenSuspendedAt: new Date() }); }],
    ['target_ephemeral', 409, () => { state.target = device(TARGET, { isEphemeral: true }); }],
    ['target_decommissioned', 409, () => { state.target = device(TARGET, { status: 'decommissioned' }); }],
    ['device_in_open_intent', 409, () => { state.openIntent = true; }],
    ['target_retired', 409, () => { state.retired = true; }],
    ['target_alive', 409, () => { state.liveness = { state: 'alive' }; }],
    ['liveness_unknown', 409, () => { state.liveness = { state: 'unknown' }; }],
    ['os_changed', 409, () => { state.target = device(TARGET, { osType: 'linux' }); }],
    ['confirm_target_name_required', 400, () => ({ confirmTargetName: '  ' })],
    ['confirm_target_name_mismatch', 400, () => ({ confirmTargetName: 'PC-OTHER' })],
    ['device_not_found', 404, () => { state.target = null; }],
    ['same_device', 400, () => ({ targetDeviceId: SOURCE })],
  ];

  it.each(cases)('%s answers %i and never validates or consumes the grant', async (code, status, arrange) => {
    const over = arrange() ?? {};
    const result = await requestDeviceReattach(input(over));
    expect(result).toMatchObject({ ok: false, status, code });
    expect(validateStepUpGrant).not.toHaveBeenCalled();
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
    expect(calls).not.toContain('insert');
  });

  it('accepts an OS change the requester acknowledged', async () => {
    state.target = device(TARGET, { osType: 'linux' });
    expect((await requestDeviceReattach(input({ acknowledgeOsChange: true }))).ok).toBe(true);
  });

  it('compares the typed name trimmed and case-insensitively', async () => {
    expect((await requestDeviceReattach(input({ confirmTargetName: '  pc-old ' }))).ok).toBe(true);
  });

  it('asks for no typed name with TPM continuity evidence', async () => {
    expect((await requestDeviceReattach(input({ evidenceLevel: 'tpm_continuity', confirmTargetName: null, stepUp: null }))).ok).toBe(true);
  });
});
