import { describe, expect, it, vi } from 'vitest';

import {
  createPamDecisionIntent,
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
    execute: vi.fn(async () => ({ rows: rows.shift() ?? [] })),
  };
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
