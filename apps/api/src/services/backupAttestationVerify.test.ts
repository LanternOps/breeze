import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {},
  runOutsideDbContext: vi.fn(),
  withSystemDbAccessContext: vi.fn(),
  runAfterDbContextExit: vi.fn(),
}));

const recordBackupAttestationMock = vi.hoisted(() => vi.fn());
vi.mock('./backupMetrics', () => ({ recordBackupAttestation: recordBackupAttestationMock }));

import { BackupObjectTooLargeError, MANIFEST_STREAM_MAX_BYTES } from './backupSnapshotStorage';
import { normalizeStorageIdentity } from '../jobs/backupRetention';
import { RESERVATION_CLEANUP_EVERY_MS } from './backupSnapshotIdReservations';
import {
  verifySnapshotAttestation,
  type AttestationUnderVerification,
  type AttestationVerifyDeps,
} from './backupAttestationVerify';

const SID = 'snapshot-20261108T101500Z-3f9a1c7e2b4d6a8c0e1f2a3b';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const S3_CONFIG = { bucket: 'bkt', endpoint: 'https://s3.example.test' };
const IDENTITY = normalizeStorageIdentity('s3', S3_CONFIG);

const manifest = Buffer.from(JSON.stringify({ id: SID, files: [{ sourcePath: 'a', backupPath: `snapshots/${SID}/files/a`, size: 1 }] }));
const layout = Buffer.from('{"disks":[]}');

function attestation(overrides: Partial<AttestationUnderVerification> = {}): AttestationUnderVerification {
  return {
    id: 'att-1',
    snapshotDbId: 'snap-db-1',
    status: 'pending',
    verificationMode: 'server_fetched',
    deviceId: 'device-1',
    jobId: 'job-1',
    providerSnapshotId: SID,
    storageIdentity: IDENTITY,
    keyLayout: 'legacy_flat',
    parentProviderSnapshotId: null,
    objects: [
      { role: 'layout', key: `snapshots/${SID}/layout.json`, sha256: sha(layout), size: layout.byteLength },
      { role: 'manifest', key: `snapshots/${SID}/manifest.json`, sha256: sha(manifest), size: manifest.byteLength },
    ],
    ...overrides,
  };
}

function deps(opts: {
  attestation?: AttestationUnderVerification;
  snapshot?: Partial<{ deviceId: string; jobId: string; snapshotId: string; storageIdentity: string | null; keyLayout: string; keyPrefix: string | null }> | null;
  provider?: { type: string; config: Record<string, unknown> } | null;
  objects?: Record<string, Uint8Array>;
  fetchError?: Error;
  writeInFlight?: boolean;
  sealedUntil?: Date | null;
} = {}) {
  const objects: Record<string, Uint8Array> = opts.objects ?? {
    [`snapshots/${SID}/manifest.json`]: manifest,
    [`snapshots/${SID}/layout.json`]: layout,
  };
  const finish = vi.fn(async ({ status }: { status: 'verified' | 'mismatch' }) => status as 'verified' | 'mismatch' | null);
  const defer = vi.fn(async (_args: { attestationId: string; reason: string; retryAt?: Date }): Promise<{ attemptCount: number; parked: boolean } | null> => ({ attemptCount: 1, parked: false }));
  const fetchObject = vi.fn(async ({ key, maxBytes }: { key: string; maxBytes: number }) => {
    if (opts.fetchError) throw opts.fetchError;
    const bytes = objects[key];
    if (!bytes) throw new Error('NoSuchKey');
    if (bytes.byteLength > maxBytes) throw new BackupObjectTooLargeError(key, bytes.byteLength, maxBytes);
    return bytes;
  });
  // The manifest is read as a stream (#11026): same objects, same errors, the
  // declared length checked before anything is read.
  const openObject = vi.fn(async ({ key, maxBytes }: { key: string; maxBytes: number }): Promise<NodeJS.ReadableStream> => {
    if (opts.fetchError) throw opts.fetchError;
    const bytes = objects[key];
    if (!bytes) throw new Error('NoSuchKey');
    if (bytes.byteLength > maxBytes) throw new BackupObjectTooLargeError(key, bytes.byteLength, maxBytes);
    return Readable.from([Buffer.from(bytes)]);
  });
  const readKeys = () => [...fetchObject.mock.calls, ...openObject.mock.calls].map((c) => c[0].key);
  const d: AttestationVerifyDeps = {
    load: vi.fn(async () => ({
      attestation: opts.attestation ?? attestation(),
      snapshot: opts.snapshot === null ? null : {
        deviceId: 'device-1', jobId: 'job-1', snapshotId: SID, storageIdentity: IDENTITY, keyLayout: 'legacy_flat', keyPrefix: null, ...opts.snapshot,
      },
      provider: opts.provider === undefined ? { type: 's3', config: S3_CONFIG } : opts.provider,
      writeInFlight: opts.writeInFlight,
      sealedUntil: opts.sealedUntil,
    })),
    fetchObject,
    openObject,
    finish,
    defer,
  };
  return { d, finish, fetchObject, openObject, readKeys, defer };
}

/** A manifest of exactly `size` bytes, streamed in 1 MiB chunks, and its digest. */
function paddedManifest(size: number, files: unknown[] = []) {
  const head = Buffer.from(`{"id":"${SID}","files":${JSON.stringify(files)},"pad":"`);
  const tail = Buffer.from('"}');
  const padBytes = size - head.length - tail.length;
  const chunk = Buffer.alloc(1024 * 1024, 'x');
  function* pieces() {
    yield head;
    for (let left = padBytes; left > 0; left -= chunk.length) yield left >= chunk.length ? chunk : chunk.subarray(0, left);
    yield tail;
  }
  const hash = createHash('sha256');
  for (const piece of pieces()) hash.update(piece);
  return { sha256: hash.digest('hex'), stream: () => Readable.from(pieces()) };
}

function manifestOnly(object: { sha256: string; size: number }, parentProviderSnapshotId: string | null = null) {
  return attestation({
    parentProviderSnapshotId,
    objects: [{ role: 'manifest', key: `snapshots/${SID}/manifest.json`, ...object }],
  });
}

describe('verifySnapshotAttestation of a large manifest (#11026)', () => {
  beforeEach(() => recordBackupAttestationMock.mockReset());

  it('verifies a 300 MiB attested manifest whose bytes match, read as a stream', async () => {
    const size = 300 * 1024 * 1024;
    const big = paddedManifest(size, [{ sourcePath: 'a', backupPath: `snapshots/${SID}/files/a` }]);
    const { d, openObject, fetchObject } = deps({ attestation: manifestOnly({ sha256: big.sha256, size }) });
    openObject.mockImplementation(async () => big.stream());
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'verified' });
    expect(openObject).toHaveBeenCalledWith(expect.objectContaining({ maxBytes: size }));
    expect(fetchObject).not.toHaveBeenCalled();
  }, 60_000);

  it('defers a manifest over the server stream limit, leaving the row pending, without reading it', async () => {
    const { d, finish, defer, openObject } = deps({
      attestation: manifestOnly({ sha256: 'a'.repeat(64), size: MANIFEST_STREAM_MAX_BYTES + 1 }),
    });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'retry', reason: 'manifest_over_server_limit' });
    expect(finish).not.toHaveBeenCalled();
    expect(defer).toHaveBeenCalledWith({ attestationId: 'att-1', reason: 'manifest_over_server_limit' });
    expect(openObject).not.toHaveBeenCalled();
  });

  it('defers a full run whose manifest holds an entry larger than the scanner takes, rather than failing it', async () => {
    const huge = Buffer.from(JSON.stringify({ id: SID, files: [{ sourcePath: 'x'.repeat(1024 * 1024 + 1), backupPath: `snapshots/${SID}/files/a` }] }));
    const { d, finish } = deps({
      attestation: manifestOnly({ sha256: sha(huge), size: huge.byteLength }),
      objects: { [`snapshots/${SID}/manifest.json`]: huge },
    });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'retry', reason: 'manifest_over_server_limit' });
    expect(finish).not.toHaveBeenCalled();
  });

  it('still fails a stored manifest larger than attested, without reading past the attested size', async () => {
    const bigger = Buffer.concat([manifest, Buffer.from(' ')]);
    const { d, openObject } = deps({
      attestation: manifestOnly({ sha256: sha(manifest), size: manifest.byteLength }),
      objects: { [`snapshots/${SID}/manifest.json`]: bigger },
    });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'mismatch', reason: 'manifest_size_mismatch' });
    expect(openObject).toHaveBeenCalledWith(expect.objectContaining({ maxBytes: manifest.byteLength }));
  });

  it('fails a stored manifest that grows past the attested size mid-stream', async () => {
    const { d, openObject } = deps({ attestation: manifestOnly({ sha256: sha(manifest), size: manifest.byteLength }) });
    openObject.mockImplementation(async () => {
      async function* growing() {
        yield Buffer.from(manifest);
        throw new BackupObjectTooLargeError('k', manifest.byteLength + 1, manifest.byteLength);
      }
      return Readable.from(growing());
    });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'mismatch', reason: 'manifest_size_mismatch' });
  });

  it('fails a stored manifest shorter than attested', async () => {
    const { d } = deps({
      attestation: manifestOnly({ sha256: sha(manifest), size: manifest.byteLength + 10 }),
    });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'mismatch', reason: 'manifest_size_mismatch' });
  });

  it('reports a digest mismatch ahead of the references the altered bytes carry', async () => {
    const referencing = Buffer.from(JSON.stringify({ id: SID, files: [{ sourcePath: 'a', backupPath: 'snapshots/snapshot-older/files/a' }] }));
    const { d } = deps({
      attestation: manifestOnly({ sha256: 'b'.repeat(64), size: referencing.byteLength }),
      objects: { [`snapshots/${SID}/manifest.json`]: referencing },
    });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'mismatch', reason: 'manifest_digest_mismatch' });
  });

  it('a full run with an external reference among many own ones still fails, with matching digest', async () => {
    const files = Array.from({ length: 5000 }, (_, i) => ({ sourcePath: `f${i}`, backupPath: `snapshots/${SID}/files/${i}` }));
    files[4321] = { sourcePath: 'x', backupPath: 'snapshots/snapshot-older/files/x' };
    const bytes = Buffer.from(JSON.stringify({ id: SID, files }));
    const { d } = deps({
      attestation: manifestOnly({ sha256: sha(bytes), size: bytes.byteLength }),
      objects: { [`snapshots/${SID}/manifest.json`]: bytes },
    });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'mismatch', reason: 'unexpected_references' });
  });

  it.each([
    ['malformed JSON', '{"id":"x","files":[{"backupPath":"a"},,]}'],
    ['a non-string backupPath', JSON.stringify({ id: SID, files: [{ backupPath: 7 }] })],
    ['files that is not an array', JSON.stringify({ id: SID, files: { a: 1 } })],
  ])('a full run with %s finishes manifest_unparseable', async (_name, text) => {
    const bytes = Buffer.from(text);
    const { d } = deps({
      attestation: manifestOnly({ sha256: sha(bytes), size: bytes.byteLength }),
      objects: { [`snapshots/${SID}/manifest.json`]: bytes },
    });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'mismatch', reason: 'manifest_unparseable' });
  });

  it('an incremental run is not parsed: only its bytes are checked', async () => {
    const bytes = Buffer.from('not json at all');
    const { d } = deps({
      attestation: manifestOnly({ sha256: sha(bytes), size: bytes.byteLength }, 'snapshot-older'),
      objects: { [`snapshots/${SID}/manifest.json`]: bytes },
    });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'verified' });
  });

  it('a manifest with no files key still passes', async () => {
    const bytes = Buffer.from(JSON.stringify({ id: SID }));
    const { d } = deps({
      attestation: manifestOnly({ sha256: sha(bytes), size: bytes.byteLength }),
      objects: { [`snapshots/${SID}/manifest.json`]: bytes },
    });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'verified' });
  });

  it('a manifest read that breaks mid-stream leaves the row pending', async () => {
    const { d, openObject, finish } = deps({ attestation: manifestOnly({ sha256: sha(manifest), size: manifest.byteLength }) });
    openObject.mockImplementation(async () => {
      async function* broken() {
        yield Buffer.from(manifest.subarray(0, 4));
        throw new Error('connection reset');
      }
      return Readable.from(broken());
    });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'retry', reason: 'fetch_failed:manifest' });
    expect(finish).not.toHaveBeenCalled();
  });

  it('a missing manifest leaves the row pending with its own reason', async () => {
    const notFound = Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
    const { d, openObject } = deps({ attestation: manifestOnly({ sha256: sha(manifest), size: manifest.byteLength }) });
    openObject.mockRejectedValue(notFound);
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'retry', reason: 'object_missing:manifest' });
  });

  it('sidecar roles keep the buffered read and its cap', async () => {
    const { d, fetchObject, openObject } = deps();
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'verified' });
    expect(fetchObject.mock.calls.map((c) => c[0].key)).toEqual([`snapshots/${SID}/layout.json`]);
    expect(openObject.mock.calls.map((c) => c[0].key)).toEqual([`snapshots/${SID}/manifest.json`]);
  });
});

describe('verifySnapshotAttestation', () => {
  beforeEach(() => recordBackupAttestationMock.mockReset());

  it('verifies when every attested object matches in digest and length', async () => {
    const { d, finish } = deps();
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'verified' });
    expect(finish).toHaveBeenCalledWith({ attestationId: 'att-1', snapshotDbId: 'snap-db-1', status: 'verified', verifyError: null });
    expect(recordBackupAttestationMock).toHaveBeenCalledWith('verified');
  });

  it('fails when the manifest bytes differ from the attestation', async () => {
    const altered = Buffer.from(manifest);
    altered[5] = altered[5]! ^ 1;
    const { d, finish } = deps({ objects: { [`snapshots/${SID}/manifest.json`]: altered, [`snapshots/${SID}/layout.json`]: layout } });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'mismatch', reason: 'manifest_digest_mismatch' });
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ status: 'mismatch', verifyError: 'manifest_digest_mismatch' }));
    expect(recordBackupAttestationMock).toHaveBeenCalledWith('mismatch');
  });

  it('fails when the layout manifest is shorter than attested', async () => {
    const { d } = deps({ objects: { [`snapshots/${SID}/manifest.json`]: manifest, [`snapshots/${SID}/layout.json`]: layout.subarray(1) } });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'mismatch', reason: 'layout_size_mismatch' });
  });

  it('fails when a stored object is larger than attested, without reading past the attested size', async () => {
    const bigger = Buffer.concat([layout, Buffer.from(' ')]);
    const { d, fetchObject } = deps({ objects: { [`snapshots/${SID}/manifest.json`]: manifest, [`snapshots/${SID}/layout.json`]: bigger } });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'mismatch', reason: 'layout_size_mismatch' });
    expect(fetchObject).toHaveBeenCalledWith(expect.objectContaining({ key: `snapshots/${SID}/layout.json`, maxBytes: layout.byteLength }));
  });

  it('fails a full-run attestation whose manifest references another snapshot', async () => {
    const referencing = Buffer.from(JSON.stringify({ id: SID, files: [{ sourcePath: 'a', backupPath: 'snapshots/snapshot-older/files/a', size: 1 }] }));
    const att = attestation({
      objects: [{ role: 'manifest', key: `snapshots/${SID}/manifest.json`, sha256: sha(referencing), size: referencing.byteLength }],
    });
    const { d } = deps({ attestation: att, objects: { [`snapshots/${SID}/manifest.json`]: referencing } });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'mismatch', reason: 'unexpected_references' });
  });

  it('allows references to the dispatched base when the attestation names a parent', async () => {
    const referencing = Buffer.from(JSON.stringify({ id: SID, files: [{ sourcePath: 'a', backupPath: 'snapshots/snapshot-older/files/a', size: 1 }] }));
    const att = attestation({
      parentProviderSnapshotId: 'snapshot-older',
      objects: [{ role: 'manifest', key: `snapshots/${SID}/manifest.json`, sha256: sha(referencing), size: referencing.byteLength }],
    });
    const { d } = deps({ attestation: att, objects: { [`snapshots/${SID}/manifest.json`]: referencing } });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'verified' });
  });

  it('leaves the row pending when storage cannot be read, and schedules a later attempt', async () => {
    const { d, finish, defer } = deps({ fetchError: new Error('connect ETIMEDOUT') });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'retry', reason: 'fetch_failed:layout' });
    expect(finish).not.toHaveBeenCalled();
    expect(defer).toHaveBeenCalledWith({ attestationId: 'att-1', reason: 'fetch_failed:layout' });
    expect(recordBackupAttestationMock).toHaveBeenCalledWith('verify_unavailable');
  });

  it('reports a missing object with its own reason, still without deciding the row', async () => {
    const notFound = Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
    const { d, finish, defer } = deps({ fetchError: notFound });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'retry', reason: 'object_missing:layout' });
    expect(finish).not.toHaveBeenCalled();
    expect(defer).toHaveBeenCalledWith({ attestationId: 'att-1', reason: 'object_missing:layout' });
  });

  it('defers a sealing snapshot to when its reservation is published, not to the storage-failure backoff', async () => {
    const sealedUntil = new Date('2026-09-29T01:21:07.000Z');
    const { d, finish, fetchObject, defer } = deps({ writeInFlight: true, sealedUntil });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'retry', reason: 'snapshot_sealing' });
    expect(fetchObject).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    // The cleanup job publishes on its first run after sealed_until.
    expect(RESERVATION_CLEANUP_EVERY_MS).toBe(5 * 60_000);
    expect(defer).toHaveBeenCalledWith({
      attestationId: 'att-1',
      reason: 'snapshot_sealing',
      retryAt: new Date(sealedUntil.getTime() + RESERVATION_CLEANUP_EVERY_MS),
    });
  });

  it('backs off as usual when a write is in flight without a sealing bound', async () => {
    const { d, fetchObject, defer } = deps({ writeInFlight: true, sealedUntil: null });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'retry', reason: 'snapshot_sealing' });
    expect(fetchObject).not.toHaveBeenCalled();
    expect(defer).toHaveBeenCalledTimes(1);
    expect(defer.mock.calls[0]![0]).toEqual({ attestationId: 'att-1', reason: 'snapshot_sealing' });
    expect(defer.mock.calls[0]![0]).not.toHaveProperty('retryAt');
  });

  it('reports a deferral that found the row already decided as skipped, without counting it', async () => {
    // A second verification of the same snapshot decided it between this
    // one's read and its deferral.
    const { d, defer } = deps({ writeInFlight: true, sealedUntil: new Date('2026-09-29T01:21:07.000Z') });
    defer.mockResolvedValueOnce(null);
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'skipped', reason: 'already_decided' });
    expect(recordBackupAttestationMock).not.toHaveBeenCalled();
  });

  it('counts a retry that has used up its attempts as parked', async () => {
    const { d, defer } = deps({ fetchError: new Error('connect ETIMEDOUT') });
    defer.mockResolvedValueOnce({ attemptCount: 20, parked: true });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'retry', reason: 'fetch_failed:layout' });
    expect(recordBackupAttestationMock).toHaveBeenCalledWith('verify_parked');
  });

  it('fails with binding_changed when the snapshot row names another job', async () => {
    const { d, fetchObject } = deps({ snapshot: { jobId: 'job-2' } });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'mismatch', reason: 'binding_changed' });
    expect(fetchObject).not.toHaveBeenCalled();
  });

  it('reports what the write-time binding re-check actually recorded', async () => {
    const { d, finish } = deps();
    finish.mockResolvedValueOnce('mismatch');
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'mismatch', reason: 'binding_changed' });
    expect(recordBackupAttestationMock).toHaveBeenCalledWith('mismatch');
  });

  it('leaves the row pending when the destination no longer resolves to the attested identity', async () => {
    const { d, finish, fetchObject, defer } = deps({ provider: { type: 's3', config: { bucket: 'other', endpoint: 'https://s3.example.test' } } });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'retry', reason: 'storage_identity_changed' });
    expect(fetchObject).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect(defer).toHaveBeenCalledWith({ attestationId: 'att-1', reason: 'storage_identity_changed' });
  });

  it('leaves the row pending when the destination configuration is gone', async () => {
    const { d, finish } = deps({ provider: null });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'retry', reason: 'provider_unresolved' });
    expect(finish).not.toHaveBeenCalled();
  });

  it('fails with binding_changed when the snapshot row names another device', async () => {
    const { d, fetchObject } = deps({ snapshot: { deviceId: 'device-2' } });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'mismatch', reason: 'binding_changed' });
    expect(fetchObject).not.toHaveBeenCalled();
  });

  it('fails with binding_changed when the snapshot row names another storage identity', async () => {
    const { d } = deps({ snapshot: { storageIdentity: normalizeStorageIdentity('s3', { ...S3_CONFIG, bucket: 'elsewhere' }) } });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'mismatch', reason: 'binding_changed' });
  });

  it('never fetches for a producer_only row or an already-decided row', async () => {
    const local = deps({ attestation: attestation({ verificationMode: 'producer_only', status: 'producer_only' }) });
    expect(await verifySnapshotAttestation('snap-db-1', local.d)).toEqual({ outcome: 'skipped', reason: 'not_server_fetched' });
    expect(local.fetchObject).not.toHaveBeenCalled();

    const done = deps({ attestation: attestation({ status: 'verified' }) });
    expect(await verifySnapshotAttestation('snap-db-1', done.d)).toEqual({ outcome: 'skipped', reason: 'already_decided' });
    expect(done.fetchObject).not.toHaveBeenCalled();
    expect(done.finish).not.toHaveBeenCalled();
  });

  it('reports a lost race to a concurrent verifier as skipped, without counting it', async () => {
    const { d, finish } = deps();
    finish.mockResolvedValueOnce(null);
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'skipped', reason: 'already_decided' });
    expect(recordBackupAttestationMock).not.toHaveBeenCalled();
  });

  it('refuses an attested object larger than the fetch ceiling without fetching it', async () => {
    const att = attestation({
      objects: [
        { role: 'layout', key: `snapshots/${SID}/layout.json`, sha256: sha(layout), size: 17 * 1024 * 1024 },
        { role: 'manifest', key: `snapshots/${SID}/manifest.json`, sha256: sha(manifest), size: manifest.byteLength },
      ],
    });
    const { d, fetchObject } = deps({ attestation: att });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'mismatch', reason: 'layout_too_large' });
    expect(fetchObject).not.toHaveBeenCalled();
  });
});

// #7081: the helper attests LOGICAL keys (keyLayout legacy_flat); the server
// fetches the attested objects at their physical keys under the snapshot's
// recorded root.
describe('verifySnapshotAttestation key root (#7081)', () => {
  beforeEach(() => recordBackupAttestationMock.mockReset());
  const P = 'msp/acme';

  it('binds a prefixed snapshot to its logical attestation and fetches the physical control objects', async () => {
    const { d, readKeys } = deps({
      snapshot: { keyLayout: 'prefixed_flat', keyPrefix: P },
      objects: { [`${P}/snapshots/${SID}/manifest.json`]: manifest, [`${P}/snapshots/${SID}/layout.json`]: layout },
    });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'verified' });
    expect(readKeys().sort()).toEqual([
      `${P}/snapshots/${SID}/layout.json`,
      `${P}/snapshots/${SID}/manifest.json`,
    ]);
  });

  it('still fails a snapshot in a layout this server cannot read with binding_changed', async () => {
    const { d, fetchObject } = deps({ snapshot: { keyLayout: 'device_scoped' } });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'mismatch', reason: 'binding_changed' });
    expect(fetchObject).not.toHaveBeenCalled();
  });

  it('fails a prefixed snapshot whose recorded root is unreadable, without fetching', async () => {
    const { d, fetchObject } = deps({ snapshot: { keyLayout: 'prefixed_flat', keyPrefix: 'x/snapshots' } });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'mismatch', reason: 'key_root_invalid' });
    expect(fetchObject).not.toHaveBeenCalled();
  });

  it('never binds an attestation that claims a physical layout', async () => {
    const { d, fetchObject } = deps({
      attestation: attestation({ keyLayout: 'prefixed_flat' }),
      snapshot: { keyLayout: 'prefixed_flat', keyPrefix: P },
    });
    expect(await verifySnapshotAttestation('snap-db-1', d)).toEqual({ outcome: 'mismatch', reason: 'binding_changed' });
    expect(fetchObject).not.toHaveBeenCalled();
  });
});
