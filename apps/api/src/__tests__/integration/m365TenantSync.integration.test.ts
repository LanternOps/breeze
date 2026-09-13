/**
 * Integration test — M365 tenant sync end to end (real PG + in-process fake executor)
 *
 * Drives `runSyncDomain` directly (never through BullMQ) against a node http
 * server that verifies the API's EdDSA internal-auth JWT exactly as
 * apps/m365-graph-read-executor/src/internalAuth.ts does, and returns canned
 * M365SyncActionResult payloads keyed by action.type.
 *
 * Run:
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/m365TenantSync.integration.test.ts
 */
import './setup';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, importJWK } from 'jose';
import { createFakeSyncExecutor, type FakeSyncExecutor } from './m365SyncFakeExecutor';

const runDb = it.runIf(!!process.env.DATABASE_URL);

let executor: FakeSyncExecutor;

beforeAll(async () => {
  executor = await createFakeSyncExecutor();
});

afterAll(async () => {
  await executor.close();
});

async function post(body: unknown, mutate: (claims: Record<string, unknown>) => Record<string, unknown> = (c) => c) {
  const raw = JSON.stringify(body);
  const issuedAt = Math.floor(Date.now() / 1_000);
  const claims = mutate({
    operation: 'sync-action',
    correlationId: randomUUID(),
    bodySha256: createHash('sha256').update(raw).digest('base64url'),
  });
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA', kid: executor.signingKid })
    .setIssuer('breeze-api')
    .setAudience('m365-graph-read-executor')
    .setSubject('breeze-control-plane')
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 60)
    .setJti(randomUUID())
    .sign(await importJWK(executor.signingPrivateJwk, 'EdDSA'));
  return fetch(`${executor.origin}/v1/sync-action`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: raw,
  });
}

describe('fake sync executor harness', () => {
  it('accepts a correctly signed sync-action and returns the queued result', async () => {
    executor.enqueue('m365.sync.skus', {
      success: true, kind: 'sync', items: [], truncated: false,
      fetchedAt: '2026-09-08T10:00:00.000Z', sources: { subscribedSkus: 'ok' },
    });
    const response = await post({
      correlationId: randomUUID(),
      tenantId: '44444444-4444-4444-8444-444444444444',
      action: { type: 'm365.sync.skus' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    await expect(response.json()).resolves.toMatchObject({ kind: 'sync', truncated: false });
    expect(executor.calls.at(-1)).toMatchObject({ actionType: 'm365.sync.skus' });
  });

  it('rejects a token whose bodySha256 does not bind the received bytes', async () => {
    const before = executor.unauthorizedCount;
    const response = await post(
      { correlationId: randomUUID(), tenantId: '44444444-4444-4444-8444-444444444444', action: { type: 'm365.sync.skus' } },
      (claims) => ({ ...claims, bodySha256: createHash('sha256').update('{}').digest('base64url') }),
    );
    expect(response.status).toBe(401);
    expect(executor.unauthorizedCount).toBe(before + 1);
  });

  it('rejects a token bound to another operation', async () => {
    const response = await post(
      { correlationId: randomUUID(), tenantId: '44444444-4444-4444-8444-444444444444', action: { type: 'm365.sync.skus' } },
      (claims) => ({ ...claims, operation: 'read-action' }),
    );
    expect(response.status).toBe(401);
  });

  it('rejects a token whose lifetime exceeds 60 seconds', async () => {
    const raw = JSON.stringify({ correlationId: randomUUID(), tenantId: '44444444-4444-4444-8444-444444444444', action: { type: 'm365.sync.skus' } });
    const issuedAt = Math.floor(Date.now() / 1_000);
    const token = await new SignJWT({
      operation: 'sync-action', correlationId: randomUUID(),
      bodySha256: createHash('sha256').update(raw).digest('base64url'),
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: executor.signingKid })
      .setIssuer('breeze-api').setAudience('m365-graph-read-executor').setSubject('breeze-control-plane')
      .setIssuedAt(issuedAt).setExpirationTime(issuedAt + 3_600).setJti(randomUUID())
      .sign(await importJWK(executor.signingPrivateJwk, 'EdDSA'));
    const response = await fetch(`${executor.origin}/v1/sync-action`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: raw,
    });
    expect(response.status).toBe(401);
  });

  it('returns 500 with no fixture queued rather than inventing a payload', async () => {
    const response = await post({
      correlationId: randomUUID(), tenantId: '44444444-4444-4444-8444-444444444444',
      action: { type: 'm365.sync.ca_policies' },
    });
    expect(response.status).toBe(500);
  });
});
