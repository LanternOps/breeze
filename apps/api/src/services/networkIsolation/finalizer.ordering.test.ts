import { inspect } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceNetworkIsolation } from '../../db/schema';
const state = vi.hoisted(() => ({ row: null as DeviceNetworkIsolation | null, writes: [] as Array<{table: unknown; fields: Record<string, unknown>}>, published: vi.fn(), snapshot: vi.fn(), actionMissing: false, incidentMissing: false }));
vi.mock('../../db', () => ({ db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx) }, runAfterDbContextCommit: (_label: string, fn: () => unknown) => fn() }));
vi.mock('../eventBus', () => ({ publishEvent: (...args: unknown[]) => state.published(...args) }));
vi.mock('./episodeStore', async original => {
  const actual = await original<typeof import('./episodeStore')>();
  return {
    ...actual,
    findHeartbeatEpisode: async () => state.row,
    withEpisodeLock: async (_tx: unknown, id: string, fn: (row: DeviceNetworkIsolation) => Promise<unknown>) => state.row?.id === id ? { found: true, value: await fn({ ...state.row }) } : { found: false },
    writeEpisodeSnapshot: async (executor: any, id: string, prev: any, next: any, at: Date) => {
      state.snapshot(prev, next);
      const written = await actual.writeEpisodeSnapshot(executor, id, prev, next, at);
      Object.assign(state.row!, next);
      return written;
    },
  };
});
import { alerts, deviceNetworkIsolations, incidentActions, incidents } from '../../db/schema';
import { reconcileContainmentReport } from './reconcile';
import { captureException } from '../sentry';
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
import { handleNetworkIsolationResult, handleReleaseContainmentResult } from './finalizer';
const id = '11111111-1111-4111-8111-111111111111';
const commandId = '22222222-2222-4222-8222-222222222222';
const deviceId = '33333333-3333-4333-8333-333333333333';
const tx: any = {
  insert: (table: unknown) => ({ values: async (fields: Record<string, unknown>) => { state.writes.push({ table, fields }); } }),
  update: (table: unknown) => ({ set: (fields: Record<string, unknown>) => { state.writes.push({ table, fields }); return { where: () => ({ returning: async () => table === incidentActions && state.actionMissing ? [] : [{ id: 'action', executedBy: 'user', description: 'Network isolation' }], then: (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve) }) }; } }),
  select: () => { const q: any = { from: () => q, where: () => q, limit: () => q, for: () => q, then: (resolve: (v: unknown) => unknown) => Promise.resolve(state.incidentMissing ? [] : [{ id: 'incident', orgId: 'org', status: 'detected' }]).then(resolve) }; return q; },
};
function input(over: Record<string, unknown> = {}): Parameters<typeof handleNetworkIsolationResult>[0] {
  return { agentId: 'agent', commandId, resolvedDeviceId: deviceId,
    command: { id: commandId, deviceId, status: 'sent', payload: { actionType: 'network_isolation', incidentId: 'incident', actionId: 'action', parameters: { isolationId: id, generation: 1 } } },
    result: { status: 'completed' }, stdout: JSON.stringify({ isolationId: id, generation: 1, journalSeq: 2, state: 'verified', phase: 'committed' }), ...over } as never;
}
beforeEach(() => {
  vi.clearAllMocks(); state.writes = []; state.actionMissing = false; state.incidentMissing = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  state.row = { id, deviceId, orgId: 'org', incidentId: 'incident', incidentActionId: 'action', commandId, releaseCommandId: commandId,
    state: 'applied', desiredState: 'isolated', generation: 1, lastJournalSeq: 1, failureCode: null, releaseKind: null,
    expiresAt: new Date('2026-11-03T00:00:00Z'), releaseConfirmedAt: null, breakGlassSecretEnc: 'ciphertext' } as DeviceNetworkIsolation;
});
describe('ordered isolation finalizer', () => {
  it('accepts the spec/W1d result body without a heartbeat-only phase', async () => {
    await handleNetworkIsolationResult(input({ stdout: JSON.stringify({ isolationId: id, generation: 1, journalSeq: 2, state: 'verified', verifiedAt: '2026-10-31T12:00:00Z', rollback: false }) }));
    expect(state.row!.state).toBe('verified');
  });

  it('verifies, completes the action, and publishes incident.contained once across duplicate results', async () => {
    await handleNetworkIsolationResult(input()); await handleNetworkIsolationResult(input());
    expect(state.row!.state).toBe('verified');
    expect(state.writes.filter(x => x.table === incidentActions)).toHaveLength(1);
    expect(state.writes.find(x => x.table === incidentActions)?.fields).toMatchObject({ status: 'completed' });
    expect(state.published).toHaveBeenCalledTimes(1);
    expect(state.published).toHaveBeenCalledWith('incident.contained', 'org', expect.objectContaining({ actionType: 'network_isolation' }), expect.any(String));
    expect(inspect(state.writes.filter(x => x.table === incidents), { depth: 12 })).toContain('containment_executed');
  });
  it('ignores an older or duplicate sequence and any result for a resolved episode', async () => {
    state.row!.lastJournalSeq = 2;
    await handleNetworkIsolationResult(input()); expect(state.snapshot).not.toHaveBeenCalled();
    state.row!.state = 'failed'; state.row!.failureCode = 'not_delivered'; state.row!.desiredState = 'released';
    await handleNetworkIsolationResult(input({ stdout: JSON.stringify({ isolationId: id, generation: 1, journalSeq: 3, state: 'verified', phase: 'committed' }) }));
    expect(state.row!.state).toBe('failed'); expect(state.published).not.toHaveBeenCalled();
  });
  it('ignores a late completed result after the command reaper timed out, preserving desired isolation', async () => {
    const args = input(); args.command.status = 'failed'; args.command.result = { status: 'timeout' };
    await handleNetworkIsolationResult(args);
    expect(state.row!.state).toBe('applied'); expect(state.snapshot).not.toHaveBeenCalled();
  });
  it('allows a result_processing_failed retry', async () => {
    const args = input(); args.command.status = 'failed'; args.command.result = { status: 'result_processing_failed' };
    await handleNetworkIsolationResult(args); expect(state.row!.state).toBe('verified');
  });
  it('classifies failure by typed errorCode and writes containment_failed without agent prose', async () => {
    await handleNetworkIsolationResult(input({ result: { status: 'failed', error: 'control_plane_unreachable is misleading prose' }, stdout: JSON.stringify({ isolationId: id, generation: 1, journalSeq: 2, state: 'failed', phase: 'rolled_back', errorCode: 'isolation_enforcement_not_observed', rollback: true }) }));
    expect(state.row!.failureCode).toBe('enforcement_not_observed');
    expect(state.writes.find(x => x.table === incidentActions)?.fields).toMatchObject({ status: 'failed' });
    expect(inspect(state.writes, { depth: 12 })).toContain('containment_failed'); expect(inspect(state.writes, { depth: 12 })).not.toContain('misleading prose');
    expect(state.writes.find(x => x.table === deviceNetworkIsolations)?.fields).toMatchObject({ breakGlassSecretEnc: '' });
  });
  it.each(['released_locally', 'self_released', 'released'])('alerts once when %s arrives through the result before the heartbeat', async reportState => {
    const report = { isolationId: id, generation: 1, journalSeq: 2, state: reportState, phase: 'released' };
    await handleNetworkIsolationResult(input({ stdout: JSON.stringify(report) }));
    await handleNetworkIsolationResult(input({ stdout: JSON.stringify(report) }));
    await reconcileContainmentReport(tx, { id: deviceId, orgId: 'org' }, report, new Date());
    expect(state.writes.filter(x => x.table === alerts)).toHaveLength(1);
  });

  it('a release reverses the action once and confirms the tombstone', async () => {
    Object.assign(state.row!, { state: 'release_requested', desiredState: 'released', generation: 2 });
    const args = input({ command: { id: commandId, deviceId, status: 'sent', payload: { isolationId: id, generation: 2, reason: 'Operator release' } }, stdout: JSON.stringify({ isolationId: id, generation: 2, journalSeq: 3, state: 'released', phase: 'released' }) });
    await handleReleaseContainmentResult(args); await handleReleaseContainmentResult(args);
    expect(state.row!.state).toBe('released'); expect(state.row!.releaseConfirmedAt).toBeInstanceOf(Date);
    expect(state.writes.filter(x => x.table === incidentActions)).toHaveLength(1);
    expect(state.writes.find(x => x.table === incidentActions)?.fields.reversed).toBe(true);
    expect(inspect(state.writes, { depth: 12 })).toContain('containment_released');
  });
  it.each(['device','episode','generation','command'])('rejects a %s identity mismatch', async key => {
    const args = input();
    if (key === 'device') args.resolvedDeviceId = 'another-device';
    if (key === 'episode') args.stdout = args.stdout!.replace(id, '44444444-4444-4444-8444-444444444444');
    if (key === 'generation') args.stdout = args.stdout!.replace('"generation":1', '"generation":2');
    if (key === 'command') state.row!.commandId = 'another-command';
    await handleNetworkIsolationResult(args); expect(state.snapshot).not.toHaveBeenCalled();
  });
});

describe('ignored-result observability and typed fallback', () => {
  it.each([
    ['stdout_missing', { stdout: undefined }],
    ['stdout_oversize', { stdout: 'x'.repeat(8001) }],
    ['stdout_not_json', { stdout: '{' }],
    ['identity_schema', { stdout: JSON.stringify({ state: 'unknown' }) }],
    ['identity_mismatch', { resolvedDeviceId: 'other-device' }],
    ['episode_mismatch', { stdout: JSON.stringify({ isolationId: '44444444-4444-4444-8444-444444444444', generation: 1, journalSeq: 2, state: 'verified' }) }],
  ])('logs %s without agent body', async (reason, over) => {
    await handleNetworkIsolationResult(input(over));
    expect(console.warn).toHaveBeenCalledWith('[isolation] result ignored', { commandId, deviceId, reason });
    if (reason === 'identity_mismatch' || reason === 'episode_mismatch') expect(captureException).toHaveBeenCalled();
  });
  it('logs a transport timeout', async () => {
    const args = input(); args.command.status = 'failed'; args.command.result = { status: 'timeout' };
    await handleNetworkIsolationResult(args);
    expect(console.warn).toHaveBeenCalledWith('[isolation] result ignored', { commandId, deviceId, reason: 'transport_timeout' });
  });
  it('retains typed failures with missing stdout, bound generation, and the next server sequence', async () => {
    await handleNetworkIsolationResult(input({ result: { status: 'failed', errorCode: 'isolation_apply_error' }, stdout: undefined }));
    expect(state.row).toMatchObject({ state: 'failed', failureCode: 'apply_error', generation: 1, lastJournalSeq: 2 });
  });
});

describe('incident desynchronization visibility', () => {
  it.each(['actionMissing', 'incidentMissing'] as const)('reports %s with episode incident context', async key => {
    state[key] = true;
    await handleNetworkIsolationResult(input());
    expect(console.error).toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), undefined, { isolationId: id, incidentId: 'incident', incidentActionId: 'action' });
  });
  it('reports event publish errors with context', async () => {
    state.published.mockRejectedValueOnce(new Error('event bus failed'));
    await handleNetworkIsolationResult(input());
    await vi.waitFor(() => expect(captureException).toHaveBeenCalledWith(expect.any(Error), undefined, { phase: 'isolation_outcome_publish', isolationId: id, incidentId: 'incident', incidentActionId: 'action' }));
    expect(console.error).toHaveBeenCalled();
  });
});

it('classifies a result failure from its typed journal when errorCode is absent', async () => {
  await handleNetworkIsolationResult(input({ result: { status: 'failed' }, stdout: JSON.stringify({ isolationId: id, generation: 1, journalSeq: 2, state: 'failed', events: [{ seq: 2, at: new Date().toISOString(), type: 'failed_control_plane_unreachable' }] }) }));
  expect(state.row!.failureCode).toBe('control_plane_unreachable');
});
