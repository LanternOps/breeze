import { describe, expect, it } from 'vitest';
import type { CohortCandidate } from './sweepActCohort';
import { orderCohortCandidates, selectCohort } from './sweepActCohort';

const c = (over: Partial<CohortCandidate> & { findingIndex: number }): CohortCandidate => ({
  deviceId: 'd1',
  severity: 'medium',
  kind: 'service_down',
  subjectKey: 'k',
  ...over,
});

describe('orderCohortCandidates', () => {
  it('orders by severity desc, then kind asc, then deviceId asc, then subjectKey asc — and is stable across shuffles', () => {
    const items: CohortCandidate[] = [
      c({ findingIndex: 0, severity: 'low', kind: 'service_down', deviceId: 'd1', subjectKey: 'a' }),
      c({ findingIndex: 1, severity: 'critical', kind: 'service_down', deviceId: 'd2', subjectKey: 'b' }),
      c({ findingIndex: 2, severity: 'critical', kind: 'expiring_certs', deviceId: 'd9', subjectKey: 'z' }),
      c({ findingIndex: 3, severity: 'critical', kind: 'service_down', deviceId: 'd2', subjectKey: 'a' }),
      c({ findingIndex: 4, severity: 'critical', kind: 'service_down', deviceId: 'd1', subjectKey: 'q' }),
    ];
    const expected = [2, 4, 3, 1, 0];
    expect(orderCohortCandidates(items).map((x) => x.findingIndex)).toEqual(expected);
    // Reverse the input: the output must be identical (a total order, never
    // iteration order).
    expect(orderCohortCandidates([...items].reverse()).map((x) => x.findingIndex)).toEqual(expected);
  });

  it('does not mutate its input', () => {
    const items = [c({ findingIndex: 0, severity: 'low' }), c({ findingIndex: 1, severity: 'critical' })];
    const before = items.map((x) => x.findingIndex);
    orderCohortCandidates(items);
    expect(items.map((x) => x.findingIndex)).toEqual(before);
  });
});

describe('selectCohort', () => {
  const base = {
    existingExposedDevices: new Set<string>(),
    allowance: 10,
    policyDecisionsToday: 0,
    maxPolicyDecisionsPerDay: 10,
    maxUnattendedDevicesPerSweep: 3,
  };

  it('two candidates on the SAME device consume one device slot but two day slots', () => {
    const ordered = orderCohortCandidates([
      c({ findingIndex: 0, deviceId: 'd1', subjectKey: 'a' }),
      c({ findingIndex: 1, deviceId: 'd1', subjectKey: 'b' }),
    ]);
    const res = selectCohort({ ...base, ordered, allowance: 1, maxPolicyDecisionsPerDay: 1 });
    expect(res.admitted.map((x) => x.findingIndex)).toEqual([0]);
    expect(res.stoppedBy).toBe('day_cap');
  });

  it('the fleet cap is a SET UNION with the existing window, not existingCount + N', () => {
    const ordered = orderCohortCandidates([
      c({ findingIndex: 0, deviceId: 'd1', subjectKey: 'a' }),
      c({ findingIndex: 1, deviceId: 'd3', subjectKey: 'a' }),
    ]);
    const res = selectCohort({
      ...base,
      ordered,
      existingExposedDevices: new Set(['d1', 'd2']),
      allowance: 2,
    });
    expect(res.admitted.map((x) => x.findingIndex)).toEqual([0]);
    expect(res.stoppedBy).toBe('fleet_cap');
  });

  it('allowance 0 (a fleet too small for one whole device) admits NOTHING — no max(1, .)', () => {
    const ordered = orderCohortCandidates([c({ findingIndex: 0, deviceId: 'd1' })]);
    const res = selectCohort({ ...base, ordered, allowance: 0 });
    expect(res.admitted).toEqual([]);
    expect(res.stoppedBy).toBe('fleet_cap');
  });

  it('the per-occurrence cap stops the walk even when both ledger caps have room', () => {
    const ordered = orderCohortCandidates([
      c({ findingIndex: 0, deviceId: 'd1' }),
      c({ findingIndex: 1, deviceId: 'd2' }),
      c({ findingIndex: 2, deviceId: 'd3' }),
    ]);
    const res = selectCohort({ ...base, ordered, maxUnattendedDevicesPerSweep: 2 });
    expect(res.admitted.map((x) => x.findingIndex)).toEqual([0, 1]);
    expect(res.stoppedBy).toBe('occurrence_cap');
  });

  it('a second candidate on an ALREADY-admitted device does not consume a second occurrence slot', () => {
    const ordered = orderCohortCandidates([
      c({ findingIndex: 0, deviceId: 'd1', subjectKey: 'a' }),
      c({ findingIndex: 1, deviceId: 'd1', subjectKey: 'b' }),
    ]);
    const res = selectCohort({ ...base, ordered, maxUnattendedDevicesPerSweep: 1 });
    expect(res.admitted.map((x) => x.findingIndex)).toEqual([0, 1]);
    expect(res.stoppedBy).toBe(null);
  });

  it('reports which cap stopped it, so the run detail can say why', () => {
    const ordered = orderCohortCandidates([c({ findingIndex: 0 }), c({ findingIndex: 1, deviceId: 'd2' })]);
    expect(selectCohort({ ...base, ordered, policyDecisionsToday: 1, maxPolicyDecisionsPerDay: 1 }).stoppedBy)
      .toBe('day_cap');
  });

  it('admits everything and reports stoppedBy null when no cap binds', () => {
    const ordered = orderCohortCandidates([c({ findingIndex: 0 }), c({ findingIndex: 1, deviceId: 'd2' })]);
    const res = selectCohort({ ...base, ordered });
    expect(res.admitted.map((x) => x.findingIndex)).toEqual([0, 1]);
    expect(res.stoppedBy).toBe(null);
  });

  it('an empty candidate list returns an empty cohort and stoppedBy null', () => {
    expect(selectCohort({ ...base, ordered: [] })).toEqual({ admitted: [], stoppedBy: null });
  });
});

// #4442 W05 review fix — every cap check is an `x > cap` comparison, and in
// JS any comparison against NaN is false. An unguarded non-finite cap would
// therefore never fire and admit the WHOLE candidate list unattended, with no
// error anywhere. These pin the fail-closed guard.
describe('selectCohort — non-finite caps fail CLOSED', () => {
  const ordered = orderCohortCandidates([
    c({ findingIndex: 0, deviceId: 'd1' }),
    c({ findingIndex: 1, deviceId: 'd2' }),
  ]);
  const base = {
    ordered,
    existingExposedDevices: new Set<string>(),
    allowance: 10,
    policyDecisionsToday: 0,
    maxPolicyDecisionsPerDay: 10,
    maxUnattendedDevicesPerSweep: 3,
  };

  it('a NaN fleet allowance admits nothing', () => {
    const res = selectCohort({ ...base, allowance: Number.NaN });
    expect(res.admitted).toEqual([]);
    expect(res.stoppedBy).toBe('fleet_cap');
  });

  it('a NaN per-occurrence cap admits nothing', () => {
    const res = selectCohort({ ...base, maxUnattendedDevicesPerSweep: Number.NaN });
    expect(res.admitted).toEqual([]);
    expect(res.stoppedBy).toBe('occurrence_cap');
  });

  it('a NaN day cap admits nothing', () => {
    const res = selectCohort({ ...base, maxPolicyDecisionsPerDay: Number.NaN });
    expect(res.admitted).toEqual([]);
    expect(res.stoppedBy).toBe('day_cap');
  });

  it('a NaN "already spent today" count is treated as FULLY spent, not as zero', () => {
    const res = selectCohort({ ...base, policyDecisionsToday: Number.NaN });
    expect(res.admitted).toEqual([]);
    expect(res.stoppedBy).toBe('day_cap');
  });

  it('a negative allowance also admits nothing', () => {
    expect(selectCohort({ ...base, allowance: -1 }).admitted).toEqual([]);
  });
});
