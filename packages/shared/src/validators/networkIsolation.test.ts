import { describe, expect, it } from 'vitest';
import {
  containmentDesiredBlockSchema,
  extendNetworkIsolationSchema,
  isolationAllowEntrySchema,
  networkIsolationReportSchema,
  networkIsolationResultSchema,
  releaseNetworkIsolationSchema,
  startNetworkIsolationSchema,
} from './networkIsolation';

const ISOLATION_ID = '6f1c2a9e-4b3d-4c5e-8f70-1a2b3c4d5e6f';
const INCIDENT_ID = '0b9e7d6c-5a4f-4e3d-9c2b-1a0f9e8d7c6b';
const SECRET_B64 = Buffer.alloc(32, 7).toString('base64');

describe('isolationAllowEntrySchema', () => {
  it('accepts host and cidr entries', () => {
    expect(isolationAllowEntrySchema.parse({ kind: 'host', host: 'control.example.test', proto: 'tcp', ports: [443], scope: 'breeze' }))
      .toEqual({ kind: 'host', host: 'control.example.test', proto: 'tcp', ports: [443], scope: 'breeze' });
    for (const cidr of ['203.0.113.0/24', '198.51.100.7/32', '2001:db8::/32']) {
      expect(isolationAllowEntrySchema.safeParse({ kind: 'cidr', cidr, proto: 'udp+tcp', ports: [3478, 5349], scope: 'any' }).success, cidr).toBe(true);
    }
  });

  it('rejects malformed entries', () => {
    const bad: unknown[] = [
      { kind: 'host', host: '', proto: 'tcp', ports: [443], scope: 'breeze' },
      { kind: 'host', host: '192.0.2.10', proto: 'tcp', ports: [443], scope: 'breeze' }, // an address is a cidr entry
      { kind: 'host', host: 'control.example.test/evil', proto: 'tcp', ports: [443], scope: 'breeze' },
      { kind: 'host', host: 'control.example.test', proto: 'icmp', ports: [443], scope: 'breeze' },
      { kind: 'host', host: 'control.example.test', proto: 'tcp', ports: [], scope: 'breeze' },
      { kind: 'host', host: 'control.example.test', proto: 'tcp', ports: [0], scope: 'breeze' },
      { kind: 'host', host: 'control.example.test', proto: 'tcp', ports: [65536], scope: 'breeze' },
      { kind: 'host', host: 'control.example.test', proto: 'tcp', ports: [443.5], scope: 'breeze' },
      { kind: 'host', host: 'control.example.test', proto: 'tcp', ports: [443], scope: 'everyone' },
      { kind: 'cidr', cidr: '203.0.113.0', proto: 'tcp', ports: [443], scope: 'any' },
      { kind: 'cidr', cidr: '0.0.0.0/0', proto: 'tcp', ports: [443], scope: 'any' }, // never a blanket permit
      { kind: 'cidr', cidr: '::/0', proto: 'tcp', ports: [443], scope: 'any' },
      { kind: 'host', host: 'control.example.test', proto: 'tcp', ports: [443], scope: 'breeze', extra: true },
      { kind: 'host', host: '127.1', proto: 'tcp', ports: [443], scope: 'breeze' }, // numeric last label reads as an address
      { kind: 'host', host: '3232235777', proto: 'tcp', ports: [443], scope: 'breeze' },
    ];
    for (const entry of bad) expect(isolationAllowEntrySchema.safeParse(entry).success, JSON.stringify(entry)).toBe(false);
  });
});

describe('startNetworkIsolationSchema', () => {
  it('accepts exactly one of incidentId and createIncident', () => {
    expect(startNetworkIsolationSchema.safeParse({ incidentId: INCIDENT_ID, reason: 'Ransomware note on reception PC' }).success).toBe(true);
    expect(startNetworkIsolationSchema.safeParse({
      createIncident: { severity: 'p1', title: 'Ransomware on reception PC' }, reason: 'Encrypting shares', ttlHours: 24, remoteRelay: true,
    }).success).toBe(true);
    expect(startNetworkIsolationSchema.safeParse({ reason: 'no incident' }).success).toBe(false);
    expect(startNetworkIsolationSchema.safeParse({
      incidentId: INCIDENT_ID, createIncident: { severity: 'p2', title: 'both' }, reason: 'both',
    }).success).toBe(false);
  });

  it('bounds ttlHours to 1..720 and reason to 1..2000 characters', () => {
    const base = { incidentId: INCIDENT_ID, reason: 'x' };
    for (const ttlHours of [1, 72, 720]) expect(startNetworkIsolationSchema.safeParse({ ...base, ttlHours }).success, String(ttlHours)).toBe(true);
    for (const ttlHours of [0, 721, 1.5, -3]) expect(startNetworkIsolationSchema.safeParse({ ...base, ttlHours }).success, String(ttlHours)).toBe(false);
    expect(startNetworkIsolationSchema.safeParse({ ...base, reason: '' }).success).toBe(false);
    expect(startNetworkIsolationSchema.safeParse({ ...base, reason: '   ' }).success).toBe(false);
    expect(startNetworkIsolationSchema.safeParse({ ...base, reason: 'r'.repeat(2000) }).success).toBe(true);
    expect(startNetworkIsolationSchema.safeParse({ ...base, reason: 'r'.repeat(2001) }).success).toBe(false);
  });

  it('never accepts an allowlist from the caller', () => {
    const r = startNetworkIsolationSchema.safeParse({
      incidentId: INCIDENT_ID, reason: 'x', allow: [{ kind: 'cidr', cidr: '203.0.113.0/24', proto: 'tcp', ports: [443], scope: 'any' }],
    });
    expect(r.success).toBe(false);
  });

  it('validates the createIncident severity and title', () => {
    expect(startNetworkIsolationSchema.safeParse({ createIncident: { severity: 'p5', title: 't' }, reason: 'x' }).success).toBe(false);
    expect(startNetworkIsolationSchema.safeParse({ createIncident: { severity: 'p3', title: '' }, reason: 'x' }).success).toBe(false);
  });
});

describe('release / extend schemas', () => {
  it('release needs a reason; extend needs ttlHours 1..720', () => {
    expect(releaseNetworkIsolationSchema.safeParse({ reason: 'Threat removed, reimaged' }).success).toBe(true);
    expect(releaseNetworkIsolationSchema.safeParse({}).success).toBe(false);
    expect(extendNetworkIsolationSchema.safeParse({ ttlHours: 48 }).success).toBe(true);
    expect(extendNetworkIsolationSchema.safeParse({ ttlHours: 0 }).success).toBe(false);
    expect(extendNetworkIsolationSchema.safeParse({ ttlHours: 721 }).success).toBe(false);
  });
});

describe('containmentDesiredBlockSchema (heartbeat response)', () => {
  const block = {
    isolationId: ISOLATION_ID, generation: 1, desired: 'isolated', expiresAt: '2026-11-01T12:00:00.000Z',
    deadManSeconds: 0, remoteRelay: true,
    allow: [{ kind: 'host', host: 'control.example.test', proto: 'tcp', ports: [443], scope: 'breeze' }],
  };

  it('accepts null (nothing to assert) and an isolate block with or without the secret', () => {
    expect(containmentDesiredBlockSchema.safeParse({ networkIsolation: null }).success).toBe(true);
    expect(containmentDesiredBlockSchema.safeParse({ networkIsolation: block }).success).toBe(true);
    expect(containmentDesiredBlockSchema.safeParse({ networkIsolation: { ...block, breakGlassSecret: SECRET_B64 } }).success).toBe(true);
  });

  it('an isolate block always permits something (the control plane)', () => {
    expect(containmentDesiredBlockSchema.safeParse({ networkIsolation: { ...block, allow: [] } }).success).toBe(false);
  });

  it('a release tombstone carries no permits and never the secret', () => {
    const tombstone = { ...block, desired: 'released', allow: [] };
    expect(containmentDesiredBlockSchema.safeParse({ networkIsolation: tombstone }).success).toBe(true);
    expect(containmentDesiredBlockSchema.safeParse({ networkIsolation: { ...tombstone, allow: block.allow } }).success).toBe(false);
    expect(containmentDesiredBlockSchema.safeParse({ networkIsolation: { ...tombstone, breakGlassSecret: SECRET_B64 } }).success).toBe(false);
  });

  it('caps the allowlist at the shared limit', () => {
    const allow = Array.from({ length: 65 }, (_, i) => ({ kind: 'host', host: `h${i}.example.test`, proto: 'tcp', ports: [443], scope: 'breeze' }));
    expect(containmentDesiredBlockSchema.safeParse({ networkIsolation: { ...block, allow } }).success).toBe(false);
    expect(containmentDesiredBlockSchema.safeParse({ networkIsolation: { ...block, allow: allow.slice(0, 64) } }).success).toBe(true);
  });

  it('requires the networkIsolation key: absent never means "no change"', () => {
    expect(containmentDesiredBlockSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a secret that is not base64 of exactly 32 bytes', () => {
    for (const breakGlassSecret of ['', 'not base64!!', Buffer.alloc(16).toString('base64'), Buffer.alloc(33).toString('base64')]) {
      expect(containmentDesiredBlockSchema.safeParse({ networkIsolation: { ...block, breakGlassSecret } }).success, breakGlassSecret).toBe(false);
    }
  });

  it('rejects a bad generation, desired state or timestamp', () => {
    for (const patch of [{ generation: 0 }, { desired: 'paused' }, { expiresAt: 'tomorrow' }, { deadManSeconds: -1 }]) {
      expect(containmentDesiredBlockSchema.safeParse({ networkIsolation: { ...block, ...patch } }).success, JSON.stringify(patch)).toBe(false);
    }
  });
});

describe('networkIsolationReportSchema (heartbeat request)', () => {
  const report = {
    isolationId: ISOLATION_ID, generation: 2, journalSeq: 41, state: 'verified', phase: 'committed', mechanism: 'wfp',
    appliedAt: '2026-10-30T10:00:00.000Z', lastVerifiedAt: '2026-10-30T10:05:00.000Z', ruleDigest: 'sha256:abc', lastError: null,
  };

  it('accepts a full report, with optional ack, recovery version and events', () => {
    expect(networkIsolationReportSchema.safeParse(report).success).toBe(true);
    expect(networkIsolationReportSchema.safeParse({
      ...report, secretAckSeq: 3, recoveryVersion: '1.0.0',
      events: [{ seq: 40, at: '2026-10-30T10:04:00.000Z', type: 'drift_reapplied', generation: 2 }],
    }).success).toBe(true);
  });

  it('accepts the "nothing Breeze-owned is installed" form, with isolationId null or omitted (Go omitempty)', () => {
    expect(networkIsolationReportSchema.safeParse({ isolationId: null, phase: 'none' }).success).toBe(true);
    expect(networkIsolationReportSchema.safeParse({ phase: 'none' }).success).toBe(true);
    expect(networkIsolationReportSchema.safeParse({ isolationId: null, phase: 'none', journalSeq: 12 }).success).toBe(true);
    expect(networkIsolationReportSchema.safeParse({ isolationId: null, phase: 'committed' }).success).toBe(false);
    expect(networkIsolationReportSchema.safeParse({ phase: 'committed' }).success).toBe(false);
  });

  it('rejects an unknown state, phase or a negative journalSeq', () => {
    for (const patch of [{ state: 'quarantined' }, { phase: 'half_applied' }, { journalSeq: -1 }, { generation: 0 }, { isolationId: 'nope' }]) {
      expect(networkIsolationReportSchema.safeParse({ ...report, ...patch }).success, JSON.stringify(patch)).toBe(false);
    }
  });

  it('rejects server-only states from the agent', () => {
    for (const state of ['requested', 'dispatched', 'release_requested', 'uninstalled']) {
      expect(networkIsolationReportSchema.safeParse({ ...report, state }).success, state).toBe(false);
    }
  });

  it('truncates long diagnostics instead of dropping the whole report', () => {
    const parsed = networkIsolationReportSchema.parse({
      ...report, lastError: 'e'.repeat(5000),
      events: [{ seq: 40, at: '2026-10-30T10:04:00.000Z', type: 'apply_error', detail: 'd'.repeat(5000) }],
    });
    expect('lastError' in parsed && parsed.lastError).toHaveLength(1000);
    expect(parsed.events?.[0]?.detail).toHaveLength(500);
  });

  it('bounds the event list', () => {
    const events = Array.from({ length: 201 }, (_, i) => ({ seq: i, at: '2026-10-30T10:04:00.000Z', type: 'reverify_ok' }));
    expect(networkIsolationReportSchema.safeParse({ ...report, events }).success).toBe(false);
  });
});

describe('networkIsolationResultSchema shared evidence contract', () => {
  const base = { isolationId: ISOLATION_ID, generation: 1, journalSeq: 2 };
  it.each([['applying', 'provisional'], ['applied', 'committed'], ['verified', 'committed'], ['failed', 'rolled_back'], ['released', 'released'], ['expired', 'released'], ['released_locally', 'released'], ['self_released', 'released']])('assigns the typed phase for %s', (state, phase) => {
    expect(networkIsolationResultSchema.parse({ ...base, state }).phase).toBe(phase);
  });
  it('shares the report closed state vocabulary and ordering bounds', () => {
    for (const patch of [{ state: 'unknown' }, { state: 'requested' }, { generation: 0 }, { journalSeq: -1 }]) {
      expect(networkIsolationResultSchema.safeParse({ ...base, state: 'verified', ...patch }).success).toBe(false);
    }
  });
  it('maps verifiedAt to the report timestamp and strips unknown keys', () => {
    const verifiedAt = '2026-10-31T12:00:00Z';
    expect(networkIsolationResultSchema.parse({ ...base, state: 'verified', verifiedAt, breakGlassSecret: SECRET_B64 })).toMatchObject({ lastVerifiedAt: verifiedAt });
    expect(networkIsolationResultSchema.parse({ ...base, state: 'verified', breakGlassSecret: SECRET_B64 })).not.toHaveProperty('breakGlassSecret');
  });
});
