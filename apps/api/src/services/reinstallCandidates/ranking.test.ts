import { describe, expect, it } from 'vitest';
import {
  decideFlagWrite,
  evidenceReason,
  rankCandidates,
  reasonRank,
  shouldDetectAfterHardwareReport,
  targetIneligibility,
  type CandidateRow,
  type CandidateSource,
} from './ranking';

const T0 = new Date('2027-01-10T00:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const source: CandidateSource = {
  id: '00000000-0000-4000-8000-000000000001',
  createdAt: at(0),
  enrolledAt: at(0),
  osType: 'windows',
  linkGroupId: null,
};

function target(overrides: Partial<CandidateRow> = {}): CandidateRow {
  return {
    id: '00000000-0000-4000-8000-0000000000a1',
    orgId: '00000000-0000-4000-8000-0000000000f1',
    siteId: '00000000-0000-4000-8000-0000000000e1',
    hostname: 'PC-01',
    osType: 'windows',
    orgType: 'customer',
    createdAt: at(-60 * 24 * 30),
    lastSeenAt: at(-60 * 24),
    watchdogLastSeen: null,
    isEphemeral: false,
    linkGroupId: null,
    status: 'offline',
    decommissionedAt: null,
    ...overrides,
  };
}

describe('targetIneligibility (§7.3 who qualifies)', () => {
  it('an older, silent, ordinary record qualifies', () => {
    expect(targetIneligibility(source, target(), false)).toBeNull();
  });

  it('a record that never reported qualifies', () => {
    expect(targetIneligibility(source, target({ lastSeenAt: null }), false)).toBeNull();
  });

  it.each([
    ['self', target({ id: source.id })],
    ['not_older', target({ createdAt: at(0) })],
    ['not_older', target({ createdAt: at(5) })],
    ['alive', target({ lastSeenAt: at(0) })],
    ['alive', target({ lastSeenAt: at(30) })],
    ['alive', target({ lastSeenAt: at(-600), watchdogLastSeen: at(1) })],
    ['ephemeral', target({ isEphemeral: true })],
    ['hidden_org', target({ orgType: 'unassigned_pool' })],
    ['hidden_org', target({ orgType: 'quick_support' })],
    ['decommissioned_after_source', target({ status: 'decommissioned', decommissionedAt: at(10) })],
  ] as const)('%s', (expected, row) => {
    expect(targetIneligibility(source, row, false)).toBe(expected);
  });

  it('a record ever retired as a reattach source never qualifies', () => {
    expect(targetIneligibility(source, target(), true)).toBe('retired_source');
  });

  it('a multi-boot sibling (same link group) never qualifies', () => {
    const grouped = { ...source, linkGroupId: '00000000-0000-4000-8000-0000000000c1' };
    expect(targetIneligibility(grouped, target({ linkGroupId: grouped.linkGroupId }), false)).toBe('same_link_group');
    expect(targetIneligibility(grouped, target({ linkGroupId: '00000000-0000-4000-8000-0000000000c2' }), false)).toBeNull();
    expect(targetIneligibility(grouped, target({ linkGroupId: null }), false)).toBeNull();
  });

  it('a record decommissioned BEFORE the source enrolled qualifies (#914 restore path)', () => {
    expect(targetIneligibility(source, target({ status: 'decommissioned', decommissionedAt: at(-60) }), false)).toBeNull();
    expect(targetIneligibility(source, target({ status: 'decommissioned', decommissionedAt: null }), false)).toBeNull();
  });
});

describe('rankCandidates', () => {
  const a = target({ id: 'a', osType: 'linux', lastSeenAt: at(-10) });
  const b = target({ id: 'b', osType: 'windows', lastSeenAt: at(-1000) });
  const c = target({ id: 'c', osType: 'windows', lastSeenAt: at(-100) });

  it('ranks evidence first: uuid > serial > hostname', () => {
    const ranked = rankCandidates(source, [
      { target: a, evidence: 'hostname' },
      { target: b, evidence: 'serial' },
      { target: c, evidence: 'system_uuid' },
    ]);
    expect(ranked.map((r) => [r.target.id, r.evidence, r.reason])).toEqual([
      ['c', 'system_uuid', 'hardware'],
      ['b', 'serial', 'hardware'],
      ['a', 'hostname', 'hostname'],
    ]);
  });

  it('then the same OS first, then the most recently seen', () => {
    const ranked = rankCandidates(source, [
      { target: a, evidence: 'serial' },
      { target: b, evidence: 'serial' },
      { target: c, evidence: 'serial' },
    ]);
    expect(ranked.map((r) => r.target.id)).toEqual(['c', 'b', 'a']);
  });

  it('a target matched on several kinds of evidence counts once, by its strongest', () => {
    const ranked = rankCandidates(source, [
      { target: a, evidence: 'hostname' },
      { target: a, evidence: 'system_uuid' },
      { target: c, evidence: 'serial' },
    ]);
    expect(ranked.map((r) => [r.target.id, r.evidence])).toEqual([['a', 'system_uuid'], ['c', 'serial']]);
  });

  it('never-seen records rank after seen ones; ids break ties deterministically', () => {
    const n1 = target({ id: 'n1', lastSeenAt: null });
    const n2 = target({ id: 'n2', lastSeenAt: null });
    expect(rankCandidates(source, [
      { target: n2, evidence: 'hostname' },
      { target: n1, evidence: 'hostname' },
      { target: c, evidence: 'hostname' },
    ]).map((r) => r.target.id)).toEqual(['c', 'n1', 'n2']);
  });

  it('is empty for no matches', () => {
    expect(rankCandidates(source, [])).toEqual([]);
  });
});

describe('reason mapping and rank', () => {
  it('maps uuid and serial to hardware, hostname to hostname', () => {
    expect(evidenceReason('system_uuid')).toBe('hardware');
    expect(evidenceReason('serial')).toBe('hardware');
    expect(evidenceReason('hostname')).toBe('hostname');
  });

  it('ranks tpm > hardware > hostname > none; an unknown stored reason is never outranked', () => {
    expect(reasonRank('tpm')).toBeGreaterThan(reasonRank('hardware'));
    expect(reasonRank('hardware')).toBeGreaterThan(reasonRank('hostname'));
    expect(reasonRank('hostname')).toBeGreaterThan(reasonRank(null));
    expect(reasonRank('something_new')).toBeGreaterThan(reasonRank('tpm'));
  });
});

describe('decideFlagWrite', () => {
  const none = { targetDeviceId: null, reason: null };
  const hw = (id: string) => ({ targetDeviceId: id, reason: 'hardware' as const });
  const host = (id: string) => ({ targetDeviceId: id, reason: 'hostname' as const });

  it('writes a new flag', () => {
    expect(decideFlagWrite(none, hw('t1'), true)).toEqual({ write: true, kind: 'new' });
  });

  it('writes nothing without a candidate', () => {
    expect(decideFlagWrite(host('t1'), null, false)).toEqual({ write: false, why: 'no_candidate' });
  });

  it('never rewrites an identical flag', () => {
    expect(decideFlagWrite(hw('t1'), hw('t1'), true)).toEqual({ write: false, why: 'identical' });
  });

  it('upgrades hostname to hardware, same target or another', () => {
    expect(decideFlagWrite(host('t1'), hw('t1'), true)).toEqual({ write: true, kind: 'upgrade' });
    expect(decideFlagWrite(host('t1'), hw('t2'), true)).toEqual({ write: true, kind: 'upgrade' });
  });

  it('never downgrades', () => {
    expect(decideFlagWrite(hw('t1'), host('t1'), true)).toEqual({ write: false, why: 'not_better' });
    expect(decideFlagWrite(hw('t1'), host('t2'), true)).toEqual({ write: false, why: 'not_better' });
    expect(decideFlagWrite({ targetDeviceId: 't1', reason: 'tpm' }, hw('t2'), true)).toEqual({ write: false, why: 'not_better' });
  });

  it('replaces a stored flag whose target no longer qualifies', () => {
    expect(decideFlagWrite(hw('t1'), hw('t2'), false)).toEqual({ write: true, kind: 'replace' });
    expect(decideFlagWrite(hw('t1'), host('t2'), false)).toEqual({ write: true, kind: 'replace' });
  });

  it('keeps an equal-rank flag on a still-qualifying target', () => {
    expect(decideFlagWrite(hw('t1'), hw('t2'), true)).toEqual({ write: false, why: 'not_better' });
  });
});

describe('shouldDetectAfterHardwareReport', () => {
  it('needs hardware evidence in the report', () => {
    expect(shouldDetectAfterHardwareReport({}, {})).toBe(false);
    expect(shouldDetectAfterHardwareReport({ serialNumber: 'SN1' }, {})).toBe(false);
    expect(shouldDetectAfterHardwareReport({ serialNumber: ' ', manufacturer: 'Dell' }, {})).toBe(false);
    expect(shouldDetectAfterHardwareReport({ systemUuid: null }, {})).toBe(false);
    expect(shouldDetectAfterHardwareReport({ serialNumber: 'SN1', manufacturer: 'Dell' }, {})).toBe(true);
    expect(shouldDetectAfterHardwareReport({ systemUuid: '4c4c4544-0042-3510-8051-b4c04f4d3132' }, {})).toBe(true);
  });

  it('skips a source already holding a hardware-or-better flag', () => {
    const report = { systemUuid: '4c4c4544-0042-3510-8051-b4c04f4d3132' };
    expect(shouldDetectAfterHardwareReport(report, { possibleReplacementReason: null })).toBe(true);
    expect(shouldDetectAfterHardwareReport(report, { possibleReplacementReason: 'hostname' })).toBe(true);
    expect(shouldDetectAfterHardwareReport(report, { possibleReplacementReason: 'hardware' })).toBe(false);
    expect(shouldDetectAfterHardwareReport(report, { possibleReplacementReason: 'tpm' })).toBe(false);
  });
});
