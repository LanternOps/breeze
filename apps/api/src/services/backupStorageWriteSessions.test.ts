import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BACKUP_ORPHAN_MANIFEST_MAX_AGE_MS_DEFAULT } from './backupGcKnobs';
import { MAX_WRITE_URL_TTL_SECONDS } from './backupStoragePresign';
import { SNAPSHOT_TAKEOVER_MAX_AGE_MS } from './backupSnapshotIdReservations';
import {
  STORAGE_WRITE_CAPABILITIES,
  STORAGE_WRITE_PART_SIZE_BYTES,
  STORAGE_WRITE_TRANSFER_MARGIN_MS,
  appliedEncryptionOf,
  authorizeWriteKey,
  buildWriteEnvelope,
  decideResumeTarget,
  decideWriteBrokering,
  helperStorageIdentity,
  isAllowedWriteListPrefix,
  urlExpiresIn,
  writeDeleteDecision,
  type ResumeTargetView,
} from './backupStorageWriteSessions';

const ID = 'snapshot-20261108T120000Z-0123456789abcdef01234567';
const OTHER = 'snapshot-20261108T120000Z-fedcba9876543210fedcba98';

describe('authorizeWriteKey (exact-key rule)', () => {
  it.each([
    [`snapshots/${ID}/manifest.json`, 'ok'],
    [`snapshots/${ID}/files/a/b.bin`, 'ok'],
    [`snapshots/${OTHER}/files/a.bin`, 'outside_reservation'],
    [`snapshots/${ID}/../${OTHER}/files/a.bin`, 'invalid_key'],
    [`snapshots/${ID}//files/a.bin`, 'invalid_key'],
    [`snapshots/${ID}/files/`, 'invalid_key'],
    [`snapshots/${ID}`, 'invalid_key'],
    [`other/${ID}/files/a.bin`, 'invalid_key'],
    [`snapshots/${ID}/files/a\u0000b`, 'invalid_key'],
    [`snapshots/${ID}/${'x'.repeat(1100)}`, 'invalid_key'],
  ])('%s → %s', (key, expected) => {
    expect(authorizeWriteKey(key, ID)).toBe(expected);
  });

  it('compares the id verbatim (no case folding)', () => {
    expect(authorizeWriteKey(`snapshots/${ID.toUpperCase()}/manifest.json`, ID)).toBe('outside_reservation');
  });
});

describe('isAllowedWriteListPrefix', () => {
  it.each([
    [`snapshots/${ID}/`, true],
    [`snapshots/${ID}/files/`, true],
    [`snapshots/${ID}`, false],
    [`snapshots/${ID}/files`, false],
    [`snapshots/`, false],
    [`snapshots/${OTHER}/`, false],
    [`snapshots/${ID}/../`, false],
    [`snapshots/${ID}//`, false],
    [`snapshots/${ID}/./`, false],
  ])('%s → %s', (prefix, expected) => {
    expect(isAllowedWriteListPrefix(prefix, ID)).toBe(expected);
  });
});

describe('writeDeleteDecision', () => {
  const lease = `snapshots/${ID}/upload.lease`;
  const manifest = `snapshots/${ID}/manifest.json`;
  it('allows any key under the prefix while reserved, except one being completed', () => {
    expect(writeDeleteDecision(manifest, ID, 'reserved', new Set())).toBe('ok');
    expect(writeDeleteDecision(manifest, ID, 'reserved', new Set([manifest]))).toBe('upload_completing');
  });
  it('allows only the upload lease once sealing or published', () => {
    expect(writeDeleteDecision(lease, ID, 'sealing', new Set())).toBe('ok');
    expect(writeDeleteDecision(lease, ID, 'published', new Set())).toBe('ok');
    expect(writeDeleteDecision(manifest, ID, 'sealing', new Set())).toBe('reservation_sealed');
    expect(writeDeleteDecision(manifest, ID, 'published', new Set())).toBe('reservation_sealed');
  });
  it('refuses everything for other states and keys outside the reservation', () => {
    expect(writeDeleteDecision(lease, ID, 'abandoned', new Set())).toBe('reservation_sealed');
    expect(writeDeleteDecision(`snapshots/${OTHER}/manifest.json`, ID, 'reserved', new Set())).toBe('outside_reservation');
  });
});

describe('decideWriteBrokering', () => {
  const base = {
    device: { orgId: 'org-1', backupWriteProtocolVersion: 1, agentServerUrl: 'https://api.breeze.example' },
    orgId: 'org-1',
    provider: 's3',
    providerConfig: { bucket: 'b', region: 'us-east-1', endpoint: 'https://storage.example' },
    publicOrigins: ['https://api.breeze.example'],
  };

  it('brokers a capable helper writing to S3 over https', () => {
    expect(decideWriteBrokering(base)).toEqual({ ok: true, baseUrl: 'https://api.breeze.example' });
  });

  it('prefers the protocol the heartbeat reported over the stored column', () => {
    expect(decideWriteBrokering({ ...base, reportedWriteProtocolVersion: 0 })).toEqual({ ok: false, reason: 'helper_unsupported' });
    expect(decideWriteBrokering({
      ...base,
      device: { ...base.device, backupWriteProtocolVersion: 0 },
      reportedWriteProtocolVersion: 1,
    }).ok).toBe(true);
  });

  it.each([
    ['device_org_mismatch', { device: { ...base.device, orgId: 'org-2' } }],
    ['device_org_mismatch', { device: null }],
    ['helper_unsupported', { device: { ...base.device, backupWriteProtocolVersion: 0 } }],
    ['provider_not_s3', { provider: 'local' }],
    ['insecure_endpoint', { providerConfig: { ...base.providerConfig, endpoint: 'http://storage.example' } }],
    ['server_origin_mismatch', { device: { ...base.device, agentServerUrl: 'https://elsewhere.example' } }],
    ['server_origin_unavailable', { device: { ...base.device, agentServerUrl: null }, publicOrigins: [] }],
    ['insecure_server_origin', { device: { ...base.device, agentServerUrl: null }, publicOrigins: ['http://api.breeze.example'] }],
  ])('%s', (reason, patch) => {
    expect(decideWriteBrokering({ ...base, ...(patch as object) } as typeof base)).toEqual({ ok: false, reason });
  });
});

describe('buildWriteEnvelope', () => {
  it('matches the wire contract', () => {
    const envelope = buildWriteEnvelope({
      sessionId: '11111111-1111-4111-8111-111111111111',
      token: 'T'.repeat(43),
      baseUrl: 'https://api.breeze.example',
      expiresAt: new Date('2026-11-08T12:15:00.900Z'),
      deadline: new Date('2026-11-09T12:00:00Z'),
      snapshotId: ID,
      conditionalWrites: true,
      storageIdentity: 's3|https://storage.example|us-east-1|bucket-a',
    });
    expect(envelope).toEqual({
      version: 1,
      scope: 'snapshot_write',
      sessionId: '11111111-1111-4111-8111-111111111111',
      token: 'T'.repeat(43),
      baseUrl: 'https://api.breeze.example',
      expiresAt: '2026-11-08T12:15:00Z',
      deadline: '2026-11-09T12:00:00Z',
      snapshotId: ID,
      capabilities: ['resolve_batch', 'renew', 'put', 'multipart', 'list', 'delete', 'resume'],
      maxBatch: 100,
      partSizeBytes: 64 * 1024 * 1024,
      conditionalWrites: true,
      storageIdentity: 's3|https://storage.example|us-east-1|bucket-a',
    });
    expect(STORAGE_WRITE_CAPABILITIES).toContain('resume');
    expect(STORAGE_WRITE_PART_SIZE_BYTES).toBe(64 * 1024 * 1024);
  });
});

describe('delete settle window', () => {
  it('outlasts the longest a single delete call can run against storage', async () => {
    const { STORAGE_WRITE_DELETE_MAX_KEYS, STORAGE_DELETE_SETTLE_MS } = await import('./backupStorageWriteSessions');
    const { DELETE_OBJECTS_BATCH_KEYS, STORAGE_CALL_TIMEOUT_MS } = await import('./backupStoragePresign');
    // One delete request may send ceil(max keys / batch) storage calls, each
    // bounded by the per-call timeout. The cleanup job may only clear an
    // in-flight delete marker once every such call must have ended; raising
    // the key cap or the timeout without revisiting the window fails here.
    const worstCaseMs = Math.ceil(STORAGE_WRITE_DELETE_MAX_KEYS / DELETE_OBJECTS_BATCH_KEYS) * STORAGE_CALL_TIMEOUT_MS;
    expect(DELETE_OBJECTS_BATCH_KEYS).toBeGreaterThan(0);
    expect(worstCaseMs * 2).toBeLessThanOrEqual(STORAGE_DELETE_SETTLE_MS);
  });
});

describe('helperStorageIdentity', () => {
  it('is the identity the helper\'s own S3 provider reports for the same destination', () => {
    expect(helperStorageIdentity('s3', { endpoint: 'https://storage.example', region: 'us-east-1', bucket: 'b' }))
      .toBe('s3|https://storage.example|us-east-1|b');
  });
  it('keeps the configured spelling verbatim (no normalization) and blanks missing fields', () => {
    expect(helperStorageIdentity('s3', { endpoint: 'https://Storage.example/', bucket: 'B ' }))
      .toBe('s3|https://Storage.example/||B ');
    expect(helperStorageIdentity('s3', { endpoint: 42, region: null, bucket: 'b' })).toBe('s3|||b');
  });
});

describe('appliedEncryptionOf', () => {
  const ARN = 'arn:aws:kms:us-east-1:000000000000:key/1111-2222';
  const none = { algorithm: null, kmsKeyId: null };
  it('is null when nothing was requested and storage confirmed nothing', () => {
    expect(appliedEncryptionOf({ mode: 'disabled' }, none)).toBeNull();
  });
  it('reports what storage confirmed, what was requested, and whether they match', () => {
    expect(appliedEncryptionOf({ mode: 's3-sse-s3' }, { algorithm: 'AES256', kmsKeyId: null }))
      .toEqual({ algorithm: 'AES256', requested: { algorithm: 'AES256' }, matches: true });
    expect(appliedEncryptionOf({ mode: 'disabled' }, { algorithm: 'AES256', kmsKeyId: null }))
      .toEqual({ algorithm: 'AES256', requested: null, matches: true });
    expect(appliedEncryptionOf({ mode: 's3-sse-kms', keyId: ARN }, { algorithm: 'aws:kms', kmsKeyId: ARN }))
      .toEqual({ algorithm: 'aws:kms', kmsKeyId: ARN, requested: { algorithm: 'aws:kms', kmsKeyId: ARN }, matches: true });
  });
  it('accepts a key id or alias request confirmed as the key ARN', () => {
    expect(appliedEncryptionOf({ mode: 's3-sse-kms', keyId: '1111-2222' }, { algorithm: 'aws:kms', kmsKeyId: ARN })?.matches).toBe(true);
    expect(appliedEncryptionOf({ mode: 's3-sse-kms', keyId: 'alias/backups' }, { algorithm: 'aws:kms', kmsKeyId: ARN })?.matches).toBe(true);
    expect(appliedEncryptionOf({ mode: 's3-sse-kms', keyId: 'arn:aws:kms:us-east-1:000000000000:alias/backups' }, { algorithm: 'aws:kms', kmsKeyId: ARN })?.matches).toBe(true);
    expect(appliedEncryptionOf({ mode: 's3-sse-kms', keyId: '1111-2222' }, { algorithm: 'aws:kms', kmsKeyId: null })?.matches).toBe(true);
  });
  it('reports an explicit mismatch when storage confirms nothing, another algorithm or another key', () => {
    expect(appliedEncryptionOf({ mode: 's3-sse-s3' }, none))
      .toEqual({ algorithm: null, requested: { algorithm: 'AES256' }, matches: false });
    expect(appliedEncryptionOf({ mode: 's3-sse-kms', keyId: ARN }, { algorithm: 'AES256', kmsKeyId: null })?.matches).toBe(false);
    expect(appliedEncryptionOf({ mode: 's3-sse-kms', keyId: ARN }, { algorithm: 'aws:kms', kmsKeyId: `${ARN}-other` })?.matches).toBe(false);
    expect(appliedEncryptionOf({ mode: 's3-sse-kms', keyId: '1111' }, { algorithm: 'aws:kms', kmsKeyId: ARN })?.matches).toBe(false);
  });
});

describe('write URL transfer margin', () => {
  it('covers a maximum-size part on a slow link and is what sealing waits out', () => {
    // A 64 MiB part at 1 Mbit/s takes about 9 minutes.
    expect(STORAGE_WRITE_TRANSFER_MARGIN_MS).toBe(15 * 60 * 1000);
    expect((STORAGE_WRITE_PART_SIZE_BYTES * 8) / 1_000_000 / 60).toBeLessThan(STORAGE_WRITE_TRANSFER_MARGIN_MS / 60_000);
    const migration = readFileSync(
      join(__dirname, '../../migrations/2026-11-08-160000-backup-snapshot-reservation-current-job.sql'),
      'utf8',
    );
    expect(migration).toContain(`interval '${STORAGE_WRITE_TRANSFER_MARGIN_MS / 60_000} minutes'`);
    expect(MAX_WRITE_URL_TTL_SECONDS * 1000).toBeLessThan(STORAGE_WRITE_TRANSFER_MARGIN_MS);
  });
});

describe('decideResumeTarget', () => {
  const now = new Date('2026-11-10T00:00:00Z');
  const session = { orgId: 'org', deviceId: 'dev', configId: 'cfg', storageIdentity: 'ident', jobId: 'job-new' };
  const target: ResumeTargetView = {
    source: 'server_minted', orgId: 'org', deviceId: 'dev', configId: 'cfg', storageIdentity: 'ident',
    state: 'abandoned', currentJobId: 'job-old', publishedSnapshotDbId: null,
    uploadsSweptAt: new Date('2026-11-09T00:00:00Z'), createdAt: new Date('2026-11-08T00:00:00Z'),
  };
  const prior: { status: string; baseSnapshotId: string | null } = { status: 'failed', baseSnapshotId: 'snapshot-base' };
  const own: { status: string; baseSnapshotId: string | null } = { status: 'running', baseSnapshotId: 'snapshot-base' };
  const decide = (t: Partial<ResumeTargetView> = {}, p: Partial<typeof prior> | null = {}, o: Partial<typeof own> = {}, s: Partial<typeof session> = {}) =>
    decideResumeTarget({ ...target, ...t }, { ...session, ...s }, p === null ? null : { ...prior, ...p }, { ...own, ...o }, now);

  it('lets a later job of the same device, configuration, destination and base take over an unfinished id', () => {
    expect(decide()).toEqual({ kind: 'write', takeover: true });
    expect(decide({ state: 'reserved', uploadsSweptAt: null })).toEqual({ kind: 'write', takeover: true });
    expect(decide({}, { baseSnapshotId: null }, { baseSnapshotId: '' })).toEqual({ kind: 'write', takeover: true });
  });

  it.each([
    ['another device', { deviceId: 'dev-2' }],
    ['another organization', { orgId: 'org-2' }],
    ['another configuration', { configId: 'cfg-2' }],
    ['a configuration that is gone', { configId: null }],
    ['another storage destination', { storageIdentity: 'ident-2' }],
    ['an id not issued by the server', { source: 'legacy_job' }],
    ['an id given up by a resume (no job)', { currentJobId: null }],
    ['an id that already has a snapshot row', { publishedSnapshotDbId: 'snap-row' }],
    ['a retired id', { state: 'retired' }],
    ['an id older than the takeover limit', { createdAt: new Date(now.getTime() - SNAPSHOT_TAKEOVER_MAX_AGE_MS - 1) }],
  ])('refuses %s', (_label, patch) => {
    expect(decide(patch as Partial<ResumeTargetView>)).toEqual({ kind: 'refuse' });
  });

  it('refuses another dispatched base, and an earlier job whose base cannot be read', () => {
    expect(decide({}, { baseSnapshotId: 'snapshot-other' })).toEqual({ kind: 'refuse' });
    expect(decide({}, { baseSnapshotId: null })).toEqual({ kind: 'refuse' });
    expect(decide({}, null)).toEqual({ kind: 'refuse' });
    expect(decide({ state: 'published' }, { baseSnapshotId: 'snapshot-other' })).toEqual({ kind: 'refuse' });
  });

  it('waits while the earlier job is still running, or while its unfinished uploads are still being swept', () => {
    expect(decide({ state: 'reserved' }, { status: 'running' })).toMatchObject({ kind: 'wait' });
    expect(decide({ uploadsSweptAt: null })).toMatchObject({ kind: 'wait' });
  });

  it('keeps same-job resume and read-only completion of a published id', () => {
    expect(decide({ state: 'reserved', currentJobId: 'job-new' }, { status: 'running' })).toEqual({ kind: 'write', takeover: false });
    expect(decide({ state: 'published', publishedSnapshotDbId: 'snap-row' })).toEqual({ kind: 'read_only' });
    expect(decide({ state: 'sealing', publishedSnapshotDbId: 'snap-row' })).toEqual({ kind: 'read_only' });
  });

  it('keeps the takeover limit inside the window after which storage reclaim may remove an abandoned prefix', () => {
    expect(SNAPSHOT_TAKEOVER_MAX_AGE_MS).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
    // Reclaim never runs below the helper journal age (7 days); keep a full day of margin.
    expect(SNAPSHOT_TAKEOVER_MAX_AGE_MS + 24 * 60 * 60 * 1000).toBeLessThan(7 * 24 * 60 * 60 * 1000);
    expect(SNAPSHOT_TAKEOVER_MAX_AGE_MS).toBeLessThan(BACKUP_ORPHAN_MANIFEST_MAX_AGE_MS_DEFAULT);
  });
});

describe('urlExpiresIn', () => {
  it('is the whole seconds a URL has left on the server clock, never negative', () => {
    const now = new Date('2026-11-08T12:00:00.250Z');
    expect(urlExpiresIn(new Date('2026-11-08T12:05:00.250Z'), now)).toBe(300);
    expect(urlExpiresIn(new Date('2026-11-08T12:05:00.000Z'), now)).toBe(299);
    expect(urlExpiresIn(new Date('2026-11-08T11:59:00Z'), now)).toBe(0);
  });
});
