import { inspect } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceNetworkIsolation } from '../../db/schema';
import type { EpisodeTx } from './episodeStore';
import { captureException } from '../sentry';
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
const store = vi.hoisted(() => ({ row: null as DeviceNetworkIsolation | null, writes: [] as Record<string, unknown>[] }));
vi.mock('./episodeStore', async (original) => ({
  ...(await original<typeof import('./episodeStore')>()),
  findHeartbeatEpisode: vi.fn(async () => store.row && !(store.row.desiredState === 'released' && store.row.releaseConfirmedAt) ? store.row : null),
  findUnresolvedEpisode: vi.fn(async () => store.row && !['released','expired','failed','uninstalled'].includes(store.row.state) ? store.row : null),
  findUnconfirmedTombstone: vi.fn(async () => store.row?.desiredState === 'released' && !store.row.releaseConfirmedAt ? store.row : null),
  withEpisodeLock: vi.fn(async (_tx, id, fn) => store.row?.id === id ? { found: true, value: await fn(store.row) } : { found: false }),
  writeEpisodeSnapshot: vi.fn(async (_tx, _id, _prev, next) => { Object.assign(store.row!, next); return true; }),
}));
vi.mock('../secretCrypto', () => ({ decryptSecret: vi.fn(() => Buffer.alloc(32, 7).toString('base64')) }));
import { buildContainmentHeartbeatBlock, reconcileContainmentReport, __resetIsolationLogThrottleForTests } from './reconcile';
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
beforeEach(() => { __resetIsolationLogThrottleForTests?.(); store.row = row(); store.writes = []; vi.clearAllMocks(); });
// Every same-generation/non-stale cell has a complete explicit outcome.
const EXPECTED = {
  isolated: {
    missing: { state: 'applied', confirmed: false, seq: 5, alerts: 0, journals: 0 },
    none: { state: 'applied', confirmed: false, seq: 5, alerts: 0, journals: 0 },
    applying: { state: 'applied', confirmed: false, seq: 5, alerts: 0, journals: 1 },
    applied: { state: 'applied', confirmed: false, seq: 6, alerts: 0, journals: 0 },
    verified: { state: 'verified', confirmed: false, seq: 6, alerts: 0, journals: 0 },
    released: { state: 'released_locally', confirmed: true, seq: 6, alerts: 1, journals: 1 },
    expired: { state: 'expired', confirmed: true, seq: 6, alerts: 0, journals: 0 },
    released_locally: { state: 'released_locally', confirmed: true, seq: 6, alerts: 1, journals: 1 },
    self_released: { state: 'self_released', confirmed: true, seq: 6, alerts: 1, journals: 1 },
    failed: { state: 'failed', confirmed: true, seq: 6, alerts: 0, journals: 0 },
  },
  released: {
    missing: { state: 'release_requested', confirmed: false, seq: 5, alerts: 0, journals: 0 },
    none: { state: 'released', confirmed: true, seq: 5, alerts: 0, journals: 0 },
    applying: { state: 'release_requested', confirmed: false, seq: 5, alerts: 0, journals: 1 },
    applied: { state: 'release_requested', confirmed: false, seq: 5, alerts: 0, journals: 1 },
    verified: { state: 'release_requested', confirmed: false, seq: 5, alerts: 0, journals: 1 },
    released: { state: 'released', confirmed: true, seq: 6, alerts: 0, journals: 0 },
    expired: { state: 'expired', confirmed: true, seq: 6, alerts: 0, journals: 0 },
    released_locally: { state: 'released', confirmed: true, seq: 6, alerts: 0, journals: 0 },
    self_released: { state: 'released', confirmed: true, seq: 6, alerts: 0, journals: 0 },
    failed: { state: 'release_requested', confirmed: false, seq: 5, alerts: 0, journals: 1 },
  },
} as const;
describe('heartbeat reconcile matrix', () => {
  for (const desired of ['isolated','released','none'] as const) for (const state of Object.keys(EXPECTED.isolated) as (keyof typeof EXPECTED.isolated)[])
    for (const generation of [1,2,3]) for (const journalSeq of [5,6]) {
      it(`${desired}/${state}/generation=${generation}/seq=${journalSeq}`, async () => {
        store.row = desired === 'none' ? null : row(desired);
        const report = state === 'missing' ? undefined : state === 'none' ? { isolationId: null, phase: 'none' } :
          { isolationId: id, generation, journalSeq, state, phase: state === 'applied' || state === 'verified' ? 'committed' : 'released' };
        await reconcileContainmentReport(tx, device, report, now);
        if (desired === 'none') { expect(store.writes).toEqual([]); return; }
        const stale = state !== 'none' && state !== 'missing' && (generation !== 2 || journalSeq <= 5);
        const expected = stale
          ? { state: desired === 'isolated' ? 'applied' : 'release_requested', confirmed: false, seq: 5, alerts: 0, journals: 1 }
          : EXPECTED[desired][state];
        expect(store.row).toMatchObject({ state: expected.state, releaseConfirmedAt: expected.confirmed ? now : null, lastJournalSeq: expected.seq });
        expect(store.writes.filter(v => 'title' in v)).toHaveLength(expected.alerts);
        expect(store.writes.filter(v => 'timeline' in v)).toHaveLength(expected.journals);
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
    store.row!.lastAgentReport = { isolationId: id, generation: 2, journalSeq: 5, state: 'applied', phase: 'committed', mechanism: null, ruleDigest: 'before' };
    await reconcileContainmentReport(tx, device, { isolationId: id, generation: 2, journalSeq: 6, state: 'verified', phase: 'committed', ruleDigest: 'after', resolvedAddresses: ['192.0.2.1'] }, now);
    expect(inspect(store.writes, { depth: 8 })).toContain('drift_reapplied');
    expect(JSON.stringify(await buildContainmentHeartbeatBlock(tx, device))).not.toContain('192.0.2.1');
  });
});

describe('review heartbeat fault tolerance', () => {
  it.each(['throw', 'null'])('delivers stored containment without a secret on decrypt %s', async (mode) => {
    const { decryptSecret } = await import('../secretCrypto');
    vi.mocked(decryptSecret).mockImplementationOnce(() => { if (mode === 'throw') throw new Error('decrypt'); return null; });
    const block = await buildContainmentHeartbeatBlock(tx, device);
    expect(block.networkIsolation).toMatchObject({ isolationId: id, desired: 'isolated' });
    expect(block.networkIsolation).not.toHaveProperty('breakGlassSecret');
  });
  it('logs only validation paths and device identity once when a report is dropped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let n = 0; n < 3; n++) await reconcileContainmentReport(tx, device, { state: 'SECRET-GARBAGE' }, now);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(inspect(warn.mock.calls)).toContain(device.id);
    expect(inspect(warn.mock.calls)).not.toContain('SECRET-GARBAGE');
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), undefined, expect.objectContaining({ phase: 'isolation_report_dropped', deviceId: device.id }));
    expect(inspect(vi.mocked(captureException).mock.calls)).not.toContain('SECRET-GARBAGE');
    warn.mockRestore();
  });
  it('does not journal three identical steady-state reports and refreshes held generation', async () => {
    store.row!.lastAgentReport = { isolationId: id, generation: 1, journalSeq: 5, state: 'applied', phase: 'committed', mechanism: null, ruleDigest: null };
    for (let n = 0; n < 3; n++) await reconcileContainmentReport(tx, device, { isolationId: id, generation: 2, journalSeq: 5, state: 'applied', phase: 'committed' }, now);
    expect(store.writes.filter(v => 'timeline' in v)).toHaveLength(0);
    expect(store.row!.lastAgentReport).toMatchObject({ generation: 2 });
  });
  it('does not accept an acknowledgement ahead of the reported journal', async () => {
    await reconcileContainmentReport(tx, device, { isolationId: id, generation: 2, journalSeq: 6, secretAckSeq: 7, state: 'applied', phase: 'committed' }, now);
    expect(store.row!.breakGlassAckSeq).toBeNull();
    expect((await buildContainmentHeartbeatBlock(tx, device)).networkIsolation).toHaveProperty('breakGlassSecret');
  });
});

it.each([undefined, { isolationId: null, phase: 'none' }])('uses one query across reconcile and block without an episode (%s)', async (report) => {
  store.row = null;
  const context = {};
  await reconcileContainmentReport(tx, device, report, now, context);
  await buildContainmentHeartbeatBlock(tx, device, context);
  const { findHeartbeatEpisode, withEpisodeLock } = await import('./episodeStore');
  expect(findHeartbeatEpisode).toHaveBeenCalledTimes(1);
  expect(withEpisodeLock).not.toHaveBeenCalled();
});

it.each([
  ['released_dead_man', 'self_released', 'dead_man'],
  ['released_local_code', 'released_locally', 'local_code'],
  ['released_local_forced', 'released_locally', 'local_forced'],
])('classifies release journal %s using the shared closed set', async (type, state, releaseKind) => {
  await reconcileContainmentReport(tx, device, { isolationId: id, generation: 2, journalSeq: 6, state: 'released', phase: 'released', events: [{ seq: 6, at: now.toISOString(), type }] }, now);
  expect(store.row).toMatchObject({ state, releaseKind });
});
it('reports allowlist fallback once while preserving the stored permits', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  for (let i = 0; i < 3; i++) {
    const block = await buildContainmentHeartbeatBlock(tx, { ...device, agentServerUrl: 'invalid-url' });
    expect(block.networkIsolation).toMatchObject({ allow });
  }
  expect(error).toHaveBeenCalledTimes(1);
  expect(inspect(error.mock.calls)).toContain('allowlist fallback');
  expect(captureException).toHaveBeenCalledTimes(1);
  expect(captureException).toHaveBeenCalledWith(expect.any(Error), undefined, { phase: 'isolation_allowlist_fallback', source: 'configuration' });
  error.mockRestore();
});

it('captures a decrypt outage once per episode while every beat retains containment', async () => {
  const { decryptSecret } = await import('../secretCrypto');
  for (let i = 0; i < 3; i++) {
    vi.mocked(decryptSecret).mockImplementationOnce(() => { throw new Error('decrypt'); });
    expect((await buildContainmentHeartbeatBlock(tx, device)).networkIsolation).toMatchObject({ isolationId: id });
  }
  expect(captureException).toHaveBeenCalledTimes(1);
  expect(captureException).toHaveBeenCalledWith(expect.any(Error), undefined, { phase: 'isolation_heartbeat_block', deviceId: device.id, isolationId: id });
});
