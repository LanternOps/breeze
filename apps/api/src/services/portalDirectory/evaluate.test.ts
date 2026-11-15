import { describe, expect, it } from 'vitest';
import {
  ABSENCE_SPACING_MS,
  evaluateDirectorySnapshot,
  holdReasonFor,
  type DirectoryObservation,
  type EvaluateInput,
  type InScopeIdentity,
} from './evaluate';

const CHAIN = 'entra:t:c:1:o';
const T0 = new Date('2027-02-01T00:00:00Z');
const HOUR = 3600_000;

function ident(over: Partial<InScopeIdentity> = {}): InScopeIdentity {
  return {
    identityId: 'i1', portalUserId: 'u1', provider: 'entra', subject: 's1',
    directoryChain: CHAIN, directorySeenAt: null, directoryAbsentRuns: 0,
    directoryAbsentSince: null, directoryLastRunId: null, directoryRearmSince: null,
    ...over,
  };
}

function run(
  identities: InScopeIdentity[],
  obs: Record<string, DirectoryObservation>,
  over: Partial<EvaluateInput> = {},
) {
  return evaluateDirectorySnapshot({
    runId: 'r2', chainKey: CHAIN, snapshotAt: T0, directoryUserCount: 100,
    previous: { evaluatedCount: null, suspectCount: null },
    identities,
    observe: (s) => obs[s] ?? { present: false },
    ...over,
  });
}

function evaluated(r: ReturnType<typeof run>) {
  if (r.outcome !== 'evaluated') throw new Error('expected evaluated');
  return r;
}

describe('evaluateDirectorySnapshot', () => {
  it('present and enabled: seen set, absence cleared, no action', () => {
    const r = evaluated(run(
      [ident({ directoryAbsentRuns: 1, directoryAbsentSince: new Date(T0.getTime() - HOUR) })],
      { s1: { present: true, state: 'enabled' } },
    ));
    expect(r.actions).toEqual([]);
    expect(r.updates).toHaveLength(1);
    expect(r.updates[0]).toMatchObject({
      identityId: 'i1', directoryChain: CHAIN, directorySeenAt: T0,
      directoryAbsentRuns: 0, directoryAbsentSince: null, directoryLastRunId: 'r2',
    });
  });

  it('present and disabled acts on the first snapshot', () => {
    const r = evaluated(run([ident()], { s1: { present: true, state: 'disabled', reason: 'suspended' } }));
    expect(r.actions).toEqual([{ identityId: 'i1', portalUserId: 'u1', reason: 'suspended' }]);
    expect(r.updates[0]!.directorySeenAt).toEqual(T0);
  });

  it('an unknown present observation resets absence and does not act', () => {
    const r = evaluated(run(
      [ident({ directorySeenAt: T0, directoryAbsentRuns: 1, directoryAbsentSince: T0 })],
      { s1: { present: true, state: 'unknown' } },
    ));
    expect(r.actions).toEqual([]);
    expect(r.updates[0]).toMatchObject({ directoryAbsentRuns: 0, directoryAbsentSince: null });
  });

  it('absence never acts without prior membership in the chain', () => {
    const r = evaluated(run(
      [ident({ directoryAbsentRuns: 5, directoryAbsentSince: new Date(T0.getTime() - 100 * HOUR) })],
      {},
    ));
    expect(r.actions).toEqual([]);
    expect(r.updates[0]).toMatchObject({ directorySeenAt: null, directoryAbsentRuns: 5, directoryLastRunId: 'r2' });
  });

  it('first absence of a seen identity counts and sets absent_since', () => {
    const r = evaluated(run([ident({ directorySeenAt: new Date(T0.getTime() - 48 * HOUR) })], {}));
    expect(r.actions).toEqual([]);
    expect(r.updates[0]).toMatchObject({ directoryAbsentRuns: 1, directoryAbsentSince: T0 });
  });

  it('two absences at least 4 h apart act; two absences 1 h apart do not', () => {
    const seen = new Date(T0.getTime() - 48 * HOUR);
    const apart = evaluated(run(
      [ident({ directorySeenAt: seen, directoryAbsentRuns: 1, directoryAbsentSince: new Date(T0.getTime() - ABSENCE_SPACING_MS) })],
      {},
    ));
    expect(apart.actions).toEqual([{ identityId: 'i1', portalUserId: 'u1', reason: 'absent' }]);
    expect(apart.updates[0]!.directoryAbsentRuns).toBe(2);
    const close = evaluated(run(
      [ident({ directorySeenAt: seen, directoryAbsentRuns: 1, directoryAbsentSince: new Date(T0.getTime() - HOUR) })],
      {},
    ));
    expect(close.actions).toEqual([]);
    expect(close.updates[0]).toMatchObject({ directoryAbsentRuns: 2, directoryAbsentSince: new Date(T0.getTime() - HOUR) });
  });

  it('the same run is never counted twice', () => {
    const r = evaluated(run(
      [ident({ directoryLastRunId: 'r2', directorySeenAt: T0 })],
      { s1: { present: true, state: 'disabled', reason: 'account_disabled' } },
    ));
    expect(r.updates).toEqual([]);
    expect(r.actions).toEqual([]);
    expect(r.reportedOnly).toEqual([]);
  });

  it('a chain change resets seen and absence before applying the observation', () => {
    const old = ident({
      directoryChain: 'entra:t:c:0:o', directorySeenAt: new Date(T0.getTime() - 99 * HOUR),
      directoryAbsentRuns: 3, directoryAbsentSince: new Date(T0.getTime() - 50 * HOUR),
    });
    const r = evaluated(run([old], {}));
    expect(r.actions).toEqual([]);
    expect(r.updates[0]).toMatchObject({
      directoryChain: CHAIN, directorySeenAt: null, directoryAbsentRuns: 0, directoryAbsentSince: null,
    });
    // a null chain behaves the same way
    const r2 = evaluated(run([ident({ directoryChain: null, directorySeenAt: T0, directoryAbsentRuns: 2 })], {}));
    expect(r2.actions).toEqual([]);
    expect(r2.updates[0]).toMatchObject({ directorySeenAt: null, directoryAbsentRuns: 0 });
    // and a present observation then re-establishes membership in the new chain
    const r3 = evaluated(run([old], { s1: { present: true, state: 'enabled' } }));
    expect(r3.updates[0]).toMatchObject({ directorySeenAt: T0, directoryAbsentRuns: 0 });
  });

  it('a chain change keeps rearm_since (an MSP exemption, not an observation)', () => {
    const rearm = new Date(T0.getTime() + HOUR);
    const r = evaluated(run(
      [ident({ directoryChain: 'other', directoryRearmSince: rearm })],
      { s1: { present: true, state: 'disabled', reason: 'account_disabled' } },
    ));
    expect(r.updates[0]!.directoryRearmSince).toEqual(rearm);
    expect(r.actions).toEqual([]);
    expect(r.reportedOnly).toHaveLength(1);
  });

  it('rearm blocks actions until a newer snapshot shows enabled; an older snapshot never re-arms', () => {
    const rearm = new Date(T0.getTime() - HOUR);
    const dis = evaluated(run(
      [ident({ directoryRearmSince: rearm })],
      { s1: { present: true, state: 'disabled', reason: 'account_disabled' } },
    ));
    expect(dis.actions).toEqual([]);
    expect(dis.reportedOnly).toEqual([{ identityId: 'i1', portalUserId: 'u1', reason: 'account_disabled' }]);
    expect(dis.updates[0]!.directoryRearmSince).toEqual(rearm);
    const abs = evaluated(run(
      [ident({ directoryRearmSince: rearm, directorySeenAt: rearm, directoryAbsentRuns: 1, directoryAbsentSince: new Date(T0.getTime() - 9 * HOUR) })],
      {},
    ));
    expect(abs.actions).toEqual([]);
    expect(abs.reportedOnly).toEqual([{ identityId: 'i1', portalUserId: 'u1', reason: 'absent' }]);
    const clear = evaluated(run([ident({ directoryRearmSince: rearm })], { s1: { present: true, state: 'enabled' } }));
    expect(clear.updates[0]!.directoryRearmSince).toBeNull();
    const later = new Date(T0.getTime() + HOUR);
    const older = evaluated(run([ident({ directoryRearmSince: later })], { s1: { present: true, state: 'enabled' } }));
    expect(older.updates[0]!.directoryRearmSince).toEqual(later);
    const equal = evaluated(run([ident({ directoryRearmSince: T0 })], { s1: { present: true, state: 'enabled' } }));
    expect(equal.updates[0]!.directoryRearmSince).toEqual(T0);
    const unk = evaluated(run([ident({ directoryRearmSince: rearm })], { s1: { present: true, state: 'unknown' } }));
    expect(unk.updates[0]!.directoryRearmSince).toEqual(rearm);
  });

  it('suspect shrink changes nothing until a second snapshot agrees', () => {
    const r = run(
      [ident()], { s1: { present: true, state: 'disabled', reason: 'account_disabled' } },
      { directoryUserCount: 70, previous: { evaluatedCount: 100, suspectCount: null } },
    );
    expect(r).toEqual({ outcome: 'suspect_shrink' });
    expect(run([ident()], {}, { directoryUserCount: 80, previous: { evaluatedCount: 100, suspectCount: null } }).outcome).toBe('evaluated');
    expect(run([ident()], {}, { directoryUserCount: 1 }).outcome).toBe('evaluated');
  });

  it('a second snapshot within 5% of the suspect count is evaluated', () => {
    const base = { previous: { evaluatedCount: 100, suspectCount: 70 } };
    expect(run([ident()], {}, { ...base, directoryUserCount: 73 }).outcome).toBe('evaluated');
    expect(run([ident()], {}, { ...base, directoryUserCount: 67 }).outcome).toBe('evaluated');
    expect(run([ident()], {}, { ...base, directoryUserCount: 75 }).outcome).toBe('suspect_shrink');
    expect(run([ident()], {}, { ...base, directoryUserCount: 60 }).outcome).toBe('suspect_shrink');
  });

  it('a zero-count listing is incomplete: it never moves an observation, never shrinks, never confirms', () => {
    // Seen, absent once 9 h ago: one more absent snapshot would plan a disable.
    const seen = ident({
      directorySeenAt: new Date(T0.getTime() - 20 * HOUR),
      directoryAbsentRuns: 1,
      directoryAbsentSince: new Date(T0.getTime() - 9 * HOUR),
    });
    const zero = (previous: EvaluateInput['previous']) => run([seen], {}, { directoryUserCount: 0, previous });
    expect(zero({ evaluatedCount: null, suspectCount: null })).toEqual({ outcome: 'incomplete' });
    // Not a suspect shrink either (that would make it the next run's confirmation baseline) …
    expect(zero({ evaluatedCount: 100, suspectCount: null })).toEqual({ outcome: 'incomplete' });
    // … and an earlier zero suspect count can never confirm a second empty listing.
    expect(zero({ evaluatedCount: 100, suspectCount: 0 })).toEqual({ outcome: 'incomplete' });
    expect(zero({ evaluatedCount: 0, suspectCount: null })).toEqual({ outcome: 'incomplete' });
  });

  it('a snapshot back at normal size after a suspect one is evaluated normally', () => {
    expect(run([ident()], {}, { directoryUserCount: 98, previous: { evaluatedCount: 100, suspectCount: 70 } }).outcome).toBe('evaluated');
  });
});

describe('holdReasonFor', () => {
  const h = (affectedAccounts: number, usableIdentities: number, firstInChain = false, enforce = true) =>
    holdReasonFor({ affectedAccounts, usableIdentities, firstInChain, enforce });

  it('2/2 held, 2/5 not, 3/10 held, 3/40 not, 26/10000 held, first in chain held', () => {
    expect(h(2, 2)).toBe('threshold');
    expect(h(2, 5)).toBeNull();
    expect(h(3, 10)).toBe('threshold');
    expect(h(3, 40)).toBeNull();
    expect(h(26, 10000)).toBe('threshold');
    expect(h(25, 10000)).toBeNull();
    expect(h(1, 100, true)).toBe('first_enforcement');
  });

  it('threshold takes priority over first_enforcement; zero affected is never held', () => {
    expect(h(2, 2, true)).toBe('threshold');
    expect(h(0, 0, true)).toBeNull();
    expect(h(0, 10, false)).toBeNull();
  });

  it('any affected account against zero usable identities is a threshold hold', () => {
    expect(h(1, 0)).toBe('threshold');
    expect(h(1, 0, true)).toBe('threshold');
  });

  it('is never held when not enforcing', () => {
    expect(h(26, 10, true, false)).toBeNull();
  });

  it('boundaries: 3 of 30 is not over 10%, 2 of 4 is held, 1 of 1 is not a threshold hold', () => {
    expect(h(3, 30)).toBeNull();
    expect(h(2, 4)).toBe('threshold');
    expect(h(1, 1)).toBeNull();
  });
});
