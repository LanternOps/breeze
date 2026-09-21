/**
 * #6351: the "fell back to a full copy" signal.
 *
 * `classifyMissingBaseReason` is a pure mirror of the base-candidate WHERE
 * clause in `stampDispatchPinAndIdentity`; the eligibility change itself (a
 * candidate need only be unexpired NOW, not survive the whole publish lease)
 * is proved against real Postgres in
 * `__tests__/integration/backupRetentionPins.integration.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {},
  runOutsideDbContext: <T>(fn: () => T): T => fn(),
  SYSTEM_DB_ACCESS_CONTEXT: { scope: 'system', orgId: null, partnerId: null },
}));

import { classifyMissingBaseReason, type BaseCandidateProbe } from './backupWorker';

const now = new Date('2026-09-20T12:00:00Z');
const identity = 'local::/srv/backups';

function probe(overrides: Partial<BaseCandidateProbe> = {}): BaseCandidateProbe {
  return {
    expiresAt: new Date('2026-09-27T11:59:00Z'),
    storageIdentity: identity,
    backupType: 'file',
    jobStatus: 'completed',
    retired: false,
    ...overrides,
  };
}

describe('classifyMissingBaseReason', () => {
  it('reports no_prior_snapshot when the device has never been backed up', () => {
    expect(classifyMissingBaseReason(null, { storageIdentity: identity, mode: 'file', now })).toBe(
      'no_prior_snapshot',
    );
  });

  it('does NOT blame expiry for the #6351 snapshot that merely expires inside the lease window', () => {
    // Expires in 6d23h; the publish lease would run 7 days. Under the old
    // `expiresAt > publishLeaseExpiresAt` rule this snapshot was rejected —
    // it is now eligible, so nothing here classifies it as a blocker.
    expect(
      classifyMissingBaseReason(probe(), { storageIdentity: identity, mode: 'file', now }),
    ).toBe('no_prior_snapshot');
  });

  it('reports base_expired only once the snapshot is genuinely past its expiry', () => {
    expect(
      classifyMissingBaseReason(probe({ expiresAt: new Date('2026-09-20T11:59:00Z') }), {
        storageIdentity: identity,
        mode: 'file',
        now,
      }),
    ).toBe('base_expired');
  });

  it('treats a null expiry (no GFS window) as eligible', () => {
    expect(
      classifyMissingBaseReason(probe({ expiresAt: null }), {
        storageIdentity: identity,
        mode: 'file',
        now,
      }),
    ).toBe('no_prior_snapshot');
  });

  it('reports storage_identity_changed when the bucket/path was edited', () => {
    expect(
      classifyMissingBaseReason(probe({ storageIdentity: 'local::/srv/old' }), {
        storageIdentity: identity,
        mode: 'file',
        now,
      }),
    ).toBe('storage_identity_changed');
  });

  it('reports backup_type_mismatch for a system_image dispatch over file snapshots', () => {
    expect(
      classifyMissingBaseReason(probe({ backupType: 'file' }), {
        storageIdentity: identity,
        mode: 'system_image',
        now,
      }),
    ).toBe('backup_type_mismatch');
  });

  it('accepts a legacy null backupType as a file snapshot', () => {
    expect(
      classifyMissingBaseReason(probe({ backupType: null }), {
        storageIdentity: identity,
        mode: 'file',
        now,
      }),
    ).toBe('no_prior_snapshot');
  });

  it('reports base_job_not_completed when the owning job never finished', () => {
    expect(
      classifyMissingBaseReason(probe({ jobStatus: 'failed' }), {
        storageIdentity: identity,
        mode: 'file',
        now,
      }),
    ).toBe('base_job_not_completed');
  });

  it('reports base_retired when a retirement tombstone exists', () => {
    expect(
      classifyMissingBaseReason(probe({ retired: true }), {
        storageIdentity: identity,
        mode: 'file',
        now,
      }),
    ).toBe('base_retired');
  });

  it('prefers the first failing filter in WHERE-clause order', () => {
    // Identity mismatch AND expired: identity is checked first, matching the
    // order the candidate query applies its predicates.
    expect(
      classifyMissingBaseReason(
        probe({ storageIdentity: 'local::/srv/old', expiresAt: new Date('2026-01-01T00:00:00Z') }),
        { storageIdentity: identity, mode: 'file', now },
      ),
    ).toBe('storage_identity_changed');
  });
});
