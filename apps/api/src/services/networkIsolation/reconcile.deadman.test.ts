import { describe, expect, it } from 'vitest';
import { NETWORK_ISOLATION_DEAD_MAN_MIN_AGENT_VERSION, containmentDesiredBlockSchema, type NetworkIsolationReport } from '@breeze/shared';
import type { DeviceNetworkIsolation } from '../../db/schema';
import { reportEpisodeEvent, storedContainmentHeartbeatBlock } from './reconcile';
import { applyEpisodeEvent } from './stateMachine';
import { toEpisodeSnapshot } from './episodeStore';

// Dead-man opt-in (#10103, plan W4d): the window reaches only an agent that runs it, a dead-man
// release ends the episode unresolved, and the server never re-asserts it.

const deviceId = '22222222-2222-4222-8222-222222222222';
const isolationId = '11111111-1111-4111-8111-111111111111';
const allow = [{ kind: 'host' as const, host: 'control.example.test', proto: 'tcp' as const, ports: [443], scope: 'breeze' as const }];
function row(extra: Partial<DeviceNetworkIsolation> = {}): DeviceNetworkIsolation {
  return {
    id: isolationId, deviceId, orgId: '33333333-3333-4333-8333-333333333333', generation: 2, lastJournalSeq: 4,
    desiredState: 'isolated', state: 'verified', expiresAt: new Date('2027-01-01T00:00:00.000Z'), deadManSeconds: 1800, remoteRelay: false,
    allowSnapshot: allow, allowSnapshotRevision: null, releaseConfirmedAt: null, releaseTokenPublicKey: null, releaseTokenRequired: false,
    releaseKind: null, releasedAt: null, failureCode: null, acknowledgedAt: null, ...extra,
  } as unknown as DeviceNetworkIsolation;
}
const deadManAgent = { networkIsolationVersion: 4, networkIsolationDeadMan: true, agentVersion: NETWORK_ISOLATION_DEAD_MAN_MIN_AGENT_VERSION };

describe('heartbeat block dead-man window (#10103)', () => {
  it('re-sends the episode window to an agent that runs the dead-man', () => {
    const block = storedContainmentHeartbeatBlock(row(), deadManAgent);
    expect(block.networkIsolation).toMatchObject({ desired: 'isolated', deadManSeconds: 1800 });
    expect(containmentDesiredBlockSchema.safeParse(block).success).toBe(true);
  });

  it.each([
    ['no dead-man flag', { networkIsolationVersion: 4, networkIsolationDeadMan: false, agentVersion: NETWORK_ISOLATION_DEAD_MAN_MIN_AGENT_VERSION }],
    ['below the dead-man version gate', { networkIsolationVersion: 4, networkIsolationDeadMan: true, agentVersion: '1.0.0' }],
    ['a v1 agent', { networkIsolationVersion: 1, agentVersion: NETWORK_ISOLATION_DEAD_MAN_MIN_AGENT_VERSION }],
    ['unknown agent', undefined],
  ])('sends 0 to an agent that cannot run it, so it never refuses the block (%s)', (_name, who) => {
    const block = storedContainmentHeartbeatBlock(row(), who);
    expect(block.networkIsolation).toMatchObject({ desired: 'isolated', deadManSeconds: 0 });
    expect(containmentDesiredBlockSchema.safeParse(block).success).toBe(true);
  });

  it('sends 0 on a release tombstone', () => {
    const block = storedContainmentHeartbeatBlock(row({ state: 'release_requested', desiredState: 'released' }), deadManAgent);
    expect(block.networkIsolation).toMatchObject({ desired: 'released', deadManSeconds: 0, allow: [] });
  });
});

describe('a dead-man release on reconnect (#10103)', () => {
  const report = (extra: Partial<NetworkIsolationReport> = {}): NetworkIsolationReport => ({
    isolationId, generation: 2, journalSeq: 9, state: 'self_released', phase: 'released',
    events: [{ seq: 8, at: '2026-12-01T00:00:00.000Z', type: 'releasing', isolationId, generation: 2, detail: 'dead_man' }, { seq: 9, at: '2026-12-01T00:00:01.000Z', type: 'released_dead_man', isolationId, generation: 2 }],
    ...extra,
  } as NetworkIsolationReport);

  it.each([
    ['reported as self_released', report()],
    ['reported as released with a dead_man journal', report({ state: 'released' })],
  ])('ends the episode self_released, unresolved, with nothing re-asserted (%s)', (_name, r) => {
    const at = new Date('2026-12-01T00:05:00.000Z');
    const transition = applyEpisodeEvent(toEpisodeSnapshot(row()), reportEpisodeEvent(row(), r, at));
    expect('next' in transition).toBe(true);
    if (!('next' in transition)) return;
    expect(transition.next).toMatchObject({ state: 'self_released', releaseKind: 'dead_man', desiredState: 'released' });
    expect(transition.next.acknowledgedAt ?? null).toBeNull();
    const after = row({ ...transition.next } as Partial<DeviceNetworkIsolation>);
    // desired:isolated is never sent again for this episode, to any agent.
    expect(storedContainmentHeartbeatBlock(after, deadManAgent)).toEqual({ networkIsolation: null });
  });

  it('ignores a late isolated report after the dead-man release', () => {
    const at = new Date('2026-12-01T00:05:00.000Z');
    const first = applyEpisodeEvent(toEpisodeSnapshot(row()), reportEpisodeEvent(row(), report(), at));
    if (!('next' in first)) throw new Error('no transition');
    const after = row({ ...first.next } as Partial<DeviceNetworkIsolation>);
    const late = applyEpisodeEvent(toEpisodeSnapshot(after), reportEpisodeEvent(after, report({ state: 'verified', phase: 'committed', journalSeq: 3, events: [] }), at));
    expect('next' in late && late.next.state !== 'self_released').toBe(false);
  });
});
