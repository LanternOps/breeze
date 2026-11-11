import { describe, expect, it } from 'vitest';
import {
  HARDWARE_REPORT_DETECTION_WINDOW_MS,
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
  const SRC_ORG = 'org-src';
  const OTHER_ORG = 'org-other';
  const none = { targetDeviceId: null, reason: null };
  const stored = (id: string, reason: 'hardware' | 'hostname' | 'tpm', targetOrgId = SRC_ORG) => ({ targetDeviceId: id, reason, targetOrgId });
  const cand = (id: string, reason: 'hardware' | 'hostname', orgId = SRC_ORG) => ({ targetDeviceId: id, orgId, reason });
  const decide = (
    s: { targetDeviceId: string | null; reason: string | null; targetOrgId?: string | null },
    best: ReturnType<typeof cand> | null,
    storedIneligibility: Parameters<typeof decideFlagWrite>[0]['storedIneligibility'] = null,
  ) => decideFlagWrite({ sourceOrgId: SRC_ORG, stored: s, best, storedIneligibility });

  it('writes a new flag', () => {
    expect(decide(none, cand('t1', 'hardware'))).toEqual({ write: true, kind: 'new' });
  });

  it('writes nothing without a flag or a candidate', () => {
    expect(decide(none, null)).toEqual({ write: false, why: 'no_candidate' });
  });

  it('never rewrites an identical flag', () => {
    expect(decide(stored('t1', 'hardware'), cand('t1', 'hardware'))).toEqual({ write: false, why: 'identical' });
  });

  it('upgrades hostname to hardware, same target or another, even cross-org', () => {
    expect(decide(stored('t1', 'hostname'), cand('t1', 'hardware'))).toEqual({ write: true, kind: 'upgrade' });
    expect(decide(stored('t1', 'hostname'), cand('t2', 'hardware', OTHER_ORG))).toEqual({ write: true, kind: 'upgrade' });
  });

  it('never downgrades a still-qualifying flag', () => {
    expect(decide(stored('t1', 'hardware'), cand('t1', 'hostname'))).toEqual({ write: false, why: 'not_better' });
    expect(decide(stored('t1', 'hardware'), cand('t2', 'hostname'))).toEqual({ write: false, why: 'not_better' });
    expect(decide(stored('t1', 'tpm'), cand('t2', 'hardware'))).toEqual({ write: false, why: 'not_better' });
    expect(decide(stored('t1', 'hardware'), cand('t2', 'hardware'))).toEqual({ write: false, why: 'not_better' });
    expect(decide(stored('t1', 'hardware'), null)).toEqual({ write: false, why: 'no_candidate' });
  });

  it('replaces a stored flag whose target no longer qualifies', () => {
    expect(decide(stored('t1', 'hardware'), cand('t2', 'hardware'), 'decommissioned_after_source')).toEqual({ write: true, kind: 'replace' });
    expect(decide(stored('t1', 'hardware'), cand('t2', 'hostname'), 'alive')).toEqual({ write: true, kind: 'replace' });
    expect(decide(stored('t1', 'hardware', OTHER_ORG), cand('t2', 'hardware', OTHER_ORG), 'missing')).toEqual({ write: true, kind: 'replace' });
  });

  it('clears a stale flag when nothing replaces it', () => {
    expect(decide(stored('t1', 'hardware'), null, 'alive')).toEqual({ write: true, kind: 'clear' });
    expect(decide(stored('t1', 'hostname'), null, 'decommissioned_after_source')).toEqual({ write: true, kind: 'clear' });
    expect(decide(stored('t1', 'hardware'), null, 'missing')).toEqual({ write: true, kind: 'clear' });
  });

  it('keeps a hostname link whose target is merely alive (the #2764 lookalike case)', () => {
    expect(decide(stored('t1', 'hostname'), null, 'alive')).toEqual({ write: false, why: 'kept_live_hostname_link' });
    expect(decide(stored('t1', 'hostname'), cand('t2', 'hostname'), 'alive')).toEqual({ write: false, why: 'kept_live_hostname_link' });
  });

  it('never replaces a same-org flag with a cross-org one of the same rank (finding 4)', () => {
    expect(decide(stored('t1', 'hardware', SRC_ORG), cand('t2', 'hardware', OTHER_ORG), 'decommissioned_after_source'))
      .toEqual({ write: false, why: 'kept_same_org' });
    // A same-org replacement of the same rank is fine, and a cross-org one of a higher rank is an upgrade.
    expect(decide(stored('t1', 'hardware', SRC_ORG), cand('t2', 'hardware', SRC_ORG), 'decommissioned_after_source'))
      .toEqual({ write: true, kind: 'replace' });
    expect(decide(stored('t1', 'hostname', SRC_ORG), cand('t2', 'hardware', OTHER_ORG), 'decommissioned_after_source'))
      .toEqual({ write: true, kind: 'upgrade' });
  });
});

describe('shouldDetectAfterHardwareReport', () => {
  const NOW = new Date('2027-01-20T00:00:00Z');
  const fresh = { enrolledAt: new Date(NOW.getTime() - 60_000) };

  it('needs hardware evidence in the report', () => {
    expect(shouldDetectAfterHardwareReport({}, fresh, NOW)).toBe(false);
    expect(shouldDetectAfterHardwareReport({ serialNumber: 'SN1' }, fresh, NOW)).toBe(false);
    expect(shouldDetectAfterHardwareReport({ serialNumber: ' ', manufacturer: 'Dell' }, fresh, NOW)).toBe(false);
    expect(shouldDetectAfterHardwareReport({ systemUuid: null }, fresh, NOW)).toBe(false);
    expect(shouldDetectAfterHardwareReport({ serialNumber: 'SN1', manufacturer: 'Dell' }, fresh, NOW)).toBe(true);
    expect(shouldDetectAfterHardwareReport({ systemUuid: '4c4c4544-0042-3510-8051-b4c04f4d3132' }, fresh, NOW)).toBe(true);
  });

  it('skips a source already holding a hardware-or-better flag', () => {
    const report = { systemUuid: '4c4c4544-0042-3510-8051-b4c04f4d3132' };
    expect(shouldDetectAfterHardwareReport(report, { ...fresh, possibleReplacementReason: null }, NOW)).toBe(true);
    expect(shouldDetectAfterHardwareReport(report, { ...fresh, possibleReplacementReason: 'hostname' }, NOW)).toBe(true);
    expect(shouldDetectAfterHardwareReport(report, { ...fresh, possibleReplacementReason: 'hardware' }, NOW)).toBe(false);
    expect(shouldDetectAfterHardwareReport(report, { ...fresh, possibleReplacementReason: 'tpm' }, NOW)).toBe(false);
  });

  it('runs only within the detection window after enrollment (no retroactive fleet sweep)', () => {
    const report = { systemUuid: '4c4c4544-0042-3510-8051-b4c04f4d3132' };
    const at = (ms: number) => ({ enrolledAt: new Date(NOW.getTime() - ms) });
    expect(HARDWARE_REPORT_DETECTION_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(shouldDetectAfterHardwareReport(report, at(HARDWARE_REPORT_DETECTION_WINDOW_MS), NOW)).toBe(true);
    expect(shouldDetectAfterHardwareReport(report, at(HARDWARE_REPORT_DETECTION_WINDOW_MS + 1), NOW)).toBe(false);
    expect(shouldDetectAfterHardwareReport(report, at(365 * 24 * 60 * 60 * 1000), NOW)).toBe(false);
    // Falls back to created_at; no date at all never searches.
    expect(shouldDetectAfterHardwareReport(report, { createdAt: new Date(NOW.getTime() - 1000) }, NOW)).toBe(true);
    expect(shouldDetectAfterHardwareReport(report, {}, NOW)).toBe(false);
  });
});
