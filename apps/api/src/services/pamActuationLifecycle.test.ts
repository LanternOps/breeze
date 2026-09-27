import { describe, expect, it, vi } from 'vitest';

import {
  createPamDecisionIntent,
  PAM_TARGET_HASH_UNVERIFIED_REASON,
  requestPamCleanup,
} from './pamActuationLifecycle';

const request = {
  id: '10000000-0000-4000-8000-000000000001',
  orgId: '10000000-0000-4000-8000-000000000002',
  deviceId: '10000000-0000-4000-8000-000000000003',
  targetExecutablePath: 'C:\\Program Files\\Acme\\admin.exe',
  targetExecutableHash: 'a'.repeat(64),
  subjectUsername: 'ACME\\operator',
};

function txWithRows(rows: unknown[]) {
  return {
    execute: vi.fn(async (_query: unknown) => ({ rows: rows.shift() ?? [] })),
  };
}

// The tx.execute calls are drizzle `sql` tagged-template objects, not plain
// strings — pull the literal SQL text (with `?` placeholders) plus the raw
// bound params out of queryChunks so a test can assert on statement shape.
type SqlLike = { queryChunks: unknown[] };
function sqlText(query: unknown): string {
  const chunks = (query as SqlLike).queryChunks;
  return chunks
    .map((c) => (c && typeof c === 'object' && 'value' in (c as Record<string, unknown>)
      ? (c as { value: string[] }).value.join('')
      : '?'))
    .join('');
}
function sqlParams(query: unknown): unknown[] {
  const chunks = (query as SqlLike).queryChunks;
  return chunks.filter((c) => !(c && typeof c === 'object' && 'value' in (c as Record<string, unknown>)));
}

describe('PAM actuation lifecycle', () => {
  it('creates exactly one generation-1 active actuation and outbox event', async () => {
    const tx = txWithRows([
      [{ id: request.id, org_id: request.orgId, device_id: request.deviceId, revision: 7 }],
      [],
      [{
        id: '20000000-0000-4000-8000-000000000001',
        elevation_request_id: request.id,
        request_revision: 7,
        generation: 1,
        desired_state: 'active',
      }],
      [],
    ]);

    const result = await createPamDecisionIntent(tx as never, {
      request,
      requestRevision: 7,
      decision: 'approved',
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(result).toEqual({
      actuationId: '20000000-0000-4000-8000-000000000001',
      elevationRequestId: request.id,
      requestRevision: 7,
      generation: 1,
      desiredState: 'active',
    });
    expect(tx.execute).toHaveBeenCalledTimes(4);
  });

  it('creates denial as a generation-1 cleanup tombstone without requiring expiry', async () => {
    const tx = txWithRows([
      [{ id: request.id, org_id: request.orgId, device_id: request.deviceId, revision: 8 }],
      [],
      [{
        id: '20000000-0000-4000-8000-000000000002',
        elevation_request_id: request.id,
        request_revision: 8,
        generation: 1,
        desired_state: 'cleanup',
      }],
      [],
    ]);

    const result = await createPamDecisionIntent(tx as never, {
      request,
      requestRevision: 8,
      decision: 'denied',
      expiresAt: null,
    });

    expect(result.desiredState).toBe('cleanup');
    expect(result.generation).toBe(1);
    expect(tx.execute).toHaveBeenCalledTimes(4);
  });

  it('rejects an approved decision with a missing or elapsed expiry before writing', async () => {
    const tx = txWithRows([]);
    await expect(createPamDecisionIntent(tx as never, {
      request,
      requestRevision: 1,
      decision: 'auto_approved',
      expiresAt: null,
    })).rejects.toThrow('future expiry');
    expect(tx.execute).not.toHaveBeenCalled();
  });

  it('refuses to create an active actuation for a path-targeting decision with no target hash', async () => {
    const tx = txWithRows([
      [{ id: request.id, org_id: request.orgId, device_id: request.deviceId, revision: 3 }],
      [],
      [], // UPDATE elevation_requests
      [], // INSERT elevation_audit
    ]);

    const result = await createPamDecisionIntent(tx as never, {
      request: { ...request, targetExecutableHash: null },
      requestRevision: 3,
      decision: 'approved',
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(result).toEqual({
      actuationId: '',
      elevationRequestId: request.id,
      requestRevision: 3,
      generation: 0,
      desiredState: 'cleanup',
      refusalReason: PAM_TARGET_HASH_UNVERIFIED_REASON,
    });
    // locked-row select, existing-actuation select, the elevation_requests
    // UPDATE, and the elevation_audit INSERT — no pam_actuations row and no
    // outbox event, unlike the successful-creation path below.
    expect(tx.execute).toHaveBeenCalledTimes(4);
    const updateCall = tx.execute.mock.calls[2]![0];
    expect(sqlText(updateCall)).toContain("SET status = 'denied'");
    expect(sqlParams(updateCall)).toContain(PAM_TARGET_HASH_UNVERIFIED_REASON);
    const auditCall = tx.execute.mock.calls[3]![0];
    expect(sqlText(auditCall)).toContain('INSERT INTO elevation_audit');
    expect(sqlText(auditCall)).toContain("'denied'");
    expect(sqlText(auditCall)).toContain("'system'");
    expect(sqlParams(auditCall)).toContain(PAM_TARGET_HASH_UNVERIFIED_REASON);
  });

  it('refuses a blank (whitespace-only) target hash the same as a missing one', async () => {
    const tx = txWithRows([
      [{ id: request.id, org_id: request.orgId, device_id: request.deviceId, revision: 4 }],
      [],
      [],
      [],
    ]);

    const result = await createPamDecisionIntent(tx as never, {
      request: { ...request, targetExecutableHash: '   ' },
      requestRevision: 4,
      decision: 'auto_approved',
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(result.refusalReason).toBe(PAM_TARGET_HASH_UNVERIFIED_REASON);
    expect(result.desiredState).toBe('cleanup');
  });

  it('does not require a target hash for a decision with no target path (e.g. tech_jit_admin)', async () => {
    const tx = txWithRows([
      [{ id: request.id, org_id: request.orgId, device_id: request.deviceId, revision: 5 }],
      [],
      [{
        id: '20000000-0000-4000-8000-000000000004',
        elevation_request_id: request.id,
        request_revision: 5,
        generation: 1,
        desired_state: 'active',
      }],
      [],
    ]);

    const result = await createPamDecisionIntent(tx as never, {
      request: { ...request, targetExecutablePath: '', targetExecutableHash: null },
      requestRevision: 5,
      decision: 'approved',
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(result.refusalReason).toBeUndefined();
    expect(result.desiredState).toBe('active');
    expect(tx.execute).toHaveBeenCalledTimes(4);
  });

  it('still flows a path-targeting decision through to an active actuation when a hash is present', async () => {
    const tx = txWithRows([
      [{ id: request.id, org_id: request.orgId, device_id: request.deviceId, revision: 6 }],
      [],
      [{
        id: '20000000-0000-4000-8000-000000000005',
        elevation_request_id: request.id,
        request_revision: 6,
        generation: 1,
        desired_state: 'active',
      }],
      [],
    ]);

    const result = await createPamDecisionIntent(tx as never, {
      request, // has a full-length hash and a non-empty path
      requestRevision: 6,
      decision: 'approved',
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(result.refusalReason).toBeUndefined();
    expect(result).toEqual({
      actuationId: '20000000-0000-4000-8000-000000000005',
      elevationRequestId: request.id,
      requestRevision: 6,
      generation: 1,
      desiredState: 'active',
    });
    expect(tx.execute).toHaveBeenCalledTimes(4);
  });

  it('serializes concurrent cleanup requests so generation increments and publishes once', async () => {
    const active = {
      id: '20000000-0000-4000-8000-000000000003',
      elevation_request_id: request.id,
      request_revision: 9,
      generation: 1,
      desired_state: 'active',
    };
    const cleanup = { ...active, generation: 2, desired_state: 'cleanup' };
    const tx = txWithRows([[active], [cleanup], [cleanup], []]);

    const [first, second] = await Promise.all([
      requestPamCleanup(tx as never, { elevationRequestId: request.id, cause: 'revoked' }),
      requestPamCleanup(tx as never, { elevationRequestId: request.id, cause: 'revoked' }),
    ]);

    expect(first).toEqual(second);
    expect(first.generation).toBe(2);
    expect(first.desiredState).toBe('cleanup');
    expect(tx.execute).toHaveBeenCalledTimes(4);
  });
});
