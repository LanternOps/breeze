import { inspect } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceNetworkIsolation } from '../../db/schema';
const state = vi.hoisted(() => ({ row: null as DeviceNetworkIsolation | null, writes: [] as Array<{table: unknown; fields: Record<string, unknown>}>, published: vi.fn(), snapshot: vi.fn() }));
vi.mock('../../db', () => ({ db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx) }, runAfterDbContextCommit: (_label: string, fn: () => unknown) => fn() }));
vi.mock('../eventBus', () => ({ publishEvent: (...args: unknown[]) => state.published(...args) }));
vi.mock('./episodeStore', async original => ({
  ...(await original<typeof import('./episodeStore')>()),
  withEpisodeLock: async (_tx: unknown, id: string, fn: (row: DeviceNetworkIsolation) => Promise<unknown>) => state.row?.id === id ? { found: true, value: await fn({ ...state.row }) } : { found: false },
  writeEpisodeSnapshot: async (_tx: unknown, _id: string, prev: unknown, next: unknown) => { state.snapshot(prev, next); Object.assign(state.row!, next); return true; },
}));
import { deviceNetworkIsolations, incidentActions, incidents } from '../../db/schema';
import { handleNetworkIsolationResult, handleReleaseContainmentResult } from './finalizer';
const id = '11111111-1111-4111-8111-111111111111';
const commandId = '22222222-2222-4222-8222-222222222222';
const deviceId = '33333333-3333-4333-8333-333333333333';
const tx: any = {
  update: (table: unknown) => ({ set: (fields: Record<string, unknown>) => { state.writes.push({ table, fields }); return { where: () => ({ returning: async () => [{ id: 'action', executedBy: 'user', description: 'Network isolation' }], then: (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve) }) }; } }),
  select: () => { const q: any = { from: () => q, where: () => q, limit: () => q, for: () => q, then: (resolve: (v: unknown) => unknown) => Promise.resolve([{ id: 'incident', orgId: 'org', status: 'detected' }]).then(resolve) }; return q; },
};
function input(over: Record<string, unknown> = {}): Parameters<typeof handleNetworkIsolationResult>[0] {
  return { agentId: 'agent', commandId, resolvedDeviceId: deviceId,
    command: { id: commandId, deviceId, status: 'sent', payload: { actionType: 'network_isolation', incidentId: 'incident', actionId: 'action', parameters: { isolationId: id, generation: 1 } } },
    result: { status: 'completed' }, stdout: JSON.stringify({ isolationId: id, generation: 1, journalSeq: 2, state: 'verified', phase: 'committed' }), ...over } as never;
}
beforeEach(() => {
  vi.clearAllMocks(); state.writes = [];
  state.row = { id, deviceId, orgId: 'org', incidentId: 'incident', incidentActionId: 'action', commandId, releaseCommandId: commandId,
    state: 'applied', desiredState: 'isolated', generation: 1, lastJournalSeq: 1, failureCode: null, releaseKind: null,
    expiresAt: new Date('2026-11-03T00:00:00Z'), releaseConfirmedAt: null, breakGlassSecretEnc: 'ciphertext' } as DeviceNetworkIsolation;
});
describe('ordered isolation finalizer', () => {
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
