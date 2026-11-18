/**
 * Portal registration W4 (#11381, plan D6 / Task 8): an Entra tenant proof-run
 * link is consumed ATOMICALLY on real Redis (Review Focus 3 — two concurrent
 * proof callbacks for one link record one proof). The Lua GET+DEL
 * (`luaGetDel`, shared with the capability tokens and the OIDC state) runs as
 * one server-side step; the peek that starts the sign-in never consumes.
 *
 * Runs the production backend: PORTAL_USE_REDIS is read at module load, so
 * PORTAL_STATE_BACKEND is set before any portal module is imported.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/portalEntraProofRunStore.integration.test.ts
 */
import './setup';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.PORTAL_STATE_BACKEND = 'redis';
});

import { createHash, randomUUID } from 'node:crypto';
import {
  PORTAL_ENTRA_PROOF_RUN_TTL_SECONDS,
  consumePortalEntraProofRunByHash,
  createPortalEntraProofRun,
  peekPortalEntraProofRun,
} from '../../services/portalOidc/proofRunStore';
import { PORTAL_REDIS_KEYS, PORTAL_USE_REDIS } from '../../routes/portal/schemas';
import { closeRedis, getRedis } from '../../services/redis';

const RUN = !!process.env.REDIS_URL;
const sha256Hex = (raw: string) => createHash('sha256').update(raw).digest('hex');

function mint() {
  return createPortalEntraProofRun({
    orgId: randomUUID(),
    partnerId: randomUUID(),
    createdByUserId: randomUUID(),
    expectedTenantId: randomUUID(),
  });
}

describe.skipIf(!RUN)('portal Entra proof-run links against real Redis', () => {
  afterAll(async () => { await closeRedis(); });

  it('runs the Redis backend', () => {
    expect(PORTAL_USE_REDIS).toBe(true);
  });

  it('stores the run under sha256(token) with the 72 h TTL and never the raw token', async () => {
    const minted = await mint();
    const key = PORTAL_REDIS_KEYS.entraProofRun(sha256Hex(minted.token));
    const ttl = await getRedis()!.ttl(key);
    expect(ttl).toBeGreaterThan(PORTAL_ENTRA_PROOF_RUN_TTL_SECONDS - 10);
    expect(ttl).toBeLessThanOrEqual(PORTAL_ENTRA_PROOF_RUN_TTL_SECONDS);
    const stored = (await getRedis()!.get(key))!;
    expect(stored).not.toContain(minted.token);
    expect(JSON.parse(stored)).toMatchObject({ v: 1, runId: minted.runId });
  });

  it('peek reads without consuming; consume by hash then removes the key', async () => {
    const minted = await mint();
    const key = PORTAL_REDIS_KEYS.entraProofRun(sha256Hex(minted.token));

    const peeked = await peekPortalEntraProofRun(minted.token);
    expect(peeked).toMatchObject({ tokenHash: sha256Hex(minted.token), record: { runId: minted.runId } });
    expect(await peekPortalEntraProofRun(minted.token)).toEqual(peeked);
    expect(await getRedis()!.exists(key)).toBe(1);

    expect(await consumePortalEntraProofRunByHash(peeked!.tokenHash)).toEqual(peeked!.record);
    expect(await getRedis()!.exists(key)).toBe(0);
    expect(await peekPortalEntraProofRun(minted.token)).toBeNull();
    expect(await consumePortalEntraProofRunByHash(peeked!.tokenHash)).toBeNull();
  });

  it('two concurrent consumes on real Redis: exactly one wins', async () => {
    const minted = await mint();
    const hash = sha256Hex(minted.token);
    const results = await Promise.all([
      consumePortalEntraProofRunByHash(hash),
      consumePortalEntraProofRunByHash(hash),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(results.find((r) => r !== null)).toMatchObject({ runId: minted.runId });
    expect(await getRedis()!.exists(PORTAL_REDIS_KEYS.entraProofRun(hash))).toBe(0);
  });

  it('many concurrent consumes still yield exactly one run', async () => {
    const minted = await mint();
    const hash = sha256Hex(minted.token);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => consumePortalEntraProofRunByHash(hash)),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });
});
