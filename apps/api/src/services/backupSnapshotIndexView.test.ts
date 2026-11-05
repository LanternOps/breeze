import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));

import {
  INDEX_RETRY_COOLDOWN_MS,
  snapshotIndexView,
  type SnapshotIndexViewInput,
} from './backupSnapshotIndexView';

const DIGEST = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const NOW = new Date('2026-11-05T12:00:00Z');
const LONG_AGO = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);

const BOUND = { status: 'verified', manifestSha256: DIGEST };

function input(overrides: Partial<SnapshotIndexViewInput>): SnapshotIndexViewInput {
  return {
    status: 'none',
    manifestSha256: null,
    error: null,
    integrityStatus: 'attested',
    attestation: null,
    hasRows: false,
    fileCount: null,
    referencedFiles: null,
    hydratedAt: null,
    storageIdentity: 's3::bucket',
    now: NOW,
    ...overrides,
  };
}

const READY = { view: { state: 'ready' }, shouldRequestHydration: false };
const BUILDING_REQUEST = { view: { state: 'building' }, shouldRequestHydration: true };
const BUILDING_WAIT = { view: { state: 'building' }, shouldRequestHydration: false };
const INTEGRITY_FAILED = {
  view: { state: 'unavailable', failure: 'attestation_failed', retryable: false, deviceLocal: false },
  shouldRequestHydration: false,
};

describe('snapshotIndexView rule table', () => {
  it.each<[string, Partial<SnapshotIndexViewInput>, unknown]>([
    ['complete, bound, rows', { status: 'complete', manifestSha256: DIGEST, attestation: BOUND, hasRows: true }, READY],
    ['complete, bound, no rows', { status: 'complete', manifestSha256: DIGEST, attestation: BOUND, hasRows: false, fileCount: 0 }, READY],
    ['complete, no attestation', { status: 'complete', manifestSha256: DIGEST, hasRows: true }, READY],
    ['complete, mismatch', { status: 'complete', manifestSha256: DIGEST, attestation: { status: 'mismatch', manifestSha256: DIGEST }, hasRows: true }, INTEGRITY_FAILED],
    ['complete, refused when reported', { status: 'complete', manifestSha256: DIGEST, integrityStatus: 'attestation_failed', hasRows: true }, INTEGRITY_FAILED],
    ['complete, other bytes', { status: 'complete', manifestSha256: OTHER, attestation: BOUND, hasRows: true }, BUILDING_REQUEST],
    ['complete, no recorded digest under an attestation', { status: 'complete', manifestSha256: null, attestation: BOUND, hasRows: true }, BUILDING_REQUEST],
    ['agent, rows', { status: 'agent', attestation: BOUND, hasRows: true }, READY],
    ['agent, no rows, nothing to list', { status: 'agent', hasRows: false, fileCount: 0 }, READY],
    ['none, rows', { status: 'none', hasRows: true, fileCount: 10 }, READY],
    ['none, no rows, files', { status: 'none', hasRows: false, fileCount: 18000 }, BUILDING_REQUEST],
    ['none, no rows, zero files', { status: 'none', hasRows: false, fileCount: 0 }, READY],
    ['none, no rows, zero files and zero referenced', { status: 'none', hasRows: false, fileCount: 0, referencedFiles: 0 }, READY],
    // file_count is files UPLOADED this run: an unchanged incremental uploads
    // none and references every file from older snapshots.
    ['none, no rows, unchanged incremental', { status: 'none', hasRows: false, fileCount: 0, referencedFiles: 12000 }, BUILDING_REQUEST],
    // An unknown count is not evidence the snapshot is empty: the manifest decides.
    ['none, no rows, unknown file count', { status: 'none', hasRows: false, fileCount: null }, BUILDING_REQUEST],
    ['hydrating, rows', { status: 'hydrating', hasRows: true, hydratedAt: NOW }, READY],
    ['hydrating, no rows', { status: 'hydrating', hasRows: false, fileCount: 10, hydratedAt: NOW }, BUILDING_WAIT],
    ['failed, attestation code, rows', { status: 'failed', error: 'manifest_differs_from_attestation: manifest digest x is not the attested y', hasRows: true },
      { view: { state: 'unavailable', failure: 'manifest_differs_from_attestation', retryable: false, deviceLocal: false }, shouldRequestHydration: false }],
    ['failed, attestation_failed code, no rows', { status: 'failed', error: 'attestation_failed: no match', hasRows: false }, INTEGRITY_FAILED],
    ['failed, other code, rows', { status: 'failed', error: 'manifest_invalid: bad', hasRows: true }, READY],
    ['failed, retryable code, no rows', { status: 'failed', error: 'provider_error: s3 down', hasRows: false, fileCount: 5, hydratedAt: LONG_AGO },
      { view: { state: 'unavailable', failure: 'provider_error', retryable: true, deviceLocal: false }, shouldRequestHydration: true }],
    ['failed, terminal code, no rows', { status: 'failed', error: 'manifest_invalid: bad', hasRows: false, fileCount: 5, hydratedAt: LONG_AGO },
      { view: { state: 'unavailable', failure: 'manifest_invalid', retryable: false, deviceLocal: false }, shouldRequestHydration: false }],
  ])('%s', (_name, overrides, expected) => {
    expect(snapshotIndexView(input(overrides))).toEqual(expected);
  });
});

describe('snapshotIndexView overrides', () => {
  it.each(['none', 'agent', 'hydrating', 'failed', 'complete'])('a mismatched attestation refuses a %s index, with rows', (status) => {
    expect(snapshotIndexView(input({
      status, hasRows: true, attestation: { status: 'mismatch', manifestSha256: DIGEST }, manifestSha256: DIGEST, fileCount: 5,
    }))).toEqual(INTEGRITY_FAILED);
  });

  it.each(['none', 'agent', 'hydrating', 'failed', 'complete'])('integrity_status attestation_failed refuses a %s index, with rows', (status) => {
    expect(snapshotIndexView(input({ status, hasRows: true, integrityStatus: 'attestation_failed', fileCount: 5 }))).toEqual(INTEGRITY_FAILED);
  });

  it('an attestation status this server does not know refuses the index', () => {
    expect(snapshotIndexView(input({
      status: 'complete', manifestSha256: DIGEST, hasRows: true, attestation: { status: 'from_the_future', manifestSha256: DIGEST },
    }))).toEqual(INTEGRITY_FAILED);
  });

  it('rows from other bytes on a hydrating index are not readable: building, and the running claim is left alone', () => {
    expect(snapshotIndexView(input({
      status: 'hydrating', manifestSha256: OTHER, attestation: BOUND, hasRows: true, fileCount: 5, hydratedAt: NOW,
    }))).toEqual(BUILDING_WAIT);
  });

  it('rows from other bytes on a failed index are not readable', () => {
    expect(snapshotIndexView(input({
      status: 'failed', error: 'provider_error: down', manifestSha256: OTHER, attestation: BOUND, hasRows: true, fileCount: 5, hydratedAt: LONG_AGO,
    }))).toEqual({
      view: { state: 'unavailable', failure: 'provider_error', retryable: true, deviceLocal: false },
      shouldRequestHydration: true,
    });
  });

  it('an agent index with no rows for an unchanged incremental is rebuilt', () => {
    expect(snapshotIndexView(input({ status: 'agent', hasRows: false, fileCount: 0, referencedFiles: 40 }))).toEqual(BUILDING_REQUEST);
  });

  it('rows from other bytes on a none index are rebuilt even without a file count', () => {
    expect(snapshotIndexView(input({ status: 'none', manifestSha256: OTHER, attestation: BOUND, hasRows: true, fileCount: null }))).toEqual(BUILDING_REQUEST);
  });

  it('inline rows have no digest and are unaffected by an attestation', () => {
    expect(snapshotIndexView(input({ status: 'agent', manifestSha256: null, attestation: BOUND, hasRows: true }))).toEqual(READY);
    expect(snapshotIndexView(input({ status: 'none', manifestSha256: null, attestation: BOUND, hasRows: true }))).toEqual(READY);
  });
});

describe('snapshotIndexView honest empties', () => {
  it('an agent index that lost its rows while files exist is rebuilt, not shown as an empty tree', () => {
    expect(snapshotIndexView(input({ status: 'agent', hasRows: false, fileCount: 18000 }))).toEqual(BUILDING_REQUEST);
  });

  it('a hydration that died past the stale window can be requested again', () => {
    const staleAt = new Date(NOW.getTime() - 31 * 60 * 1000);
    expect(snapshotIndexView(input({ status: 'hydrating', hasRows: false, fileCount: 5, hydratedAt: staleAt }))).toEqual(BUILDING_REQUEST);
  });

  it('a hydrating row without a claim time can be requested again', () => {
    expect(snapshotIndexView(input({ status: 'hydrating', hasRows: false, fileCount: 5, hydratedAt: null }))).toEqual(BUILDING_REQUEST);
  });

  it('a failed index with an unrecognised error stays honest and carries no free text', () => {
    const outcome = snapshotIndexView(input({ status: 'failed', error: 'garbled text from long ago', hasRows: false, fileCount: 5, hydratedAt: LONG_AGO }));
    expect(outcome).toEqual({
      view: { state: 'unavailable', failure: 'never_indexed', retryable: true, deviceLocal: false },
      shouldRequestHydration: true,
    });
  });
});

describe('snapshotIndexView failure codes and cooldown', () => {
  it('never carries file_index_error free text', () => {
    const secret = 'https://s3.example/internal-bucket/snapshots/key?X-Amz-Signature=secret';
    const outcome = snapshotIndexView(input({ status: 'failed', error: `provider_error: ${secret}`, hasRows: false, fileCount: 5, hydratedAt: LONG_AGO }));
    expect(JSON.stringify(outcome)).not.toContain(secret);
    expect(outcome.view).toMatchObject({ failure: 'provider_error' });
  });

  it('a retryable failure inside the cooldown is not requested again', () => {
    const justNow = new Date(NOW.getTime() - (INDEX_RETRY_COOLDOWN_MS - 1000));
    const outcome = snapshotIndexView(input({ status: 'failed', error: 'manifest_missing: gone', hasRows: false, fileCount: 5, hydratedAt: justNow }));
    expect(outcome.shouldRequestHydration).toBe(false);
    expect(outcome.view).toMatchObject({ state: 'unavailable', failure: 'manifest_missing', retryable: true });
  });

  it('a retryable failure past the cooldown is requested again', () => {
    const past = new Date(NOW.getTime() - (INDEX_RETRY_COOLDOWN_MS + 1000));
    expect(snapshotIndexView(input({ status: 'failed', error: 'manifest_missing: gone', hasRows: false, fileCount: 5, hydratedAt: past })).shouldRequestHydration).toBe(true);
  });

  it('marks a device-local destination so the web can say why the list cannot be read', () => {
    const outcome = snapshotIndexView(input({
      status: 'failed', error: 'manifest_missing: manifest object not found in storage', hasRows: false, fileCount: 5, hydratedAt: LONG_AGO, storageIdentity: 'local::/srv/backups',
    }));
    expect(outcome.view).toEqual({ state: 'unavailable', failure: 'manifest_missing', retryable: true, deviceLocal: true });
  });
});
