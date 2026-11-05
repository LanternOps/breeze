import { inspect } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceNetworkIsolation } from '../../db/schema';
import type { EpisodeTx } from './episodeStore';
import { captureException } from '../sentry';
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
const store = vi.hoisted(() => ({ row: null as DeviceNetworkIsolation | null, writes: [] as Record<string, unknown>[], afterCommit: [] as Array<() => Promise<void>>, published: vi.fn(), resolvePolicy: vi.fn(), casResult: true, auditRefused: vi.fn() }));
vi.mock('../../db', () => ({ withDbTransaction: (fn: () => Promise<unknown>) => fn(), runAfterDbContextCommit: (_label: string, fn: () => Promise<void>) => { store.afterCommit.push(fn); } }));
vi.mock('../featureConfigResolver', () => ({ resolveContainmentPolicy: (...args: unknown[]) => store.resolvePolicy(...args) }));
vi.mock('../executionTargetGating', () => ({ auditRefusedExecutionGroups: (...args: unknown[]) => store.auditRefused(...args) }));
vi.mock('../deviceSiteResolver', () => ({ resolveDeviceSiteId: vi.fn(async () => 'site') }));
vi.mock('../eventBus', () => ({ publishEvent: (...args: unknown[]) => store.published(...args) }));
vi.mock('./episodeStore', async (original) => ({
  ...(await original<typeof import('./episodeStore')>()),
  findHeartbeatEpisode: vi.fn(async () => store.row && !(store.row.desiredState === 'released' && store.row.releaseConfirmedAt) ? store.row : null),
  findUnresolvedEpisode: vi.fn(async () => store.row && !['released','expired','failed','uninstalled'].includes(store.row.state) ? store.row : null),
  findUnconfirmedTombstone: vi.fn(async () => store.row?.desiredState === 'released' && !store.row.releaseConfirmedAt ? store.row : null),
  withEpisodeLock: vi.fn(async (_tx, id, fn) => store.row?.id === id ? { found: true, value: await fn(store.row) } : { found: false }),
  writeEpisodeSnapshot: vi.fn(async (_tx, _id, _prev, next, _at, also) => { Object.assign(store.row!, next, also); return store.casResult; }),
}));
vi.mock('../secretCrypto', () => ({ decryptSecret: vi.fn(() => Buffer.alloc(32, 7).toString('base64')) }));
import { buildContainmentHeartbeatBlock, reconcileContainmentReport, storedContainmentHeartbeatBlock, __resetIsolationLogThrottleForTests } from './reconcile';
import { isolationPolicyPending } from './policy';
const id = '11111111-1111-4111-8111-111111111111';
const device = { id: '22222222-2222-4222-8222-222222222222', orgId: '33333333-3333-4333-8333-333333333333', agentServerUrl: 'https://control.example.test' };
const now = new Date('2026-10-31T12:00:00Z');
const allow = [{ kind: 'host', host: 'control.example.test', ports: [443], proto: 'tcp', scope: 'breeze' }];
const tx = {
  update: vi.fn(() => ({ set: vi.fn((v) => { store.writes.push(v); if ('lastAgentReport' in v || 'policyEventSeq' in v) Object.assign(store.row!, v); return { where: vi.fn(async () => undefined) }; }) })),
  insert: vi.fn(() => ({ values: vi.fn((v) => { store.writes.push(v); return { returning: async () => [{ id: 'alert-id' }] }; }) })),
} as unknown as EpisodeTx;
function row(desired = 'isolated'): DeviceNetworkIsolation {
  return { id, deviceId: device.id, orgId: device.orgId, generation: 2, lastJournalSeq: 5,
    state: desired === 'isolated' ? 'applied' : 'release_requested', desiredState: desired,
    expiresAt: new Date('2026-11-03T12:00:00Z'), deadManSeconds: 0, remoteRelay: false,
    incidentId: '44444444-4444-4444-8444-444444444444', breakGlassSecretEnc: 'ciphertext', breakGlassAckSeq: null, allowSnapshot: allow, allowSnapshotRevision: null, appliedPolicyRevision: null, policyEventSeq: 0,
    releaseConfirmedAt: null, failureCode: null, releaseKind: null, lastAgentReport: null,
  } as unknown as DeviceNetworkIsolation;
}
const EDR_ENTRY = { kind: 'host', host: 'edr.example.test', proto: 'tcp', ports: [443], scope: 'any' };
const WITH_EXTRAS = { extraAllow: [{ host: 'edr.example.test', proto: 'tcp', ports: [443], label: 'EDR cloud' }], revision: 'c1:policy', refusedGroups: [] };
beforeEach(() => { __resetIsolationLogThrottleForTests?.(); store.row = row(); store.writes = []; store.afterCommit = []; vi.clearAllMocks(); store.resolvePolicy.mockReset(); store.resolvePolicy.mockResolvedValue(WITH_EXTRAS); store.casResult = true; });
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
    failed: { state: 'failed', confirmed: true, seq: 6, alerts: 1, journals: 0 },
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
        expect(store.published).not.toHaveBeenCalled();
        for (const callback of store.afterCommit) await callback();
        const transitioned = expected.state !== (desired === 'isolated' ? 'applied' : 'release_requested');
        const events: Record<string, string> = {
          verified: 'device.isolated', failed: 'device.isolation_failed', self_released: 'device.isolation_self_released',
          released_locally: 'device.isolation_released', released: 'device.isolation_released', expired: 'device.isolation_released',
        };
        const event = events[expected.state];
        expect(store.published.mock.calls.filter(([type]) => type !== 'alert.triggered')).toHaveLength(transitioned && event ? 1 : 0);
        expect(store.published.mock.calls.filter(([type]) => type === 'alert.triggered')).toHaveLength(expected.alerts);
        if (transitioned && event) expect(store.published).toHaveBeenCalledWith(event, device.orgId,
          expect.objectContaining({ isolationId: id, deviceId: device.id, generation: 2, state: expected.state }), 'network-isolation-result');
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

describe('containment policy permits on the heartbeat (#10100)', () => {
  const scopes = (block: Awaited<ReturnType<typeof buildContainmentHeartbeatBlock>>) => block.networkIsolation!.allow.map(entry => entry.scope);
  it.each([undefined, null, 0, 1, 2])('level %s: sends no extras and never reads the policy', async (level) => {
    const block = await buildContainmentHeartbeatBlock(tx, { ...device, networkIsolationVersion: level as number | null | undefined });
    expect(scopes(block)).not.toContain('any');
    expect(store.resolvePolicy).not.toHaveBeenCalled();
    expect(block.networkIsolation).not.toHaveProperty('policyRevision');
  });
  it('level 3: appends the policy permits as scope any', async () => {
    const block = await buildContainmentHeartbeatBlock(tx, { ...device, networkIsolationVersion: 3 });
    expect(store.resolvePolicy).toHaveBeenCalledWith(device.id);
    expect(block.networkIsolation!.allow).toContainEqual(EDR_ENTRY);
    expect(block.networkIsolation).toHaveProperty('policyRevision', 'c1:policy');
  });
  it('level 3 with an empty policy: sends no revision although the resolver has one', async () => {
    store.resolvePolicy.mockResolvedValue({ extraAllow: [], revision: 'c1:defaults', refusedGroups: [] });
    const block = await buildContainmentHeartbeatBlock(tx, { ...device, networkIsolationVersion: 3 });
    expect(scopes(block)).not.toContain('any');
    expect(block.networkIsolation).not.toHaveProperty('policyRevision');
  });
  it('a tombstone never reads the policy or carries a permit', async () => {
    store.row = row('released');
    const block = await buildContainmentHeartbeatBlock(tx, { ...device, networkIsolationVersion: 3 });
    expect(block.networkIsolation).toMatchObject({ desired: 'released', allow: [] });
    expect(block.networkIsolation).not.toHaveProperty('policyRevision');
    expect(store.resolvePolicy).not.toHaveBeenCalled();
  });
});

describe('stored fallback carries the snapshot revision (#10100)', () => {
  const held = () => ({ ...row(), allowSnapshot: [...allow, EDR_ENTRY], allowSnapshotRevision: 'c1:held' }) as unknown as DeviceNetworkIsolation;
  const level3 = { ...device, networkIsolationVersion: 3 };

  it('sends the stored permits under the stored revision at level 3', () => {
    expect(storedContainmentHeartbeatBlock(held(), level3).networkIsolation).toMatchObject({ allow: [...allow, EDR_ENTRY], policyRevision: 'c1:held' });
  });
  it.each([undefined, { ...device, networkIsolationVersion: 2 }, { ...device, networkIsolationVersion: null }])('strips policy permits and the revision for an agent that cannot take them (%j)', (who) => {
    const block = storedContainmentHeartbeatBlock(held(), who).networkIsolation!;
    expect(block.allow).toEqual(allow);
    expect(block).not.toHaveProperty('policyRevision');
  });
  it('never sends a scope any entry without a revision', () => {
    const block = storedContainmentHeartbeatBlock({ ...held(), allowSnapshotRevision: null }, level3).networkIsolation!;
    expect(block.allow).toEqual(allow);
    expect(block).not.toHaveProperty('policyRevision');
  });
  it('never sends a revision without a scope any entry', () => {
    const block = storedContainmentHeartbeatBlock({ ...held(), allowSnapshot: allow as never }, level3).networkIsolation!;
    expect(block).not.toHaveProperty('policyRevision');
  });
  it('a tombstone carries no revision', () => {
    const block = storedContainmentHeartbeatBlock({ ...held(), state: 'release_requested', desiredState: 'released' }, level3).networkIsolation!;
    expect(block).toMatchObject({ desired: 'released', allow: [] });
    expect(block).not.toHaveProperty('policyRevision');
  });
  it('keeps the held permits and revision when the allowlist cannot be built', async () => {
    store.row = held();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const block = await buildContainmentHeartbeatBlock(tx, { ...level3, agentServerUrl: 'invalid-url' });
      expect(block.networkIsolation).toMatchObject({ allow: [...allow, EDR_ENTRY], policyRevision: 'c1:held' });
    } finally { error.mockRestore(); }
  });
  it('keeps the held policy, with fresh control-plane permits, when the policy cannot be read', async () => {
    store.row = held();
    store.resolvePolicy.mockRejectedValue(new Error('read failed'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (let beat = 0; beat < 3; beat++) {
        const block = await buildContainmentHeartbeatBlock(tx, { ...level3, agentServerUrl: 'https://moved.example.test' });
        expect(block.networkIsolation!.allow).toContainEqual(EDR_ENTRY);
        expect(block.networkIsolation!.allow).toContainEqual({ kind: 'host', host: 'moved.example.test', proto: 'tcp', ports: [443], scope: 'breeze' });
        expect(block.networkIsolation).toHaveProperty('policyRevision', 'c1:held');
      }
      expect(error).toHaveBeenCalledTimes(1);
      expect(captureException).toHaveBeenCalledTimes(1);
      expect(captureException).toHaveBeenCalledWith(expect.any(Error), undefined, { phase: 'isolation_policy_unavailable', deviceId: device.id, isolationId: id });
    } finally { error.mockRestore(); }
  });
});

describe('a revision change takes a new generation (#10100)', () => {
  const level3 = { ...device, networkIsolationVersion: 3 };
  const NO_EXTRAS = { extraAllow: [], revision: 'c1:defaults', refusedGroups: [] };
  const holding = (extra: Record<string, unknown> = {}) => { store.row = { ...row(), allowSnapshot: [...allow, EDR_ENTRY], allowSnapshotRevision: 'c1:held', ...extra } as unknown as DeviceNetworkIsolation; };
  const timelineTypes = () => store.writes.filter(v => 'timeline' in v).map(v => inspect(v, { depth: 8 }));

  it('a first policy on a running episode: generation, snapshot and revision move together', async () => {
    const context: { row?: DeviceNetworkIsolation | null } = { row: { ...store.row! } };
    const block = await buildContainmentHeartbeatBlock(tx, level3, context);
    expect(store.row).toMatchObject({ generation: 3, allowSnapshotRevision: 'c1:policy' });
    expect(store.row!.allowSnapshot).toContainEqual(EDR_ENTRY);
    expect(block.networkIsolation).toMatchObject({ generation: 3, policyRevision: 'c1:policy' });
    // Not committed until the savepoint releases; the route's fallback must not send it if that fails.
    expect(context.row).toMatchObject({ generation: 2, allowSnapshotRevision: null });
    const { writeEpisodeSnapshot } = await import('./episodeStore');
    const call = vi.mocked(writeEpisodeSnapshot).mock.calls.at(-1)!;
    expect(call[5]).toMatchObject({ allowSnapshotRevision: 'c1:policy' });
    expect(timelineTypes().join()).toContain('isolation_policy_changed');
  });
  it('a changed revision takes a new generation', async () => {
    holding();
    const block = await buildContainmentHeartbeatBlock(tx, level3);
    expect(block.networkIsolation).toMatchObject({ generation: 3, policyRevision: 'c1:policy' });
  });
  it('an unchanged revision keeps the generation, beat after beat', async () => {
    holding({ allowSnapshotRevision: 'c1:policy' });
    for (let beat = 0; beat < 3; beat++) {
      expect((await buildContainmentHeartbeatBlock(tx, level3)).networkIsolation).toMatchObject({ generation: 2, policyRevision: 'c1:policy' });
    }
    expect(store.writes.filter(v => 'timeline' in v)).toHaveLength(0);
  });
  it('removing the policy takes a new generation and drops the revision', async () => {
    holding();
    store.resolvePolicy.mockResolvedValue(NO_EXTRAS);
    const block = await buildContainmentHeartbeatBlock(tx, level3);
    expect(block.networkIsolation).toMatchObject({ generation: 3 });
    expect(block.networkIsolation).not.toHaveProperty('policyRevision');
    expect(store.row).toMatchObject({ generation: 3, allowSnapshotRevision: null });
    expect(store.row!.allowSnapshot.some(entry => entry.scope === 'any')).toBe(false);
  });
  it('an agent that drops below level 3 is narrowed under a new generation', async () => {
    holding();
    const block = await buildContainmentHeartbeatBlock(tx, { ...device, networkIsolationVersion: 1 });
    expect(block.networkIsolation).toMatchObject({ generation: 3 });
    expect(block.networkIsolation).not.toHaveProperty('policyRevision');
    expect(store.resolvePolicy).not.toHaveBeenCalled();
  });
  it('an episode with no policy keeps its generation at every level', async () => {
    store.resolvePolicy.mockResolvedValue(NO_EXTRAS);
    for (const networkIsolationVersion of [1, 2, 3]) {
      expect((await buildContainmentHeartbeatBlock(tx, { ...device, networkIsolationVersion })).networkIsolation).toMatchObject({ generation: 2 });
    }
    expect(store.row!.generation).toBe(2);
  });
  it('a policy read fault does not bump', async () => {
    holding();
    store.resolvePolicy.mockRejectedValue(new Error('read failed'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await buildContainmentHeartbeatBlock(tx, level3)).networkIsolation).toMatchObject({ generation: 2, policyRevision: 'c1:held' });
      expect(store.row!.generation).toBe(2);
    } finally { error.mockRestore(); }
  });
  it('an allowlist fault does not bump: the snapshot and the generation must stay a pair', async () => {
    holding();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await buildContainmentHeartbeatBlock(tx, { ...level3, agentServerUrl: 'invalid-url' })).networkIsolation).toMatchObject({ generation: 2, policyRevision: 'c1:held' });
      expect(store.row).toMatchObject({ generation: 2, allowSnapshotRevision: 'c1:held' });
    } finally { error.mockRestore(); }
  });
  it('a lost compare-and-swap fails the block and journals nothing, so the savepoint rolls back whole', async () => {
    store.casResult = false;
    await expect(buildContainmentHeartbeatBlock(tx, level3)).rejects.toThrow('isolation_snapshot_conflict');
    expect(store.writes.filter(v => 'timeline' in v)).toHaveLength(0);
  });
  it('a release that won the lock sends the tombstone, not a new generation', async () => {
    const { withEpisodeLock } = await import('./episodeStore');
    vi.mocked(withEpisodeLock).mockImplementationOnce(async (_tx, _id, fn) => {
      store.row = { ...store.row!, state: 'release_requested', desiredState: 'released', generation: 3 };
      return { found: true, value: await fn(store.row) };
    });
    const block = await buildContainmentHeartbeatBlock(tx, level3);
    expect(block.networkIsolation).toMatchObject({ desired: 'released', allow: [], generation: 3 });
    expect(store.row!.generation).toBe(3);
  });
  it('a policy going malformed narrows to the fixed permits under a new generation', async () => {
    holding();
    store.resolvePolicy.mockResolvedValue({ extraAllow: [], revision: 'c1i:malformed', invalidStoredSettings: true, refusedGroups: [] });
    const block = await buildContainmentHeartbeatBlock(tx, level3);
    expect(block.networkIsolation).toMatchObject({ generation: 3 });
    expect(block.networkIsolation).not.toHaveProperty('policyRevision');
    expect(block.networkIsolation!.allow.some(entry => entry.scope === 'any')).toBe(false);
  });
  it('audits refused groups once, not on every beat, when they take a policy away', async () => {
    holding();
    const refusedGroups = [{ id: 'group-1', refusedFields: ['os_version'] }];
    store.resolvePolicy.mockResolvedValue({ ...NO_EXTRAS, refusedGroups });
    for (let beat = 0; beat < 3; beat++) await buildContainmentHeartbeatBlock(tx, level3);
    expect(store.auditRefused).toHaveBeenCalledTimes(1);
    expect(store.auditRefused).toHaveBeenCalledWith(device.orgId, 'device.isolation.policy_group_refused', refusedGroups);
  });
  it('a concurrent beat that already recorded this revision is not bumped twice', async () => {
    const { withEpisodeLock } = await import('./episodeStore');
    vi.mocked(withEpisodeLock).mockImplementationOnce(async (_tx, _id, fn) => {
      store.row = { ...store.row!, generation: 3, allowSnapshot: [...allow, EDR_ENTRY], allowSnapshotRevision: 'c1:policy' } as never;
      return { found: true, value: await fn(store.row!) };
    });
    const block = await buildContainmentHeartbeatBlock(tx, level3);
    expect(block.networkIsolation).toMatchObject({ generation: 3, policyRevision: 'c1:policy' });
    expect(store.row!.generation).toBe(3);
  });
  it('an extend that won the lock is not undone: the block carries its expiry with its generation', async () => {
    const extended = new Date('2026-11-09T12:00:00Z');
    const { withEpisodeLock } = await import('./episodeStore');
    vi.mocked(withEpisodeLock).mockImplementationOnce(async (_tx, _id, fn) => {
      store.row = { ...store.row!, generation: 3, expiresAt: extended };
      return { found: true, value: await fn(store.row) };
    });
    const block = await buildContainmentHeartbeatBlock(tx, level3);
    expect(block.networkIsolation).toMatchObject({ generation: 4, expiresAt: extended.toISOString(), policyRevision: 'c1:policy' });
  });
  it('the block after a bump still delivers an unacknowledged secret', async () => {
    expect((await buildContainmentHeartbeatBlock(tx, level3)).networkIsolation).toHaveProperty('breakGlassSecret');
  });
  it('says when a malformed policy, not an operator, took the permits away', async () => {
    holding();
    store.resolvePolicy.mockResolvedValue({ extraAllow: [], revision: 'c1i:malformed', invalidStoredSettings: true, refusedGroups: [] });
    await buildContainmentHeartbeatBlock(tx, level3);
    expect(timelineTypes().join()).toContain('invalidStoredSettings');
  });
  it('a deliberate removal does not claim the policy was malformed', async () => {
    holding();
    store.resolvePolicy.mockResolvedValue({ ...NO_EXTRAS, invalidStoredSettings: false });
    await buildContainmentHeartbeatBlock(tx, level3);
    expect(timelineTypes().join()).not.toContain('invalidStoredSettings');
  });
  it('audits a refused group even when the revision never changes, once', async () => {
    const refusedGroups = [{ id: 'group-1', refusedFields: ['os_version'] }];
    store.resolvePolicy.mockResolvedValue({ ...NO_EXTRAS, refusedGroups });
    for (let beat = 0; beat < 3; beat++) await buildContainmentHeartbeatBlock(tx, level3);
    expect(store.row!.generation).toBe(2);
    expect(store.auditRefused).toHaveBeenCalledTimes(1);
  });
});

describe('policy journal events reach the episode timeline (#10100)', () => {
  const level3 = { ...device, networkIsolationVersion: 3 };
  const ev = (seq: number, type: string, detail?: string, generation: number | undefined = 2, isolationId: string | undefined = id) => ({ seq, at: now.toISOString(), type, detail, generation, isolationId });
  const report = (journalSeq: number, events: unknown[], extra: Record<string, unknown> = {}) => ({ isolationId: id, generation: 2, journalSeq, state: 'applied', phase: 'committed', events, ...extra });
  const timeline = () => store.writes.filter(v => 'timeline' in v).map(v => inspect(v, { depth: 8 }));
  const withType = (type: string) => timeline().filter(entry => entry.includes(`'${type}'`) || entry.includes(`\\"${type}\\"`) || entry.includes(`"type":"${type}"`));

  it('surfaces applied, removed and rejected once each, though the agent resends its journal', async () => {
    const events = [ev(6, 'policy_applied', 'c1:new'), ev(7, 'policy_removed', 'c1:new'), ev(8, 'policy_rejected', 'revision_missing')];
    for (const seq of [8, 8, 8]) await reconcileContainmentReport(tx, device, report(seq, events), now);
    expect(withType('policy_applied')).toHaveLength(1);
    expect(withType('policy_removed')).toHaveLength(1);
    expect(withType('policy_rejected')).toHaveLength(1);
    expect(timeline().join()).toContain('revision_missing');
    expect(store.row).toMatchObject({ policyEventSeq: 8, appliedPolicyRevision: null });
  });
  it('tracks the revision the agent last committed', async () => {
    await reconcileContainmentReport(tx, device, report(6, [ev(6, 'policy_applied', 'c1:new')]), now);
    expect(store.row).toMatchObject({ appliedPolicyRevision: 'c1:new', policyEventSeq: 6 });
    await reconcileContainmentReport(tx, device, report(7, [ev(6, 'policy_applied', 'c1:new'), ev(7, 'policy_removed', 'c1:new')]), now);
    expect(store.row).toMatchObject({ appliedPolicyRevision: null, policyEventSeq: 7 });
  });
  it('reads events a command result already advanced the sequence past', async () => {
    Object.assign(store.row!, { lastJournalSeq: 6, lastAgentReport: { isolationId: id, generation: 2, journalSeq: 6, state: 'applied', phase: 'committed', mechanism: null, ruleDigest: null } });
    await reconcileContainmentReport(tx, device, report(6, [ev(6, 'policy_applied', 'c1:new')]), now);
    expect(withType('policy_applied')).toHaveLength(1);
    expect(store.row).toMatchObject({ appliedPolicyRevision: 'c1:new' });
  });
  it('surfaces a rejection from an agent still holding an older generation', async () => {
    Object.assign(store.row!, { generation: 3 });
    const rejected = report(6, [ev(6, 'policy_rejected', 'generation_not_advanced', 3)]);
    for (let beat = 0; beat < 3; beat++) await reconcileContainmentReport(tx, device, rejected, now);
    expect(withType('policy_rejected')).toHaveLength(1);
    expect(store.row).toMatchObject({ policyEventSeq: 6, lastJournalSeq: 5 });
  });
  it('accepts a rejection journalled without an identity, and ignores another episode', async () => {
    await reconcileContainmentReport(tx, device, report(7, [
      { seq: 6, at: now.toISOString(), type: 'policy_rejected', detail: 'spec_invalid' },
      ev(7, 'policy_applied', 'c1:foreign', 2, '99999999-9999-4999-8999-999999999999'),
    ]), now);
    expect(withType('policy_rejected')).toHaveLength(1);
    expect(withType('policy_applied')).toHaveLength(0);
    expect(store.row!.appliedPolicyRevision ?? null).toBeNull();
  });
  it('only a rejection may lack an identity: a commit must name this episode', async () => {
    const anonymous = (seq: number, type: string, detail: string) => ({ seq, at: now.toISOString(), type, detail, generation: 2 });
    await reconcileContainmentReport(tx, device, report(7, [anonymous(6, 'policy_applied', 'c1:leftover'), anonymous(7, 'policy_removed', 'c1:leftover')]), now);
    expect(withType('policy_applied')).toHaveLength(0);
    expect(withType('policy_removed')).toHaveLength(0);
    expect(store.row!.appliedPolicyRevision).toBeNull();
  });
  it('bounds the timeline entries one report can add, keeping the newest', async () => {
    const flood = Array.from({ length: 200 }, (_, i) => ev(6 + i, 'policy_rejected', 'spec_invalid'));
    await reconcileContainmentReport(tx, device, report(205, flood), now);
    expect(withType('policy_rejected')).toHaveLength(8);
    expect(timeline().join()).toContain('"journalSeq":205');
    expect(timeline().join()).not.toContain('"journalSeq":6,');
    expect(store.row).toMatchObject({ policyEventSeq: 205 });
  });
  it('reads events on an absence report too', async () => {
    await reconcileContainmentReport(tx, device, { isolationId: null, phase: 'none', journalSeq: 6, events: [ev(6, 'policy_rejected', 'revision_invalid')] }, now);
    expect(withType('policy_rejected')).toHaveLength(1);
  });
  it('never copies agent prose: an unknown reason and a malformed revision do not pass through', async () => {
    await reconcileContainmentReport(tx, device, report(7, [ev(6, 'policy_rejected', 'AGENT-PROSE drop table'), ev(7, 'policy_applied', 'has space AGENT-PROSE')]), now);
    expect(inspect(store.writes, { depth: 8 })).not.toContain('AGENT-PROSE');
    expect(timeline().join()).toContain('unknown');
    expect(withType('policy_applied')).toHaveLength(0);
    expect(store.row!.appliedPolicyRevision ?? null).toBeNull();
    expect(store.row).toMatchObject({ policyEventSeq: 7 });
  });
  it('ignores an event past the reported journal sequence', async () => {
    await reconcileContainmentReport(tx, device, report(6, [ev(7, 'policy_applied', 'c1:ahead')]), now);
    expect(withType('policy_applied')).toHaveLength(0);
    expect(store.row!.appliedPolicyRevision ?? null).toBeNull();
  });
  it('records progress even without an incident to journal on', async () => {
    Object.assign(store.row!, { incidentId: null });
    await reconcileContainmentReport(tx, device, report(6, [ev(6, 'policy_applied', 'c1:new')]), now);
    expect(timeline()).toHaveLength(0);
    expect(store.row).toMatchObject({ appliedPolicyRevision: 'c1:new', policyEventSeq: 6 });
  });
  it('writes nothing for a report with no policy events', async () => {
    await reconcileContainmentReport(tx, device, report(6, [ev(6, 'refreshed')]), now);
    expect(store.writes.filter(v => 'policyEventSeq' in v)).toHaveLength(0);
  });

  describe('a narrowing is done when the agent committed it, not when it says verified', () => {
    const pendingNarrowing = () => { store.row = { ...row(), state: 'verified', generation: 3, allowSnapshot: allow, allowSnapshotRevision: null, appliedPolicyRevision: 'c1:held', policyEventSeq: 5, lastAgentReport: { isolationId: id, generation: 2, journalSeq: 5, state: 'verified', phase: 'committed', mechanism: null, ruleDigest: 'with-permit' } } as unknown as DeviceNetworkIsolation; };
    const beat = (journalSeq: number, events: unknown[], ruleDigest: string) => report(journalSeq, events, { generation: 3, state: 'verified', ruleDigest });

    it('a failed refresh leaves it pending, whatever the state says, and records the revert once per generation', async () => {
      pendingNarrowing();
      const reverted = [ev(6, 'refresh_reverted', 'apply_error', 3), ev(7, 'refresh_reverted', 'apply_error', 3)];
      await reconcileContainmentReport(tx, device, beat(6, reverted.slice(0, 1), 'with-permit'), now);
      await reconcileContainmentReport(tx, device, beat(7, reverted, 'with-permit'), now);
      expect(store.row).toMatchObject({ state: 'verified', appliedPolicyRevision: 'c1:held' });
      expect(isolationPolicyPending(store.row!)).toBe(true);
      expect(withType('policy_refresh_reverted')).toHaveLength(1);
      expect(withType('policy_removed')).toHaveLength(0);
    });
    it('the commit that finally lands completes it, and is not mislabelled as drift', async () => {
      pendingNarrowing();
      await reconcileContainmentReport(tx, device, beat(6, [ev(6, 'refresh_reverted', 'apply_error', 3)], 'with-permit'), now);
      await reconcileContainmentReport(tx, device, beat(8, [ev(6, 'refresh_reverted', 'apply_error', 3), ev(7, 'refreshed', undefined, 3), ev(8, 'policy_removed', 'c1:held', 3)], 'narrowed'), now);
      expect(store.row!.appliedPolicyRevision).toBeNull();
      expect(isolationPolicyPending(store.row!)).toBe(false);
      expect(withType('policy_removed')).toHaveLength(1);
      expect(timeline().join()).not.toContain('drift_reapplied');
    });
    it('a revert with no policy change outstanding is not a policy event', async () => {
      await reconcileContainmentReport(tx, device, report(6, [ev(6, 'refresh_reverted', 'apply_error')]), now);
      expect(withType('policy_refresh_reverted')).toHaveLength(0);
    });
    it('a revert from an older generation does not speak for this change', async () => {
      pendingNarrowing();
      await reconcileContainmentReport(tx, device, beat(6, [ev(6, 'refresh_reverted', 'apply_error', 2)], 'with-permit'), now);
      expect(withType('policy_refresh_reverted')).toHaveLength(0);
    });
    it('a revert reason outside the wire shape stays out of the timeline', async () => {
      pendingNarrowing();
      await reconcileContainmentReport(tx, device, beat(6, [ev(6, 'refresh_reverted', 'AGENT PROSE', 3)], 'with-permit'), now);
      expect(withType('policy_refresh_reverted')).toHaveLength(1);
      expect(inspect(store.writes, { depth: 8 })).not.toContain('AGENT PROSE');
    });
    it('a tombstone has nothing pending', () => {
      expect(isolationPolicyPending({ ...row('released'), allowSnapshotRevision: 'c1:a', appliedPolicyRevision: null } as unknown as DeviceNetworkIsolation)).toBe(false);
    });
    it('a new policy is pending from the bump until the agent commits it', async () => {
      await buildContainmentHeartbeatBlock(tx, level3);
      expect(isolationPolicyPending(store.row!)).toBe(true);
      await reconcileContainmentReport(tx, device, report(6, [ev(6, 'policy_applied', 'c1:policy', 3)], { generation: 3 }), now);
      expect(isolationPolicyPending(store.row!)).toBe(false);
    });
  });
});

