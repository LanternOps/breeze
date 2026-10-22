import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #9662: an `execute_containment` command's terminal outcome is the ONLY
 * evidence that a containment action ran. These tests drive the shared
 * finalizer the agent-result handler, the stale-command reaper and cancel
 * propagation all call, and assert what lands on `incident_actions` and
 * `incidents`.
 */

const { updateMock, selectMock, publishEventMock, afterCommitMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  selectMock: vi.fn(),
  publishEventMock: vi.fn(async () => 'evt-1'),
  afterCommitMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { update: updateMock, select: selectMock },
  runAfterDbContextCommit: (label: string, work: () => unknown) => afterCommitMock(label, work),
}));

vi.mock('./eventBus', () => ({ publishEvent: publishEventMock }));

import { incidentActions, incidents } from '../db/schema';
import {
  finalizeContainmentAction,
  handleExecuteContainmentResult,
} from './incidentContainmentResults';

const INCIDENT_ID = '22222222-2222-4222-8222-222222222222';
const COMMAND_ID = '44444444-4444-4444-8444-444444444444';
const ACTION_ID = '55555555-5555-4555-8555-555555555555';
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const COMPLETED_AT = new Date('2026-10-22T12:00:00.000Z');

const ACTION_ROW = {
  id: ACTION_ID,
  orgId: ORG_ID,
  actionType: 'process_kill',
  description: 'Containment: process_kill on device d-1',
  executedBy: 'brain',
};

type SetCall = { table: unknown; fields: Record<string, unknown> };

let setCalls: SetCall[];
let actionRows: unknown[];
let incidentRow: Record<string, unknown> | undefined;

function wireDb() {
  setCalls = [];
  updateMock.mockImplementation((table: unknown) => ({
    set: (fields: Record<string, unknown>) => {
      setCalls.push({ table, fields });
      const where = vi.fn(() => {
        const rows = table === incidentActions ? actionRows : [{ id: INCIDENT_ID }];
        const p: any = Promise.resolve(rows);
        p.returning = vi.fn(() => Promise.resolve(rows));
        return p;
      });
      return { where };
    },
  }));
  selectMock.mockImplementation(() => {
    const chain: any = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.for = vi.fn(() => chain);
    chain.then = (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(incidentRow ? [incidentRow] : []).then(resolve, reject);
    return chain;
  });
}

const actionUpdate = () => setCalls.find((c) => c.table === incidentActions)?.fields;
const incidentUpdate = () => setCalls.find((c) => c.table === incidents)?.fields;

beforeEach(() => {
  vi.clearAllMocks();
  actionRows = [ACTION_ROW];
  incidentRow = { id: INCIDENT_ID, orgId: ORG_ID, status: 'detected', timeline: [{ at: 'x', type: 'created', actor: 'brain', summary: 's' }] };
  afterCommitMock.mockImplementation((_label: string, work: () => unknown) => work());
  wireDb();
});

describe('finalizeContainmentAction (#9662)', () => {
  it('a completed agent result completes the action and contains a detected incident', async () => {
    const outcome = await finalizeContainmentAction({
      commandId: COMMAND_ID,
      payload: { incidentId: INCIDENT_ID, actionType: 'process_kill' },
      outcome: { kind: 'agent', status: 'completed', output: { pid: 4242, killed: true } },
      completedAt: COMPLETED_AT,
    });

    expect(outcome).toBe('applied');
    expect(actionUpdate()).toMatchObject({
      status: 'completed',
      result: { commandId: COMMAND_ID, commandStatus: 'completed', output: { pid: 4242, killed: true } },
    });
    const inc = incidentUpdate()!;
    expect(inc.status).toBe('contained');
    expect(inc.containedAt).toEqual(COMPLETED_AT);
    const timeline = inc.timeline as Array<Record<string, unknown>>;
    expect(timeline).toHaveLength(2);
    expect(timeline[1]).toMatchObject({
      type: 'containment_executed',
      actor: 'brain',
      metadata: { actionId: ACTION_ID, actionStatus: 'completed', commandId: COMMAND_ID },
    });
    // Deferred to after commit, then published asynchronously.
    await vi.waitFor(() => expect(publishEventMock).toHaveBeenCalledWith(
      'incident.contained',
      ORG_ID,
      expect.objectContaining({ incidentId: INCIDENT_ID, actionId: ACTION_ID, status: 'completed' }),
      expect.any(String),
    ));
  });

  it('publishes incident.contained only after commit', async () => {
    afterCommitMock.mockImplementation(() => undefined); // never commits
    await finalizeContainmentAction({
      commandId: COMMAND_ID,
      payload: { incidentId: INCIDENT_ID },
      outcome: { kind: 'agent', status: 'completed' },
      completedAt: COMPLETED_AT,
    });
    expect(afterCommitMock).toHaveBeenCalledTimes(1);
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it('a failed agent result fails the action and leaves the incident status alone', async () => {
    await finalizeContainmentAction({
      commandId: COMMAND_ID,
      payload: { incidentId: INCIDENT_ID },
      outcome: { kind: 'agent', status: 'failed', error: 'process not found (pid 4242)' },
      completedAt: COMPLETED_AT,
    });

    expect(actionUpdate()).toMatchObject({
      status: 'failed',
      result: { commandId: COMMAND_ID, commandStatus: 'failed', error: 'process not found (pid 4242)' },
    });
    const inc = incidentUpdate()!;
    expect(inc.status).toBeUndefined();
    expect(inc.containedAt).toBeUndefined();
    const timeline = inc.timeline as Array<Record<string, unknown>>;
    expect(timeline.at(-1)).toMatchObject({ type: 'containment_failed', metadata: { actionStatus: 'failed' } });
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it('a server timeout fails the action and marks it repairable by a late agent result', async () => {
    await finalizeContainmentAction({
      commandId: COMMAND_ID,
      payload: { incidentId: INCIDENT_ID },
      outcome: { kind: 'timeout', error: 'Server-side timeout: no response from agent' },
      completedAt: COMPLETED_AT,
    });

    expect(actionUpdate()).toMatchObject({
      status: 'failed',
      result: { commandId: COMMAND_ID, commandStatus: 'timeout', timedOutBy: 'server' },
    });
    expect(incidentUpdate()!.status).toBeUndefined();
  });

  it('a cancelled command cancels the action', async () => {
    await finalizeContainmentAction({
      commandId: COMMAND_ID,
      payload: { incidentId: INCIDENT_ID },
      outcome: { kind: 'cancelled', error: 'Cancelled before the device received it' },
      completedAt: COMPLETED_AT,
    });
    expect(actionUpdate()).toMatchObject({ status: 'cancelled' });
    expect((incidentUpdate()!.timeline as any[]).at(-1)).toMatchObject({ type: 'containment_cancelled' });
  });

  it('does not touch the incident when no open action matches (already terminal / replay)', async () => {
    actionRows = [];
    const outcome = await finalizeContainmentAction({
      commandId: COMMAND_ID,
      payload: { incidentId: INCIDENT_ID },
      outcome: { kind: 'agent', status: 'completed' },
      completedAt: COMPLETED_AT,
    });
    expect(outcome).toBe('no_action');
    expect(incidentUpdate()).toBeUndefined();
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it('ignores a payload without a valid incident id', async () => {
    const outcome = await finalizeContainmentAction({
      commandId: COMMAND_ID,
      payload: { incidentId: 'not-a-uuid' },
      outcome: { kind: 'agent', status: 'completed' },
      completedAt: COMPLETED_AT,
    });
    expect(outcome).toBe('no_action');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it.each(['contained', 'closed'])('a success does not re-contain an incident that is %s', async (status) => {
    incidentRow = { ...incidentRow!, status, containedAt: new Date('2026-10-01T00:00:00Z') };
    await finalizeContainmentAction({
      commandId: COMMAND_ID,
      payload: { incidentId: INCIDENT_ID },
      outcome: { kind: 'agent', status: 'completed' },
      completedAt: COMPLETED_AT,
    });
    expect(actionUpdate()).toMatchObject({ status: 'completed' });
    expect(incidentUpdate()!.status).toBeUndefined();
    expect(incidentUpdate()!.containedAt).toBeUndefined();
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it.each(['analyzing', 'recovering'])('a success contains an incident that is %s', async (status) => {
    incidentRow = { ...incidentRow!, status };
    await finalizeContainmentAction({
      commandId: COMMAND_ID,
      payload: { incidentId: INCIDENT_ID },
      outcome: { kind: 'agent', status: 'completed' },
      completedAt: COMPLETED_AT,
    });
    expect(incidentUpdate()!.status).toBe('contained');
  });

  it('writes through the supplied executor, not the ambient db', async () => {
    const txUpdate = vi.fn((table: unknown) => updateMock(table));
    const txSelect = vi.fn(() => selectMock());
    await finalizeContainmentAction({
      commandId: COMMAND_ID,
      payload: { incidentId: INCIDENT_ID },
      outcome: { kind: 'cancelled', error: 'x' },
      completedAt: COMPLETED_AT,
      executor: { update: txUpdate, select: txSelect } as never,
    });
    expect(txUpdate).toHaveBeenCalledTimes(2);
    expect(txSelect).toHaveBeenCalledTimes(1);
  });
});

describe('handleExecuteContainmentResult (#9662)', () => {
  const command = {
    id: COMMAND_ID,
    type: 'execute_containment',
    payload: { incidentId: INCIDENT_ID, actionType: 'process_kill', parameters: { pid: 4242 } },
  } as never;

  it('maps a completed agent result (stdout JSON) onto the action', async () => {
    await handleExecuteContainmentResult({
      agentId: 'agent-1',
      command,
      commandId: COMMAND_ID,
      resolvedDeviceId: 'd-1',
      result: { status: 'completed', exitCode: 0 },
      stdout: JSON.stringify({ actionType: 'process_kill', pid: 4242, name: 'evil.exe', killed: true }),
    });
    expect(actionUpdate()).toMatchObject({
      status: 'completed',
      result: { output: { actionType: 'process_kill', pid: 4242, name: 'evil.exe', killed: true } },
    });
    expect(incidentUpdate()!.status).toBe('contained');
  });

  it.each(['failed', 'timeout'] as const)('maps an agent-reported %s onto a failed action', async (status) => {
    await handleExecuteContainmentResult({
      agentId: 'agent-1',
      command,
      commandId: COMMAND_ID,
      resolvedDeviceId: 'd-1',
      result: { status, error: 'network_isolation requires platform-specific implementation' },
      stdout: undefined,
    });
    expect(actionUpdate()).toMatchObject({
      status: 'failed',
      result: { error: 'network_isolation requires platform-specific implementation' },
    });
    expect(incidentUpdate()!.status).toBeUndefined();
  });

  it('propagates a persistence failure so the transport parks the result reopenable', async () => {
    updateMock.mockImplementation(() => { throw new Error('db down'); });
    await expect(handleExecuteContainmentResult({
      agentId: 'agent-1',
      command,
      commandId: COMMAND_ID,
      resolvedDeviceId: 'd-1',
      result: { status: 'completed' },
      stdout: undefined,
    })).rejects.toThrow('db down');
  });
});
