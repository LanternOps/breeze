import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {},
  runAfterDbContextExit: vi.fn(),
}));

import {
  SNAPSHOT_ATTESTATION_MAX_BYTES,
  evaluateSnapshotAttestation,
  expectedControlKey,
  parseAttestationStatement,
  type RecordSnapshotAttestationInput,
} from './backupAttestation';

type Vector = { name: string; statement: string; valid: boolean; sha256?: string; reason?: string; note: string };

// Shared with the helper (agent/internal/backup/attestation_test.go pins the
// same file): edit the fixture, not either implementation.
const vectors: Vector[] = JSON.parse(
  readFileSync(
    path.resolve(__dirname, '../../../../agent/internal/backup/testdata/attestation-vectors.json'),
    'utf8',
  ),
);

describe('parseAttestationStatement (shared vectors)', () => {
  it('loaded the shared fixture with valid and invalid cases', () => {
    expect(vectors.filter((v) => v.valid).length).toBeGreaterThanOrEqual(4);
    expect(vectors.filter((v) => !v.valid).length).toBeGreaterThanOrEqual(15);
  });

  for (const vector of vectors) {
    it(`${vector.valid ? 'accepts' : 'refuses'}: ${vector.name}`, () => {
      const parsed = parseAttestationStatement(vector.statement);
      if (vector.valid) {
        expect(parsed).toMatchObject({ ok: true });
        if (!parsed.ok) return;
        expect(parsed.sha256).toBe(vector.sha256);
        // The digest is over the statement bytes exactly as received.
        expect(parsed.sha256).toBe(createHash('sha256').update(vector.statement, 'utf8').digest('hex'));
        return;
      }
      expect(parsed).toEqual({ ok: false, reason: vector.reason });
    });
  }
});

describe('parseAttestationStatement', () => {
  it('refuses a non-string statement', () => {
    expect(parseAttestationStatement(42 as unknown as string)).toEqual({ ok: false, reason: 'invalid_shape' });
  });

  it('measures the size limit in UTF-8 bytes', () => {
    expect(SNAPSHOT_ATTESTATION_MAX_BYTES).toBe(16 * 1024);
    // 8200 two-byte characters = 16400 bytes but only 8200 UTF-16 units.
    const raw = `{"v":1,"agentId":"${'é'.repeat(8200)}"}`;
    expect(parseAttestationStatement(raw)).toEqual({ ok: false, reason: 'too_large' });
  });
});

describe('expectedControlKey', () => {
  it('names each control object under the snapshot prefix', () => {
    expect(expectedControlKey('s1', 'manifest')).toBe('snapshots/s1/manifest.json');
    expect(expectedControlKey('s1', 'layout')).toBe('snapshots/s1/layout.json');
    expect(expectedControlKey('s1', 'system_state_manifest')).toBe('snapshots/s1/system-state/manifest.json');
  });
});

// ── Binding ──────────────────────────────────────────────────────────────────

const SID = 'snapshot-20261108T101500Z-3f9a1c7e2b4d6a8c0e1f2a3b';
const BASE = 'snapshot-20261107T101500Z-0a1b2c3d4e5f60718293a4b5';
const JOB = '0b7f3c2e-5a1d-4c8e-9f60-2d4b8a1e7c35';
const AGENT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const H = (c: string) => c.repeat(64);

function statement(o: {
  snapshotId?: string; jobId?: string; agentId?: string;
  dispatched?: string | null; parent?: string | null;
  layout?: boolean; systemState?: boolean;
} = {}): string {
  const id = o.snapshotId ?? SID;
  const objects = [
    ...(o.layout ? [{ role: 'layout', key: `snapshots/${id}/layout.json`, sha256: H('b'), size: 20 }] : []),
    { role: 'manifest', key: `snapshots/${id}/manifest.json`, sha256: H('a'), size: 1234 },
    ...(o.systemState ? [{ role: 'system_state_manifest', key: `snapshots/${id}/system-state/manifest.json`, sha256: H('c'), size: 40 }] : []),
  ];
  return JSON.stringify({
    v: 1, snapshotId: id, jobId: o.jobId ?? JOB, agentId: o.agentId ?? AGENT,
    dispatchedBaseSnapshotId: o.dispatched ?? null, parentSnapshotId: o.parent ?? null,
    keyLayout: 'legacy_flat', objects,
  });
}

function input(overrides: Partial<RecordSnapshotAttestationInput> = {}): RecordSnapshotAttestationInput {
  return {
    snapshotDbId: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222',
    jobId: JOB,
    deviceId: '33333333-3333-4333-8333-333333333333',
    providerSnapshotId: SID,
    storageIdentity: 's3::https://s3.example.com::bucket',
    pinnedBaseProviderSnapshotId: null,
    reportsLayout: false,
    reportsSystemState: false,
    referencedFiles: undefined,
    deviceAgentId: AGENT,
    deviceIntegrityProtocolVersion: 1,
    acceptedVia: 'agent_result',
    dispatchExpectationVerified: true,
    resultReceivedAt: new Date('2026-11-08T10:20:00Z'),
    attestation: { statement: statement() },
    ...overrides,
  };
}

describe('evaluateSnapshotAttestation', () => {
  it('binds a full run to a server-fetched pending row carrying the statement verbatim', () => {
    const raw = statement();
    const result = evaluateSnapshotAttestation(input({ attestation: { statement: raw } }));
    expect(result.kind).toBe('insert');
    if (result.kind !== 'insert') return;
    expect(result.row).toMatchObject({
      statement: raw,
      statementSha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
      verificationMode: 'server_fetched',
      status: 'pending',
      dispatchedBaseProviderSnapshotId: null,
      parentProviderSnapshotId: null,
      manifestKey: `snapshots/${SID}/manifest.json`,
      manifestSha256: H('a'),
      manifestSize: 1234,
      layoutSha256: null,
      systemStateManifestSha256: null,
    });
  });

  it('records a device-local destination as producer_only (terminal, no fetch)', () => {
    const result = evaluateSnapshotAttestation(input({ storageIdentity: 'local::/mnt/usb' }));
    expect(result).toMatchObject({ kind: 'insert', row: { verificationMode: 'producer_only', status: 'producer_only' } });
  });

  it('accepts an incremental on the dispatched base', () => {
    const result = evaluateSnapshotAttestation(input({
      pinnedBaseProviderSnapshotId: BASE, referencedFiles: 12,
      attestation: { statement: statement({ dispatched: BASE, parent: BASE }) },
    }));
    expect(result).toMatchObject({ kind: 'insert', row: { dispatchedBaseProviderSnapshotId: BASE, parentProviderSnapshotId: BASE } });
  });

  it('accepts a run that fell back to full from a dispatched base (parent null, base kept)', () => {
    const result = evaluateSnapshotAttestation(input({
      pinnedBaseProviderSnapshotId: BASE, referencedFiles: 0,
      attestation: { statement: statement({ dispatched: BASE, parent: null }) },
    }));
    expect(result).toMatchObject({ kind: 'insert', row: { dispatchedBaseProviderSnapshotId: BASE, parentProviderSnapshotId: null } });
  });

  it('refuses a full statement from a run that reports inherited entries', () => {
    const result = evaluateSnapshotAttestation(input({
      pinnedBaseProviderSnapshotId: BASE, referencedFiles: 3,
      attestation: { statement: statement({ dispatched: BASE, parent: null }) },
    }));
    expect(result).toEqual({ kind: 'refuse', outcome: 'binding_mismatch', reason: 'full_run_with_references' });
  });

  it('treats an empty base pin as a full dispatch', () => {
    expect(evaluateSnapshotAttestation(input({ pinnedBaseProviderSnapshotId: '' })).kind).toBe('insert');
  });

  it.each([
    ['snapshot id', { providerSnapshotId: `${SID}x` }, 'snapshot_id'],
    ['job', { jobId: '44444444-4444-4444-8444-444444444444' }, 'job_id'],
    ['agent', { deviceAgentId: 'someone-else' }, 'agent_id'],
    ['agent unknown', { deviceAgentId: null }, 'agent_id'],
    ['dispatched base', { pinnedBaseProviderSnapshotId: BASE }, 'dispatched_base'],
    ['storage identity', { storageIdentity: null }, 'storage_identity_missing'],
    ['layout reported but not attested', { reportsLayout: true }, 'layout_presence'],
    ['system state reported but not attested', { reportsSystemState: true }, 'system_state_presence'],
  ] as const)('refuses a statement whose %s does not bind', (_name, overrides, reason) => {
    expect(evaluateSnapshotAttestation(input(overrides as Partial<RecordSnapshotAttestationInput>)))
      .toEqual({ kind: 'refuse', outcome: 'binding_mismatch', reason });
  });

  it('refuses a layout the result does not report', () => {
    const result = evaluateSnapshotAttestation(input({ attestation: { statement: statement({ layout: true }) } }));
    expect(result).toEqual({ kind: 'refuse', outcome: 'binding_mismatch', reason: 'layout_presence' });
  });

  it('binds layout and system-state digests when the result reports both', () => {
    const result = evaluateSnapshotAttestation(input({
      reportsLayout: true, reportsSystemState: true,
      attestation: { statement: statement({ layout: true, systemState: true }) },
    }));
    expect(result).toMatchObject({ kind: 'insert', row: { layoutSha256: H('b'), layoutSize: 20, systemStateManifestSha256: H('c'), systemStateManifestSize: 40 } });
  });

  it('refuses a malformed envelope or statement as invalid', () => {
    expect(evaluateSnapshotAttestation(input({ attestation: 'x' }))).toEqual({ kind: 'refuse', outcome: 'invalid', reason: 'envelope_invalid' });
    expect(evaluateSnapshotAttestation(input({ attestation: { statement: 5 } }))).toEqual({ kind: 'refuse', outcome: 'invalid', reason: 'envelope_invalid' });
    expect(evaluateSnapshotAttestation(input({ attestation: { statement: '{}' } }))).toEqual({ kind: 'refuse', outcome: 'invalid', reason: 'invalid_shape' });
  });

  it('a capable helper reporting no attestation is missing_from_capable, an older one not_offered', () => {
    expect(evaluateSnapshotAttestation(input({ attestation: undefined }))).toEqual({ kind: 'absent', outcome: 'missing_from_capable' });
    expect(evaluateSnapshotAttestation(input({ attestation: undefined, deviceIntegrityProtocolVersion: 0 }))).toEqual({ kind: 'absent', outcome: 'not_offered' });
  });

  it('never binds a result that was not tied to a consumed dispatch expectation', () => {
    expect(evaluateSnapshotAttestation(input({ dispatchExpectationVerified: false }))).toEqual({ kind: 'absent', outcome: 'missing_expectation' });
  });
});
