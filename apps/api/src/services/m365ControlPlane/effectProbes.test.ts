import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { M365MutatingAction, M365WriteActionId } from '@breeze/shared/m365';

const { readByOrg, writeByOrg } = vi.hoisted(() => ({
  readByOrg: vi.fn(),
  writeByOrg: vi.fn(),
}));

vi.mock('./readActionService', () => ({
  executeM365ReadActionByOrg: (...args: unknown[]) => readByOrg(...args),
}));
vi.mock('./writeActionService', () => ({
  executeM365WriteActionByOrg: (...args: unknown[]) => writeByOrg(...args),
}));

import { probeM365Effect, type M365EffectProbeResult } from './effectProbes';

const ORG = '44444444-4444-4444-8444-444444444444';
const USER_ID = '77777777-7777-4777-8777-777777777777';
const GROUP = '55555555-5555-4555-8555-555555555555';
const SKU_A = '00000000-0000-4000-8000-00000000000a';
const SKU_B = '00000000-0000-4000-8000-00000000000b';
const PLAN = '00000000-0000-4000-8000-000000000001';
const DEVICE = '66666666-6666-4666-8666-666666666666';
const REQUESTED_AT = new Date('2026-10-16T12:00:05.400Z');
const NOW = new Date('2026-10-16T12:00:09.000Z');
const ctx = { orgId: ORG, effectRequestedAt: REQUESTED_AT, actorId: 'actor-1', phase: 'post' as const };
const preCtx = { ...ctx, phase: 'pre' as const };
const clock = () => NOW;

const userResource = (fields: Record<string, unknown>) =>
  ({ ok: true, kind: 'resource', resource: { id: USER_ID, userPrincipalName: 'a@b.com', ...fields } });
const notFound = { ok: false, code: 'graph_not_found', message: 'nf' };
const collection = (items: Record<string, unknown>[]) => ({ ok: true, kind: 'collection', items, truncated: false });

const ACTIONS: Record<M365WriteActionId, M365MutatingAction> = {
  'm365.user.disable': { type: 'm365.user.disable', userIdentifier: 'a@b.com', reason: 'x' },
  'm365.user.reset_password': { type: 'm365.user.reset_password', userIdentifier: 'a@b.com', reason: 'x' },
  'm365.user.revoke_sessions': { type: 'm365.user.revoke_sessions', userIdentifier: 'a@b.com', reason: 'x' },
  'm365.user.license.remove': { type: 'm365.user.license.remove', userIdentifier: 'a@b.com', skuIds: [SKU_A], reason: 'x' },
  'm365.user.license.assign': { type: 'm365.user.license.assign', userIdentifier: 'a@b.com', skuIds: [SKU_A, SKU_B], reason: 'x' },
  'm365.group.membership.remove': { type: 'm365.group.membership.remove', groupId: GROUP, userIdentifier: 'a@b.com', reason: 'x' },
  'm365.group.membership.add': { type: 'm365.group.membership.add', groupId: GROUP, userIdentifier: 'a@b.com', reason: 'x' },
  'm365.intune.device.retire': { type: 'm365.intune.device.retire', managedDeviceId: DEVICE, reason: 'x' },
  'm365.user.create': {
    type: 'm365.user.create', userPrincipalName: 'new@b.com', displayName: 'New', mailNickname: 'new', usageLocation: 'US', reason: 'x',
  },
  'm365.user.mailbox.auto_reply': {
    type: 'm365.user.mailbox.auto_reply', userIdentifier: 'a@b.com', status: 'alwaysEnabled', externalAudience: 'all', reason: 'x',
  },
};

const autoReplyState = (fields: Record<string, unknown>) => ({
  ok: true,
  result: {
    success: true, action: 'm365.user.mailbox.auto_reply.state', userId: USER_ID, status: 'alwaysEnabled',
    externalAudience: 'all', hasInternalReplyMessage: true, hasExternalReplyMessage: true,
    scheduledStartDateTime: null, scheduledEndDateTime: null, ...fields,
  },
});

interface ProbeCase {
  satisfied: () => void;
  unsatisfied: () => void;
}

/**
 * Total over the write ids: adding an action without a probe case is a
 * compile error here, exactly as PROBES is in the implementation.
 */
const CASES: Record<Exclude<M365WriteActionId, 'm365.user.reset_password'>, ProbeCase> = {
  'm365.user.disable': {
    satisfied: () => readByOrg.mockResolvedValueOnce(userResource({ accountEnabled: false })),
    unsatisfied: () => readByOrg.mockResolvedValueOnce(userResource({ accountEnabled: true })),
  },
  'm365.user.revoke_sessions': {
    // Graph truncates the cutoff to whole seconds: 12:00:05Z is AT the request second.
    satisfied: () => readByOrg.mockResolvedValueOnce(userResource({ signInSessionsValidFromDateTime: '2026-10-16T12:00:05Z' })),
    unsatisfied: () => readByOrg.mockResolvedValueOnce(userResource({ signInSessionsValidFromDateTime: '2026-10-16T11:00:00Z' })),
  },
  'm365.user.license.remove': {
    satisfied: () => readByOrg.mockResolvedValueOnce(userResource({ assignedLicenses: [{ skuId: SKU_B, disabledPlans: [] }] })),
    unsatisfied: () => readByOrg.mockResolvedValueOnce(userResource({ assignedLicenses: [{ skuId: SKU_A, disabledPlans: [] }] })),
  },
  'm365.user.license.assign': {
    satisfied: () => readByOrg.mockResolvedValueOnce(userResource({
      assignedLicenses: [{ skuId: SKU_A, disabledPlans: [] }, { skuId: SKU_B, disabledPlans: [] }],
    })),
    unsatisfied: () => readByOrg.mockResolvedValueOnce(userResource({ assignedLicenses: [{ skuId: SKU_A, disabledPlans: [] }] })),
  },
  'm365.group.membership.remove': {
    satisfied: () => readByOrg.mockResolvedValueOnce(userResource({})).mockResolvedValueOnce(collection([])),
    unsatisfied: () => readByOrg.mockResolvedValueOnce(userResource({})).mockResolvedValueOnce(collection([{ id: USER_ID }])),
  },
  'm365.group.membership.add': {
    satisfied: () => readByOrg.mockResolvedValueOnce(userResource({})).mockResolvedValueOnce(collection([{ id: USER_ID }])),
    unsatisfied: () => readByOrg.mockResolvedValueOnce(userResource({})).mockResolvedValueOnce(collection([])),
  },
  'm365.intune.device.retire': {
    satisfied: () => readByOrg.mockResolvedValueOnce(notFound),
    unsatisfied: () => readByOrg.mockResolvedValueOnce({ ok: true, kind: 'resource', resource: { id: DEVICE, managementState: 'managed' } }),
  },
  'm365.user.create': {
    satisfied: () => readByOrg.mockResolvedValueOnce(userResource({})),
    unsatisfied: () => readByOrg.mockResolvedValueOnce(notFound),
  },
  'm365.user.mailbox.auto_reply': {
    satisfied: () => writeByOrg.mockResolvedValueOnce(autoReplyState({})),
    unsatisfied: () => writeByOrg.mockResolvedValueOnce(autoReplyState({ status: 'disabled' })),
  },
};

async function probe(id: M365WriteActionId, action: M365MutatingAction = ACTIONS[id]): Promise<M365EffectProbeResult> {
  return probeM365Effect(id, action, ctx, clock);
}

beforeEach(() => {
  readByOrg.mockReset();
  writeByOrg.mockReset();
});

describe('probeM365Effect — one satisfied and one unsatisfied observation per action', () => {
  for (const [id, c] of Object.entries(CASES) as [keyof typeof CASES, ProbeCase][]) {
    it(`${id}: satisfied`, async () => {
      c.satisfied();
      expect((await probe(id)).state).toBe('satisfied');
    });
    it(`${id}: unsatisfied`, async () => {
      c.unsatisfied();
      expect((await probe(id)).state).toBe('unsatisfied');
    });
  }
});

describe('probeM365Effect — honest criteria', () => {
  it('revoke_sessions: a cutoff one second before the request is unsatisfied, and the detail names the field', async () => {
    readByOrg.mockResolvedValueOnce(userResource({ signInSessionsValidFromDateTime: '2026-10-16T12:00:04Z' }));
    const result = await probe('m365.user.revoke_sessions');
    expect(result.state).toBe('unsatisfied');
    expect(result.detail).toContain('signInSessionsValidFromDateTime');
  });

  it('revoke_sessions: an absent cutoff is unsatisfied, never satisfied', async () => {
    readByOrg.mockResolvedValueOnce(userResource({}));
    const result = await probe('m365.user.revoke_sessions');
    expect(result.state).toBe('unsatisfied');
    expect(result.detail).toContain('signInSessionsValidFromDateTime');
  });

  it('disable probes the user read with the action’s identifier', async () => {
    readByOrg.mockResolvedValueOnce(userResource({ accountEnabled: false }));
    await probe('m365.user.disable');
    expect(readByOrg).toHaveBeenCalledWith(ORG, { type: 'm365.user.get', userIdOrUpn: 'a@b.com' }, { actorId: 'actor-1' });
  });

  it('disable probes the pinned oid when the action carries one (no identifier)', async () => {
    readByOrg.mockResolvedValueOnce(userResource({ accountEnabled: false }));
    const OID = '77777777-7777-4777-8777-777777777777';
    const r = await probeM365Effect('m365.user.disable', { type: 'm365.user.disable', oid: OID, reason: 'x' } as M365MutatingAction, ctx, clock);
    expect(r.state).toBe('satisfied');
    expect(readByOrg).toHaveBeenCalledWith(ORG, { type: 'm365.user.get', userIdOrUpn: OID }, { actorId: 'actor-1' });
  });

  it('group membership: resolves the user id, then reads the targeted membership by GUID', async () => {
    CASES['m365.group.membership.remove'].satisfied();
    await probe('m365.group.membership.remove');
    expect(readByOrg).toHaveBeenNthCalledWith(2, ORG, { type: 'm365.group.member.get', groupId: GROUP, userId: USER_ID }, { actorId: 'actor-1' });
  });

  it('group membership: a user that cannot be resolved is unknown', async () => {
    readByOrg.mockResolvedValueOnce(notFound);
    expect((await probe('m365.group.membership.remove')).state).toBe('unknown');
    expect(readByOrg).toHaveBeenCalledTimes(1);
  });

  it('license.assign: a SKU present with different disabled plans than requested is unsatisfied', async () => {
    readByOrg.mockResolvedValueOnce(userResource({ assignedLicenses: [{ skuId: SKU_A, disabledPlans: [] }] }));
    const action: M365MutatingAction = { ...ACTIONS['m365.user.license.assign'], skuIds: [SKU_A], disabledPlanIds: [PLAN] } as M365MutatingAction;
    expect((await probe('m365.user.license.assign', action)).state).toBe('unsatisfied');
  });

  it('license probes: an absent or malformed assignedLicenses is unknown', async () => {
    readByOrg.mockResolvedValueOnce(userResource({}));
    expect((await probe('m365.user.license.remove')).state).toBe('unknown');
    readByOrg.mockResolvedValueOnce(userResource({ assignedLicenses: [{ nope: true }] }));
    expect((await probe('m365.user.license.assign')).state).toBe('unknown');
  });

  it('intune retire: graph_not_found is satisfied, a retire-pending record is satisfied, throttling is unknown', async () => {
    readByOrg.mockResolvedValueOnce(notFound);
    expect((await probe('m365.intune.device.retire')).state).toBe('satisfied');
    readByOrg.mockResolvedValueOnce({ ok: true, kind: 'resource', resource: { id: DEVICE, managementState: 'retirePending' } });
    expect((await probe('m365.intune.device.retire')).state).toBe('satisfied');
    readByOrg.mockResolvedValueOnce({ ok: false, code: 'graph_throttled', message: 't', retryAfterSeconds: 5 });
    expect((await probe('m365.intune.device.retire')).state).toBe('unknown');
    readByOrg.mockResolvedValueOnce({ ok: true, kind: 'resource', resource: { id: DEVICE } });
    expect((await probe('m365.intune.device.retire')).state).toBe('unknown');
  });

  it('auto-reply: audience must match when the request set one', async () => {
    writeByOrg.mockResolvedValueOnce(autoReplyState({ externalAudience: 'contactsOnly' }));
    expect((await probe('m365.user.mailbox.auto_reply')).state).toBe('unsatisfied');
  });

  it('auto-reply: probes through the actions executor’s read-only arm, never a mutating arm', async () => {
    writeByOrg.mockResolvedValueOnce(autoReplyState({}));
    await probe('m365.user.mailbox.auto_reply');
    expect(writeByOrg).toHaveBeenCalledWith(
      ORG,
      { type: 'm365.user.mailbox.auto_reply.state', userIdentifier: 'a@b.com' },
      { actorId: 'actor-1' },
    );
    expect(readByOrg).not.toHaveBeenCalled();
  });

  it('reset_password has no observable end state: always unknown, never a read', async () => {
    const result = await probe('m365.user.reset_password');
    expect(result).toMatchObject({
      state: 'unknown',
      detail: 'a password reset has no observable end state; verification is the operator receiving the credential',
    });
    expect(readByOrg).not.toHaveBeenCalled();
    expect(writeByOrg).not.toHaveBeenCalled();
  });
});

describe('probeM365Effect — a probe that cannot observe never claims success', () => {
  const refusals = ['connection_not_ready', 'read_rate_limited', 'executor_unavailable', 'tools_disabled', 'graph_permission_missing'];

  for (const id of Object.keys(CASES) as (keyof typeof CASES)[]) {
    it.each(refusals)(`${id}: read refusal %s is unknown`, async (code) => {
      readByOrg.mockResolvedValue({ ok: false, code, message: 'refused' });
      writeByOrg.mockResolvedValue({ ok: false, code, message: 'refused' });
      expect((await probe(id)).state).toBe('unknown');
    });
  }
});

describe('probeM365Effect — a PRE-write probe never skips a write on weak evidence', () => {
  // A pre-phase `satisfied` makes the operator record a no-op and skip the
  // write, so it must rest on evidence that the effect really happened.
  it('intune retire: a missing device record before the write is unknown (a wrong id also 404s)', async () => {
    readByOrg.mockResolvedValueOnce(notFound);
    expect((await probeM365Effect('m365.intune.device.retire', ACTIONS['m365.intune.device.retire'], preCtx, clock)).state)
      .toBe('unknown');
  });

  it('group membership: the eventually consistent index never satisfies a pre-write probe', async () => {
    CASES['m365.group.membership.remove'].satisfied();
    expect((await probeM365Effect('m365.group.membership.remove', ACTIONS['m365.group.membership.remove'], preCtx, clock)).state)
      .toBe('unknown');
    CASES['m365.group.membership.add'].satisfied();
    expect((await probeM365Effect('m365.group.membership.add', ACTIONS['m365.group.membership.add'], preCtx, clock)).state)
      .toBe('unknown');
  });

  it('group membership: a post-write observation still verifies', async () => {
    CASES['m365.group.membership.remove'].satisfied();
    expect((await probe('m365.group.membership.remove')).state).toBe('satisfied');
  });
});

describe('probeM365Effect — auto-reply compares everything it can observe', () => {
  const scheduled = {
    type: 'm365.user.mailbox.auto_reply', userIdentifier: 'a@b.com', status: 'scheduled',
    scheduledStartDateTime: '2026-10-20T00:00:00Z', scheduledEndDateTime: '2026-10-27T00:00:00Z', reason: 'x',
  } as M365MutatingAction;
  const stateFor = (fields: Record<string, unknown>) => autoReplyState({
    status: 'scheduled', scheduledStartDateTime: '2026-10-20T00:00:00.000Z', scheduledEndDateTime: '2026-10-27T00:00:00.000Z',
    hasInternalReplyMessage: false, hasExternalReplyMessage: false, ...fields,
  });

  it('a different schedule window is unsatisfied', async () => {
    writeByOrg.mockResolvedValueOnce(stateFor({ scheduledStartDateTime: '2026-09-01T00:00:00.000Z' }));
    expect((await probe('m365.user.mailbox.auto_reply', scheduled)).state).toBe('unsatisfied');
  });

  it('the same schedule window is satisfied', async () => {
    writeByOrg.mockResolvedValueOnce(stateFor({}));
    expect((await probe('m365.user.mailbox.auto_reply', scheduled)).state).toBe('satisfied');
  });

  it('a requested message that is absent is unsatisfied', async () => {
    writeByOrg.mockResolvedValueOnce(stateFor({ hasInternalReplyMessage: false }));
    const withMessage = { ...scheduled, internalReplyMessage: 'Away' } as M365MutatingAction;
    expect((await probe('m365.user.mailbox.auto_reply', withMessage)).state).toBe('unsatisfied');
  });

  it('a requested message body cannot be read back: unknown before the write, satisfied (with a caveat) after', async () => {
    const withMessage = { ...scheduled, internalReplyMessage: 'Away' } as M365MutatingAction;
    writeByOrg.mockResolvedValueOnce(stateFor({ hasInternalReplyMessage: true }));
    expect((await probeM365Effect('m365.user.mailbox.auto_reply', withMessage, preCtx, clock)).state).toBe('unknown');
    writeByOrg.mockResolvedValueOnce(stateFor({ hasInternalReplyMessage: true }));
    const post = await probe('m365.user.mailbox.auto_reply', withMessage);
    expect(post.state).toBe('satisfied');
    expect(post.detail).toContain('not compared');
  });
});

describe('probeM365Effect — contract', () => {
  it('throws when the action id does not match the arguments', async () => {
    await expect(probeM365Effect('m365.user.disable', ACTIONS['m365.user.create'], ctx, clock)).rejects.toThrow(/does not match/);
  });

  it('stamps observedAt from the injected clock as an ISO-8601 instant', async () => {
    readByOrg.mockResolvedValueOnce(userResource({ accountEnabled: false }));
    expect((await probe('m365.user.disable')).observedAt).toBe(NOW.toISOString());
  });

  it('bounds detail to 500 characters', async () => {
    readByOrg.mockResolvedValueOnce(notFound);
    const longUpn = `${'a'.repeat(300)}@${'b'.repeat(15)}.com`;
    const action = { ...ACTIONS['m365.user.create'], userPrincipalName: longUpn } as M365MutatingAction;
    expect((await probe('m365.user.create', action)).detail.length).toBeLessThanOrEqual(500);
  });

  it('never repeats a credential in detail', async () => {
    readByOrg.mockResolvedValueOnce(userResource({ temporaryPassword: 'SECRET-PW-123' }));
    const result = await probe('m365.user.create');
    expect(JSON.stringify(result)).not.toContain('SECRET-PW-123');
  });
});
