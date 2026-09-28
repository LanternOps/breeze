import { describe, expect, it } from 'vitest';
import {
  STORAGE_WRITE_CAPABILITIES,
  STORAGE_WRITE_PART_SIZE_BYTES,
  authorizeWriteKey,
  buildWriteEnvelope,
  decideWriteBrokering,
  isAllowedWriteListPrefix,
  writeDeleteDecision,
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
