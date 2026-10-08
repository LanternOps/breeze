import { describe, expect, it, vi } from 'vitest';

const captureExceptionMock = vi.hoisted(() => vi.fn());
vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));
import { expectedControlKey } from './backupAttestation';
import {
  evaluateRestoreIntegrity,
  indexFailedOnAttestation,
  snapshotIntegrityFailed,
  indexMatchesAttestation,
  integrityPayload,
  integrityMetricLabels,
  type IntegrityAttestationInput,
  type IntegritySnapshotInput,
} from './backupRestoreIntegrity';

const SNAP = 'snapshot-20260930T101500Z-0123456789abcdef01234567';
const DEVICE = '44444444-4444-4444-8444-444444444444';
const JOB = '99999999-9999-4999-8999-999999999999';
const IDENTITY = 's3::storage.example::bucket-a';
const MANIFEST_SHA = 'a'.repeat(64);
const LAYOUT_SHA = 'b'.repeat(64);
const STATE_SHA = 'c'.repeat(64);

function snapshot(overrides: Partial<IntegritySnapshotInput> = {}): IntegritySnapshotInput {
  return {
    deviceId: DEVICE,
    jobId: JOB,
    snapshotId: SNAP,
    storageIdentity: IDENTITY,
    keyLayout: 'legacy_flat',
    integrityStatus: 'attested',
    ...overrides,
  };
}

function attestation(overrides: Partial<IntegrityAttestationInput> = {}): IntegrityAttestationInput {
  return {
    status: 'verified',
    deviceId: DEVICE,
    jobId: JOB,
    providerSnapshotId: SNAP,
    storageIdentity: IDENTITY,
    keyLayout: 'legacy_flat',
    manifestKey: `snapshots/${SNAP}/manifest.json`,
    manifestSha256: MANIFEST_SHA,
    manifestSize: 1234,
    layoutSha256: LAYOUT_SHA,
    layoutSize: 56,
    systemStateManifestSha256: STATE_SHA,
    systemStateManifestSize: 789,
    ...overrides,
  };
}

describe('evaluateRestoreIntegrity', () => {
  it('a verified attestation bound to the snapshot row is attested and server-verified, with every attested object', () => {
    expect(evaluateRestoreIntegrity(snapshot(), attestation())).toEqual({
      mode: 'attested',
      trust: 'server_verified',
      snapshotId: SNAP,
      sourceDeviceId: DEVICE,
      objects: [
        { role: 'manifest', key: `snapshots/${SNAP}/manifest.json`, sha256: MANIFEST_SHA, size: 1234 },
        { role: 'layout', key: `snapshots/${SNAP}/layout.json`, sha256: LAYOUT_SHA, size: 56 },
        { role: 'system_state_manifest', key: `snapshots/${SNAP}/system-state/manifest.json`, sha256: STATE_SHA, size: 789 },
      ],
    });
  });

  it('object keys are the control keys the attestation statement format names', () => {
    const result = evaluateRestoreIntegrity(snapshot(), attestation());
    if (result.mode !== 'attested') throw new Error('expected attested');
    for (const object of result.objects) {
      expect(object.key).toBe(expectedControlKey(SNAP, object.role));
    }
  });

  it('a device-local attestation is attested with producer-only trust', () => {
    const result = evaluateRestoreIntegrity(
      snapshot({ storageIdentity: 'local::/srv/backups', integrityStatus: 'producer_only' }),
      attestation({ status: 'producer_only', storageIdentity: 'local::/srv/backups' }),
    );
    expect(result).toMatchObject({ mode: 'attested', trust: 'producer_only', sourceDeviceId: DEVICE });
  });

  it('omits the optional control objects the snapshot was not attested with', () => {
    const result = evaluateRestoreIntegrity(
      snapshot(),
      attestation({ layoutSha256: null, layoutSize: null, systemStateManifestSha256: null, systemStateManifestSize: null }),
    );
    if (result.mode !== 'attested') throw new Error('expected attested');
    expect(result.objects.map((o) => o.role)).toEqual(['manifest']);
  });

  it('a pending attestation is unattested (pending)', () => {
    expect(evaluateRestoreIntegrity(snapshot({ integrityStatus: 'pending' }), attestation({ status: 'pending' })))
      .toEqual({ mode: 'unattested', snapshotId: SNAP, reason: 'pending' });
  });

  it('a mismatched attestation is attestation_failed', () => {
    expect(evaluateRestoreIntegrity(snapshot({ integrityStatus: 'attestation_failed' }), attestation({ status: 'mismatch' })))
      .toEqual({ mode: 'unattested', snapshotId: SNAP, reason: 'attestation_failed' });
  });

  it('an attestation status this server does not know is attestation_failed', () => {
    expect(evaluateRestoreIntegrity(snapshot(), attestation({ status: 'something_new' })))
      .toMatchObject({ mode: 'unattested', reason: 'attestation_failed' });
  });

  it.each([
    ['storage identity', { storageIdentity: 's3::other.example::bucket-b' }],
    ['source device', { deviceId: '55555555-5555-4555-8555-555555555555' }],
    ['job', { jobId: '12121212-1212-4212-8212-121212121212' }],
    ['snapshot id', { snapshotId: 'snapshot-20260930T101500Z-ffffffffffffffffffffffff' }],
    ['key layout', { keyLayout: 'device_scoped' }],
  ])('a verified attestation whose snapshot row changed %s since is attestation_failed', (_label, change) => {
    expect(evaluateRestoreIntegrity(snapshot(change), attestation()))
      .toMatchObject({ mode: 'unattested', reason: 'attestation_failed' });
  });

  it('a manifest recorded under any key other than the snapshot control key is attestation_failed', () => {
    expect(evaluateRestoreIntegrity(snapshot(), attestation({ manifestKey: 'snapshots/other/manifest.json' })))
      .toMatchObject({ mode: 'unattested', reason: 'attestation_failed' });
  });

  it('with no attestation row the snapshot projection decides between legacy and unattested', () => {
    expect(evaluateRestoreIntegrity(snapshot({ integrityStatus: 'unattested_legacy' }), null))
      .toEqual({ mode: 'unattested', snapshotId: SNAP, reason: 'unattested_legacy' });
    expect(evaluateRestoreIntegrity(snapshot({ integrityStatus: 'unattested' }), null))
      .toEqual({ mode: 'unattested', snapshotId: SNAP, reason: 'unattested' });
    // A statement refused when it was reported leaves no row, only the projection.
    expect(evaluateRestoreIntegrity(snapshot({ integrityStatus: 'attestation_failed' }), null))
      .toEqual({ mode: 'unattested', snapshotId: SNAP, reason: 'attestation_failed' });
    // A projection that claims an attestation nobody recorded is not trusted.
    expect(evaluateRestoreIntegrity(snapshot({ integrityStatus: 'attested' }), null))
      .toEqual({ mode: 'unattested', snapshotId: SNAP, reason: 'unattested' });
  });
});

describe('integrityPayload (wire shape v1)', () => {
  it('attested', () => {
    expect(JSON.stringify(integrityPayload(evaluateRestoreIntegrity(snapshot(), attestation())))).toBe(JSON.stringify({
      v: 1,
      mode: 'attested',
      trust: 'server_verified',
      snapshotId: SNAP,
      objects: [
        { role: 'manifest', key: `snapshots/${SNAP}/manifest.json`, sha256: MANIFEST_SHA, size: 1234 },
        { role: 'layout', key: `snapshots/${SNAP}/layout.json`, sha256: LAYOUT_SHA, size: 56 },
        { role: 'system_state_manifest', key: `snapshots/${SNAP}/system-state/manifest.json`, sha256: STATE_SHA, size: 789 },
      ],
    }));
  });

  it('attested, producer only', () => {
    const payload = integrityPayload(evaluateRestoreIntegrity(
      snapshot({ storageIdentity: 'local::/srv/backups' }),
      attestation({ status: 'producer_only', storageIdentity: 'local::/srv/backups', layoutSha256: null, layoutSize: null, systemStateManifestSha256: null, systemStateManifestSize: null }),
    ));
    expect(JSON.stringify(payload)).toBe(JSON.stringify({
      v: 1,
      mode: 'attested',
      trust: 'producer_only',
      snapshotId: SNAP,
      objects: [{ role: 'manifest', key: `snapshots/${SNAP}/manifest.json`, sha256: MANIFEST_SHA, size: 1234 }],
    }));
  });

  it.each(['unattested_legacy', 'unattested', 'pending', 'attestation_failed'] as const)('unattested (%s)', (reason) => {
    expect(JSON.stringify(integrityPayload({ mode: 'unattested', snapshotId: SNAP, reason }))).toBe(
      JSON.stringify({ v: 1, mode: 'unattested', snapshotId: SNAP, reason }),
    );
  });

  it('never carries the source device on the wire', () => {
    expect(integrityPayload(evaluateRestoreIntegrity(snapshot(), attestation()))).not.toHaveProperty('sourceDeviceId');
  });
});

describe('integrityMetricLabels', () => {
  it('labels attested deliveries by trust and unattested ones by reason', () => {
    expect(integrityMetricLabels(evaluateRestoreIntegrity(snapshot(), attestation()))).toEqual({ status: 'attested', reason: 'server_verified' });
    expect(integrityMetricLabels({ mode: 'unattested', snapshotId: SNAP, reason: 'pending' })).toEqual({ status: 'unattested', reason: 'pending' });
    expect(integrityMetricLabels(null)).toEqual({ status: 'absent', reason: 'snapshot_unresolved' });
  });
});

describe('indexMatchesAttestation', () => {
  const complete = { fileIndexStatus: 'complete', fileIndexManifestSha256: MANIFEST_SHA };

  it('a complete index of a snapshot with no attestation authorizes as before', () => {
    expect(indexMatchesAttestation(complete, null)).toBe(true);
  });

  it('an index that is not complete never authorizes', () => {
    for (const status of ['none', 'agent', 'hydrating', 'failed']) {
      expect(indexMatchesAttestation({ ...complete, fileIndexStatus: status }, null)).toBe(false);
    }
  });

  it.each(['pending', 'verified', 'producer_only'])('with a %s attestation it authorizes only when hydrated from the attested manifest bytes', (status) => {
    expect(indexMatchesAttestation(complete, { status, manifestSha256: MANIFEST_SHA })).toBe(true);
    expect(indexMatchesAttestation(complete, { status, manifestSha256: 'd'.repeat(64) })).toBe(false);
    expect(indexMatchesAttestation({ ...complete, fileIndexManifestSha256: null }, { status, manifestSha256: MANIFEST_SHA })).toBe(false);
  });

  it('a mismatched attestation authorizes nothing, even when the manifest digest matches', () => {
    expect(indexMatchesAttestation(complete, { status: 'mismatch', manifestSha256: MANIFEST_SHA })).toBe(false);
  });

  it('an attestation status this server does not know authorizes nothing', () => {
    expect(indexMatchesAttestation(complete, { status: 'something_new', manifestSha256: MANIFEST_SHA })).toBe(false);
  });
});

describe('snapshotIntegrityFailed', () => {
  it('is true for a mismatched attestation, a changed binding, an unknown status and a refused statement', () => {
    expect(snapshotIntegrityFailed({ ...snapshot(), attestation: attestation({ status: 'mismatch' }) })).toBe(true);
    expect(snapshotIntegrityFailed({ ...snapshot({ storageIdentity: 'other' }), attestation: attestation() })).toBe(true);
    expect(snapshotIntegrityFailed({ ...snapshot(), attestation: attestation({ status: 'something_new' }) })).toBe(true);
    expect(snapshotIntegrityFailed({ ...snapshot({ integrityStatus: 'attestation_failed' }), attestation: null })).toBe(true);
  });

  it('is false for attested, pending and unattested snapshots', () => {
    expect(snapshotIntegrityFailed({ ...snapshot(), attestation: attestation() })).toBe(false);
    expect(snapshotIntegrityFailed({ ...snapshot(), attestation: attestation({ status: 'pending' }) })).toBe(false);
    expect(snapshotIntegrityFailed({ ...snapshot({ integrityStatus: 'unattested_legacy' }), attestation: null })).toBe(false);
    expect(snapshotIntegrityFailed({ ...snapshot({ integrityStatus: 'unattested' }), attestation: null })).toBe(false);
  });
});

describe('indexFailedOnAttestation', () => {
  it('recognizes only the attestation-related hydration failures', () => {
    expect(indexFailedOnAttestation('manifest_differs_from_attestation: x')).toBe(true);
    expect(indexFailedOnAttestation('attestation_failed: x')).toBe(true);
    expect(indexFailedOnAttestation('origin_unverifiable: x')).toBe(false);
    expect(indexFailedOnAttestation(null)).toBe(false);
  });
});

describe('indexMatchesAttestation with a refused statement and no row', () => {
  it('authorizes nothing when the snapshot is recorded as failing its integrity check', () => {
    expect(indexMatchesAttestation({ fileIndexStatus: 'complete', fileIndexManifestSha256: MANIFEST_SHA, integrityStatus: 'attestation_failed' }, null)).toBe(false);
    expect(indexMatchesAttestation({ fileIndexStatus: 'complete', fileIndexManifestSha256: MANIFEST_SHA, integrityStatus: 'unattested_legacy' }, null)).toBe(true);
  });
});

