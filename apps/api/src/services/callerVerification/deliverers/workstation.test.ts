import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  db: null as any,
  contexts: [] as string[],
  inTx: true,
  enabled: true,
  ready: vi.fn(),
  trust: vi.fn(),
  insertCommand: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock('../../../db', () => ({
  db: new Proxy({}, { get: (_, key) => m.db[key] }),
  assertInTransaction: (label: string) => { if (!m.inTx) throw new Error(`${label} requires a transaction`); },
  runOutsideDbContext: (fn: () => unknown) => { m.contexts.push('outside'); return fn(); },
  withSystemDbAccessContext: (fn: () => unknown, label?: string) => { m.contexts.push(`system:${label ?? ''}`); return fn(); },
}));
vi.mock('../../../config/env', () => ({ callerVerificationEnabled: () => m.enabled }));
vi.mock('../workstationCapabilities', () => ({ workstationReadiness: m.ready }));
vi.mock('../../sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../partnerTrust.commands', async () => {
  class TrustDeniedError extends Error {
    constructor(readonly code: string) { super(code); }
  }
  return { TrustDeniedError, assertDeviceExecuteAllowed: m.trust };
});
vi.mock('../../unassignedPool/deliveryEligibility', () => {
  class ParkedDeviceCommandRefusedError extends Error {}
  return { ParkedDeviceCommandRefusedError };
});
vi.mock('../../commandQueueInsert', () => ({ insertQueuedCommandInTransaction: m.insertCommand }));
vi.mock('../../commandDispatch', () => ({ claimPendingCommandForDelivery: m.claim, releaseClaimedCommandDelivery: m.release }));
vi.mock('../../agentCommandRelay', () => ({ dispatchCommandToAgent: m.dispatch }));

import { db } from '../../../db';
import { makeDbMock } from '../testing';
import { deliverWorkstation, prepareWorkstationVerification } from './workstation';
import { CallerVerificationValidationError } from '../errors';
import { TrustDeniedError } from '../../partnerTrust.commands';
import { ParkedDeviceCommandRefusedError } from '../../unassignedPool/deliveryEligibility';

const ID = '11111111-1111-4111-8111-111111111111';
const CMD = '22222222-2222-4222-8222-222222222222';
const created = new Date('2026-10-12T10:00:00Z');
const row = {
  id: ID, orgId: 'org-1', method: 'workstation', status: 'pending', contactId: 'contact-1',
  workstationDeviceRef: 'device-1', osUsername: 'alex', initiatedByUserId: 'user-1', technicianLabel: 'Sam',
  actionScope: 'reset_password', targetLabel: 'alex@example.com', matchValue: '42', decoyValues: ['17', '86'],
  reverseCode: '7319', createdAt: created, expiresAt: new Date(created.getTime() + 120_000),
} as any;

let state: ReturnType<typeof makeDbMock>;
const inserted = () => m.insertCommand.mock.calls.map((c) => c[1] as Record<string, any>);
beforeEach(() => {
  vi.clearAllMocks();
  m.contexts = []; m.inTx = true; m.enabled = true;
  state = makeDbMock(); m.db = state.db;
  m.ready.mockImplementation(async (_org: string, ids: string[]) => new Map(ids.map((id) => [id, ['alex']])));
  m.trust.mockResolvedValue(undefined);
  m.insertCommand.mockImplementation(async () => ({ id: CMD }));
});

describe('prepareWorkstationVerification', () => {
  function arrangeHappy() {
    state.results.push([{ id: 'device-1', orgId: 'org-1', status: 'online' }], [{ name: 'Acme' }], [{ id: ID }]);
  }

  it('persists the command and links it on the caller transaction only', async () => {
    arrangeHappy();
    await prepareWorkstationVerification(row);
    expect(m.contexts).toEqual([]); // no detached context inside start
    // Persisted through the gated insert chokepoint on the caller's own
    // transaction (the request-scoped db), never a hand-rolled insert.
    expect(m.insertCommand).toHaveBeenCalledTimes(1);
    expect(m.insertCommand.mock.calls[0]![0]).toBe(db);
    const values = inserted()[0]!;
    expect(values).toMatchObject({
      deviceId: 'device-1', type: 'caller_verify', targetRole: 'agent', createdBy: 'user-1',
      submittedOrgId: 'org-1', deliverBy: row.expiresAt,
    });
    expect(values.id).toMatch(/^[0-9a-f-]{36}$/);
    const payload = values.payload;
    expect(payload).toMatchObject({
      verificationId: ID, username: 'alex', technicianName: 'Sam', orgName: 'Acme',
      actionLabel: 'reset the password', targetLabel: 'alex@example.com', reverseCode: '7319', timeoutMs: 120_000,
    });
    expect([...payload.choices].sort()).toEqual(['17', '42', '86']);
    const set = state.calls.find((c) => c.name === 'set')!.args[0] as Record<string, unknown>;
    expect(set).toEqual({ agentCommandId: CMD, challengeChoices: payload.choices });
  });

  it.each([
    ['disable_user', 'disable the account'],
    ['any', 'confirm a support request'],
  ])('labels %s', async (actionScope, label) => {
    arrangeHappy();
    await prepareWorkstationVerification({ ...row, actionScope });
    expect(inserted()[0]!.payload.actionLabel).toBe(label);
  });

  it('sends the verification expiry as the absolute deadline (#8668)', async () => {
    arrangeHappy();
    await prepareWorkstationVerification(row);
    expect(inserted()[0]!.payload.deadlineAt).toBe(row.expiresAt.toISOString());
  });

  it('clamps the helper deadline into the shared bounds', async () => {
    arrangeHappy();
    await prepareWorkstationVerification({ ...row, expiresAt: new Date(created.getTime() + 900_000) });
    expect(inserted()[0]!.payload.timeoutMs).toBe(300_000);
  });

  it('refuses outside a transaction', async () => {
    m.inTx = false;
    await expect(prepareWorkstationVerification(row)).rejects.toThrow('transaction');
    expect(inserted()).toHaveLength(0);
  });

  it.each([
    ['no device', { workstationDeviceRef: null }, 'device_required'],
    ['no username', { osUsername: null }, 'device_required'],
  ])('refuses %s', async (_label, patch, code) => {
    await expect(prepareWorkstationVerification({ ...row, ...patch })).rejects.toMatchObject({ code });
    expect(inserted()).toHaveLength(0);
  });

  it('refuses an offline or foreign device as not found', async () => {
    state.results.push([]);
    await expect(prepareWorkstationVerification(row)).rejects.toMatchObject({ code: 'not_found' });
    expect(inserted()).toHaveLength(0);
  });

  it('refuses a selected device whose helper cannot render the card', async () => {
    state.results.push([{ id: 'device-1', orgId: 'org-1', status: 'online' }]);
    m.ready.mockResolvedValue(new Map([['device-1', ['someone-else']]]));
    await expect(prepareWorkstationVerification(row)).rejects.toMatchObject({ code: 'helper_outdated' });
    expect(m.ready).toHaveBeenCalledWith('org-1', ['device-1']);
    expect(inserted()).toHaveLength(0);
  });

  it('says the readiness store is unavailable instead of blaming the helper', async () => {
    state.results.push([{ id: 'device-1', orgId: 'org-1', status: 'online' }]);
    m.ready.mockResolvedValue(null);
    await expect(prepareWorkstationVerification(row)).rejects.toMatchObject({ code: 'readiness_unavailable' });
    expect(inserted()).toHaveLength(0);
  });

  it('turns a label the card cannot carry into a request error, not a crash', async () => {
    state.results.push([{ id: 'device-1', orgId: 'org-1', status: 'online' }], [{ name: 'Acme' }]);
    const err = await prepareWorkstationVerification({ ...row, technicianLabel: '   ' }).catch((e) => e);
    expect(err).toBeInstanceOf(CallerVerificationValidationError);
    expect(err.code).toBe('invalid_request');
    expect(inserted()).toHaveLength(0);
  });

  it('maps a partner-trust refusal to a request error', async () => {
    state.results.push([{ id: 'device-1', orgId: 'org-1', status: 'online' }]);
    m.trust.mockRejectedValue(new TrustDeniedError('probation' as never, 'x', 'device-1', 'caller_verify'));
    const err = await prepareWorkstationVerification(row).catch((e) => e);
    expect(err).toBeInstanceOf(CallerVerificationValidationError);
    expect(err.code).toBe('trust_denied');
    expect(inserted()).toHaveLength(0);
  });

  it('fails the start when the verification could not be linked', async () => {
    state.results.push([{ id: 'device-1', orgId: 'org-1', status: 'online' }], [{ name: 'Acme' }], []);
    await expect(prepareWorkstationVerification(row)).rejects.toThrow('link');
  });

  it('refuses a device parked in a holding org', async () => {
    state.results.push([{ id: 'device-1', orgId: 'org-1', status: 'online' }], [{ name: 'Acme' }]);
    m.insertCommand.mockRejectedValue(new ParkedDeviceCommandRefusedError('device-1', 'caller_verify'));
    await expect(prepareWorkstationVerification(row)).rejects.toMatchObject({ code: 'not_found' });
    expect(state.calls.some((c) => c.name === 'set')).toBe(false);
  });
});

describe('deliverWorkstation', () => {
  const payload = {
    verificationId: ID, username: 'alex', technicianName: 'Sam', orgName: 'Acme', actionLabel: 'reset the password',
    targetLabel: 'alex@example.com', reverseCode: '7319', choices: ['42', '17', '86'], timeoutMs: 120_000,
  };
  const loaded = { id: ID, commandId: CMD, payload, agentId: 'agent-1' };
  const executedAt = new Date();

  it('does nothing while the feature is disabled', async () => {
    m.enabled = false;
    await deliverWorkstation(ID);
    expect(m.claim).not.toHaveBeenCalled();
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it('does nothing for a row that is no longer deliverable', async () => {
    state.results.push([]);
    await deliverWorkstation(ID);
    expect(m.claim).not.toHaveBeenCalled();
  });

  it('claims and pushes the pre-created command id, outside any request context', async () => {
    state.results.push([loaded]);
    m.claim.mockResolvedValue({ status: 'claimed', id: CMD, executedAt });
    m.dispatch.mockResolvedValue({ status: 'sent', via: 'local' });
    await deliverWorkstation(ID);
    expect(m.claim).toHaveBeenCalledWith(CMD);
    expect(m.dispatch).toHaveBeenCalledWith('agent-1', { id: CMD, type: 'caller_verify', payload: loaded.payload });
    expect(m.release).not.toHaveBeenCalled();
    expect(m.contexts[0]).toBe('outside');
  });

  it('pushes a stored payload that carries the absolute deadline unchanged (#8668)', async () => {
    const withDeadline = { ...loaded, payload: { ...payload, deadlineAt: '2026-10-16T12:02:00.000Z' } };
    state.results.push([withDeadline]);
    m.claim.mockResolvedValue({ status: 'claimed', id: CMD, executedAt });
    m.dispatch.mockResolvedValue({ status: 'sent', via: 'local' });
    await deliverWorkstation(ID);
    expect(m.dispatch).toHaveBeenCalledWith('agent-1', { id: CMD, type: 'caller_verify', payload: withDeadline.payload });
  });

  it.each(['held', 'not_claimable', 'cancelled'])('never pushes a %s claim', async (status) => {
    state.results.push([loaded]);
    m.claim.mockResolvedValue({ status, id: CMD });
    await deliverWorkstation(ID);
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it.each(['offline', 'expired', 'owner_mismatch'])('releases the claim for heartbeat delivery when %s', async (status) => {
    state.results.push([loaded]);
    m.claim.mockResolvedValue({ status: 'claimed', id: CMD, executedAt });
    m.dispatch.mockResolvedValue({ status });
    await expect(deliverWorkstation(ID)).resolves.toBeUndefined();
    expect(m.release).toHaveBeenCalledWith(CMD, executedAt);
  });

  it('keeps an indeterminate send claimed (the frame may have arrived)', async () => {
    state.results.push([loaded]);
    m.claim.mockResolvedValue({ status: 'claimed', id: CMD, executedAt });
    m.dispatch.mockResolvedValue({ status: 'indeterminate' });
    await deliverWorkstation(ID);
    expect(m.release).not.toHaveBeenCalled();
  });

  it('releases and throws on an infrastructure error so the publisher retries the same command', async () => {
    state.results.push([loaded]);
    m.claim.mockResolvedValue({ status: 'claimed', id: CMD, executedAt });
    m.dispatch.mockResolvedValue({ status: 'infrastructure_error', message: 'redis down' });
    await expect(deliverWorkstation(ID)).rejects.toThrow('redis down');
    expect(m.release).toHaveBeenCalledWith(CMD, executedAt);
    expect(inserted()).toHaveLength(0); // a retry never mints a second command
  });

  it('refuses a stored payload that no longer matches the frozen shape', async () => {
    state.results.push([{ ...loaded, payload: { verificationId: ID, approved: true } }]);
    await expect(deliverWorkstation(ID)).rejects.toThrow();
    expect(m.claim).not.toHaveBeenCalled();
  });
});
