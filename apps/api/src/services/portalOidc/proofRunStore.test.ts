import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests run the IN-MEMORY backend (PORTAL_USE_REDIS is false under
// NODE_ENV=test). The Redis path and its atomic consume are proved against a
// real Redis in __tests__/integration/portalEntraProofRunStore.integration.test.ts.

import {
  PORTAL_ENTRA_PROOF_RUN_PATH,
  PORTAL_ENTRA_PROOF_RUN_TTL_SECONDS,
  consumePortalEntraProofRunByHash,
  createPortalEntraProofRun,
  peekPortalEntraProofRun,
} from './proofRunStore';
import { portalEntraProofRuns } from '../../routes/portal/helpers';
import { PORTAL_USE_REDIS } from '../../routes/portal/schemas';

const ORG = '7c0a1f7e-1111-4222-8333-444455556666';
const PARTNER = '7c0a1f7e-2222-4222-8333-444455556666';
const USER = '11111111-2222-4333-8444-555566667777';
const TENANT = 'a1a1a1a1-b2b2-4c3c-8d4d-e5e5e5e5e5e5';
const sha256Hex = (raw: string) => createHash('sha256').update(raw).digest('hex');
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function mint(overrides: Partial<{ orgId: string; partnerId: string; createdByUserId: string; expectedTenantId: string }> = {}) {
  return createPortalEntraProofRun({
    orgId: ORG,
    partnerId: PARTNER,
    createdByUserId: USER,
    expectedTenantId: TENANT,
    ...overrides,
  });
}

beforeEach(() => {
  portalEntraProofRuns.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('portal Entra proof-run store (in-memory backend)', () => {
  it('runs the in-memory backend in unit tests', () => {
    expect(PORTAL_USE_REDIS).toBe(false);
  });

  it('the run link lives 72 h and is served at the fixed portal proof path', () => {
    expect(PORTAL_ENTRA_PROOF_RUN_TTL_SECONDS).toBe(72 * 60 * 60);
    expect(PORTAL_ENTRA_PROOF_RUN_PATH).toBe('/api/v1/portal/auth/oidc/entra/proof');
  });

  it('mints a 32-byte base64url token and a run id, and expires 72 h after creation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = new Date('2027-01-23T10:00:00.000Z');
    vi.setSystemTime(now);

    const minted = await mint();
    expect(minted.token).toMatch(BASE64URL_32_BYTES);
    expect(minted.runId).toMatch(UUID);
    expect(minted.expiresAt).toEqual(new Date(now.getTime() + 72 * 3600 * 1000));

    const other = await mint();
    expect(other.token).not.toBe(minted.token);
    expect(other.runId).not.toBe(minted.runId);
  });

  it('stores only sha256(token): the key is the hash and the payload holds no raw token', async () => {
    const minted = await mint();
    expect([...portalEntraProofRuns.keys()]).toEqual([sha256Hex(minted.token)]);

    const entry = portalEntraProofRuns.get(sha256Hex(minted.token))!;
    expect(entry.payload).not.toContain(minted.token);
    const stored = JSON.parse(entry.payload) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(
      ['createdAt', 'createdByUserId', 'expectedTenantId', 'orgId', 'partnerId', 'runId', 'v'],
    );
    expect(stored).toMatchObject({
      v: 1, runId: minted.runId, orgId: ORG, partnerId: PARTNER, createdByUserId: USER, expectedTenantId: TENANT,
    });
    expect(entry.expiresAt.getTime() - entry.createdAt.getTime()).toBe(PORTAL_ENTRA_PROOF_RUN_TTL_SECONDS * 1000);
  });

  it('stores the expected tenant lowercased and refuses a run that is not pinned to a real tenant', async () => {
    const minted = await mint({ expectedTenantId: TENANT.toUpperCase() });
    expect((await peekPortalEntraProofRun(minted.token))?.record.expectedTenantId).toBe(TENANT);

    // D6: a run is ALWAYS pinned. A non-GUID or the consumer (MSA) tenant is a caller bug.
    await expect(mint({ expectedTenantId: '' })).rejects.toThrow();
    await expect(mint({ expectedTenantId: 'contoso.com' })).rejects.toThrow();
    await expect(mint({ expectedTenantId: '9188040d-6c67-4c5b-b112-36a304b66dad' })).rejects.toThrow();
    await expect(mint({ orgId: 'not-a-uuid' })).rejects.toThrow();
    await expect(mint({ createdByUserId: '' })).rejects.toThrow();
    expect(portalEntraProofRuns.size).toBe(1);
  });

  it('peek reads the run without consuming it and returns the hash the consume step uses', async () => {
    const minted = await mint();
    const first = await peekPortalEntraProofRun(minted.token);
    expect(first).toEqual({
      tokenHash: sha256Hex(minted.token),
      record: {
        v: 1,
        runId: minted.runId,
        orgId: ORG,
        partnerId: PARTNER,
        createdByUserId: USER,
        expectedTenantId: TENANT,
        createdAt: expect.any(Number),
      },
    });
    // A failed or abandoned sign-in does not burn the link (D6): peek again.
    expect(await peekPortalEntraProofRun(minted.token)).toEqual(first);
    expect(portalEntraProofRuns.size).toBe(1);
  });

  it('consumes a run by its hash exactly once', async () => {
    const minted = await mint();
    const { tokenHash, record } = (await peekPortalEntraProofRun(minted.token))!;

    expect(await consumePortalEntraProofRunByHash(tokenHash)).toEqual(record);
    expect(await consumePortalEntraProofRunByHash(tokenHash)).toBeNull();
    expect(await peekPortalEntraProofRun(minted.token)).toBeNull();
    expect(portalEntraProofRuns.size).toBe(0);
  });

  it('two consumes racing on one run: exactly one wins', async () => {
    const minted = await mint();
    const hash = sha256Hex(minted.token);
    const results = await Promise.all([
      consumePortalEntraProofRunByHash(hash),
      consumePortalEntraProofRunByHash(hash),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('an unknown, empty or oversized token, and a malformed hash, return null', async () => {
    await mint();
    expect(await peekPortalEntraProofRun('not-a-run')).toBeNull();
    expect(await peekPortalEntraProofRun('')).toBeNull();
    expect(await peekPortalEntraProofRun('x'.repeat(10_000))).toBeNull();
    expect(await consumePortalEntraProofRunByHash('')).toBeNull();
    expect(await consumePortalEntraProofRunByHash('not-a-hash')).toBeNull();
    expect(await consumePortalEntraProofRunByHash(sha256Hex('unknown'))).toBeNull();
    expect(await consumePortalEntraProofRunByHash(sha256Hex('unknown').toUpperCase())).toBeNull();
    expect(portalEntraProofRuns.size).toBe(1);
  });

  it('expires after 72 h', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2027-01-23T10:00:00.000Z');
    const ttlMs = PORTAL_ENTRA_PROOF_RUN_TTL_SECONDS * 1000;

    vi.setSystemTime(start);
    const fresh = await mint();
    vi.setSystemTime(start.getTime() + ttlMs - 1000);
    expect(await peekPortalEntraProofRun(fresh.token)).not.toBeNull();
    expect(await consumePortalEntraProofRunByHash(sha256Hex(fresh.token))).not.toBeNull();

    vi.setSystemTime(start);
    const stale = await mint();
    vi.setSystemTime(start.getTime() + ttlMs);
    expect(await peekPortalEntraProofRun(stale.token)).toBeNull();
    expect(await consumePortalEntraProofRunByHash(sha256Hex(stale.token))).toBeNull();
  });

  it('refuses a stored record of another version or shape (and consume still burns it)', async () => {
    const minted = await mint();
    const key = sha256Hex(minted.token);
    const entry = portalEntraProofRuns.get(key)!;
    const original = JSON.parse(entry.payload) as Record<string, unknown>;

    portalEntraProofRuns.set(key, { ...entry, payload: JSON.stringify({ ...original, v: 2 }) });
    expect(await peekPortalEntraProofRun(minted.token)).toBeNull();

    portalEntraProofRuns.set(key, { ...entry, payload: JSON.stringify({ ...original, expectedTenantId: null }) });
    expect(await peekPortalEntraProofRun(minted.token)).toBeNull();

    portalEntraProofRuns.set(key, { ...entry, payload: JSON.stringify({ ...original, orgId: 'org-1' }) });
    expect(await peekPortalEntraProofRun(minted.token)).toBeNull();

    portalEntraProofRuns.set(key, { ...entry, payload: '{not json' });
    expect(await peekPortalEntraProofRun(minted.token)).toBeNull();
    expect(portalEntraProofRuns.has(key)).toBe(true); // peek never deletes

    expect(await consumePortalEntraProofRunByHash(key)).toBeNull();
    expect(portalEntraProofRuns.has(key)).toBe(false);
  });
});
