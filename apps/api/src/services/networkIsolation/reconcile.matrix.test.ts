import { inspect } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceNetworkIsolation } from '../../db/schema';
import type { EpisodeTx } from './episodeStore';
const store = vi.hoisted(() => ({ row: null as DeviceNetworkIsolation | null, writes: [] as Record<string, unknown>[] }));
vi.mock('./episodeStore', async (original) => ({
  ...(await original<typeof import('./episodeStore')>()),
  findUnresolvedEpisode: vi.fn(async () => store.row && !['released','expired','failed','uninstalled'].includes(store.row.state) ? store.row : null),
  findUnconfirmedTombstone: vi.fn(async () => store.row?.desiredState === 'released' && !store.row.releaseConfirmedAt ? store.row : null),
  withEpisodeLock: vi.fn(async (_tx, id, fn) => store.row?.id === id ? { found: true, value: await fn(store.row) } : { found: false }),
  writeEpisodeSnapshot: vi.fn(async (_tx, _id, _prev, next) => { Object.assign(store.row!, next); return true; }),
}));
vi.mock('../secretCrypto', () => ({ decryptSecret: vi.fn(() => Buffer.alloc(32, 7).toString('base64')) }));
import { buildContainmentHeartbeatBlock, reconcileContainmentReport } from './reconcile';
const id = '11111111-1111-4111-8111-111111111111';
const device = { id: '22222222-2222-4222-8222-222222222222', orgId: '33333333-3333-4333-8333-333333333333', agentServerUrl: 'https://control.example.test' };
const now = new Date('2026-10-31T12:00:00Z');
const allow = [{ kind: 'host', host: 'control.example.test', ports: [443], proto: 'tcp', scope: 'breeze' }];
const tx = {
  update: vi.fn(() => ({ set: vi.fn((v) => { store.writes.push(v); if ('lastAgentReport' in v) Object.assign(store.row!, v); return { where: vi.fn(async () => undefined) }; }) })),
  insert: vi.fn(() => ({ values: vi.fn(async (v) => { store.writes.push(v); }) })),
} as unknown as EpisodeTx;
function row(desired = 'isolated'): DeviceNetworkIsolation {
  return { id, deviceId: device.id, orgId: device.orgId, generation: 2, lastJournalSeq: 5,
    state: desired === 'isolated' ? 'applied' : 'release_requested', desiredState: desired,
    expiresAt: new Date('2026-11-03T12:00:00Z'), deadManSeconds: 0, remoteRelay: false,
    incidentId: '44444444-4444-4444-8444-444444444444', breakGlassSecretEnc: 'ciphertext', breakGlassAckSeq: null, allowSnapshot: allow,
    releaseConfirmedAt: null, failureCode: null, releaseKind: null, lastAgentReport: null,
  } as unknown as DeviceNetworkIsolation;
}
beforeEach(() => { store.row = row(); store.writes = []; vi.clearAllMocks(); });
describe('heartbeat reconcile matrix', () => {
  for (const desired of ['isolated','released','none']) for (const state of ['missing','none','applied','verified','released','expired','released_locally','self_released','failed'])
    for (const generation of [1,2,3]) for (const journalSeq of [5,6]) {
      it(`${desired}/${state}/generation=${generation}/seq=${journalSeq}`, async () => {
        store.row = desired === 'none' ? null : row(desired);
        const report = state === 'missing' ? undefined : state === 'none' ? { isolationId: null, phase: 'none' } :
          { isolationId: id, generation, journalSeq, state, phase: state === 'applied' || state === 'verified' ? 'committed' : 'released' };
        await reconcileContainmentReport(tx, device, report, now);
        if (!store.row) { expect(store.writes).toEqual([]); return; }
        if (state === 'missing') { expect(store.row.lastJournalSeq).toBe(5); return; }
        if (state !== 'none' && (generation !== 2 || journalSeq <= 5)) {
          expect(store.row.state).toBe(desired === 'isolated' ? 'applied' : 'release_requested');
          expect(store.row.lastAgentReport).toBeNull();
          return;
        }
        if (desired === 'released' && ['released','none'].includes(state)) expect(store.row.releaseConfirmedAt).toEqual(now);
        if (desired === 'released' && state === 'applied') expect((await buildContainmentHeartbeatBlock(tx, device)).networkIsolation?.desired).toBe('released');
        if (desired === 'isolated' && state === 'released') {
          expect(store.row.state).toBe('released_locally');
          expect(tx.insert).toHaveBeenCalled();
        }
      });
    }
  it('classifies heartbeat failure from a typed journal event, never lastError prose', async () => {
    await reconcileContainmentReport(tx, device, { isolationId: id, generation: 2, journalSeq: 6, state: 'failed', phase: 'rolled_back', lastError: 'unsupported_platform', events: [{ seq: 6, at: now.toISOString(), type: 'failed_control_plane_unreachable', isolationId: id, generation: 2 }] }, now);
    expect(store.row!.failureCode).toBe('control_plane_unreachable');
  });
  it('does not classify heartbeat failure by diagnostic text alone', async () => {
    await reconcileContainmentReport(tx, device, { isolationId: id, generation: 2, journalSeq: 6, state: 'failed', phase: 'rolled_back', lastError: 'unsupported_platform' }, now);
    expect(store.row!.failureCode).toBe('apply_error');
  });

  it('does not cancel a not-yet-delivered isolation when a fresh agent reports bare absence', async () => {
    store.row!.state = 'dispatched';
    await reconcileContainmentReport(tx, device, { isolationId: null, phase: 'none' }, now);
    expect(store.row).toMatchObject({ state: 'dispatched', desiredState: 'isolated', lastJournalSeq: 5 });
    expect((await buildContainmentHeartbeatBlock(tx, device)).networkIsolation?.desired).toBe('isolated');
  });

  it('confirms a resolved not_delivered tombstone before removing it', async () => {
    store.row = { ...row('released'), state: 'failed', failureCode: 'not_delivered' };
    expect((await buildContainmentHeartbeatBlock(tx, device)).networkIsolation).toMatchObject({ desired: 'released', allow: [] });
    await reconcileContainmentReport(tx, device, { isolationId: id, generation: 2, journalSeq: 6, state: 'released', phase: 'released' }, now);
    expect(store.row.releaseConfirmedAt).toEqual(now);
    expect((await buildContainmentHeartbeatBlock(tx, device)).networkIsolation).toBeNull();
  });
  it('delivers the secret only until an ordered acknowledgement, with no report secret persisted', async () => {
    expect((await buildContainmentHeartbeatBlock(tx, device)).networkIsolation).toHaveProperty('breakGlassSecret');
    await reconcileContainmentReport(tx, device, { isolationId: id, generation: 2, journalSeq: 6, state: 'verified', phase: 'committed', secretAckSeq: 6, breakGlassSecret: 'NEVER-PERSIST' }, now);
    expect((await buildContainmentHeartbeatBlock(tx, device)).networkIsolation).not.toHaveProperty('breakGlassSecret');
    expect(inspect(store.writes, { depth: 8 })).not.toContain('NEVER-PERSIST');
  });
  it('journals drift without forwarding resolved addresses', async () => {
    store.row!.lastAgentReport = { ruleDigest: 'before' };
    await reconcileContainmentReport(tx, device, { isolationId: id, generation: 2, journalSeq: 6, state: 'verified', phase: 'committed', ruleDigest: 'after', resolvedAddresses: ['192.0.2.1'] }, now);
    expect(inspect(store.writes, { depth: 8 })).toContain('drift_reapplied');
    expect(JSON.stringify(await buildContainmentHeartbeatBlock(tx, device))).not.toContain('192.0.2.1');
  });
});
