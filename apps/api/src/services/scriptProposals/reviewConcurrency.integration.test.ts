/**
 * Real-Redis integration coverage for the per-org script-review concurrency
 * slot (`reviewConcurrency.ts`, #5612 W03 / follow-up #5637).
 *
 * The unit suite (`reviewConcurrency.test.ts`) mocks `redis.eval` wholesale, so
 * the two Lua scripts (ACQUIRE / RELEASE) never actually execute there. This
 * file runs them against a real Redis: acquire up to the cap, refusal at
 * cap+1, release frees a slot, a crashed holder's slot self-heals via the
 * safety TTL, and release is idempotent (never drives the counter negative).
 * No mocks on `reviewConcurrency.ts` or `../redis`.
 *
 * The shared integration `setup.ts` flushes Redis before every test.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/services/scriptProposals/reviewConcurrency.integration.test.ts
 */
import '../../__tests__/integration/setup';

import { randomUUID } from 'crypto';
import { afterAll, describe, expect, it } from 'vitest';

import { closeRedis, getRedis } from '../redis';
import {
  releaseOrgReviewSlot,
  SCRIPT_REVIEW_ORG_CONCURRENCY,
  tryAcquireOrgReviewSlot,
} from './reviewConcurrency';

const keyFor = (orgId: string) => `script-review:concurrency:${orgId}`;

function redis() {
  const r = getRedis();
  if (!r) throw new Error('real Redis client unavailable — is `pnpm test-stack up` running?');
  return r;
}

describe('script-review per-org concurrency slot (real Redis)', () => {
  // getRedis() is a process singleton; close it so the worker can exit.
  afterAll(async () => {
    await closeRedis();
  });

  it('grants exactly `cap` slots and refuses cap+1', async () => {
    const orgId = randomUUID();
    for (let i = 0; i < SCRIPT_REVIEW_ORG_CONCURRENCY; i++) {
      expect(await tryAcquireOrgReviewSlot(orgId)).toBe(true);
    }
    expect(await tryAcquireOrgReviewSlot(orgId)).toBe(false);
    // A refused acquire must not bump the counter.
    expect(await redis().get(keyFor(orgId))).toBe(String(SCRIPT_REVIEW_ORG_CONCURRENCY));
  });

  it('honours an explicit cap argument', async () => {
    const orgId = randomUUID();
    expect(await tryAcquireOrgReviewSlot(orgId, 1)).toBe(true);
    expect(await tryAcquireOrgReviewSlot(orgId, 1)).toBe(false);
  });

  it('is per-org: one org at cap does not block another', async () => {
    const a = randomUUID();
    const b = randomUUID();
    for (let i = 0; i < SCRIPT_REVIEW_ORG_CONCURRENCY; i++) await tryAcquireOrgReviewSlot(a);
    expect(await tryAcquireOrgReviewSlot(a)).toBe(false);
    expect(await tryAcquireOrgReviewSlot(b)).toBe(true);
  });

  it('is atomic under concurrent acquires (no over-grant)', async () => {
    const orgId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: SCRIPT_REVIEW_ORG_CONCURRENCY * 3 }, () => tryAcquireOrgReviewSlot(orgId)),
    );
    expect(results.filter(Boolean)).toHaveLength(SCRIPT_REVIEW_ORG_CONCURRENCY);
  });

  it('release frees a slot that can then be re-acquired', async () => {
    const orgId = randomUUID();
    for (let i = 0; i < SCRIPT_REVIEW_ORG_CONCURRENCY; i++) await tryAcquireOrgReviewSlot(orgId);
    expect(await tryAcquireOrgReviewSlot(orgId)).toBe(false);

    await releaseOrgReviewSlot(orgId);
    expect(await redis().get(keyFor(orgId))).toBe(String(SCRIPT_REVIEW_ORG_CONCURRENCY - 1));
    expect(await tryAcquireOrgReviewSlot(orgId)).toBe(true);
    expect(await tryAcquireOrgReviewSlot(orgId)).toBe(false);
  });

  it('sets a bounded safety TTL on acquire', async () => {
    const orgId = randomUUID();
    await tryAcquireOrgReviewSlot(orgId);
    const ttl = await redis().ttl(keyFor(orgId));
    expect(ttl).toBeGreaterThan(60); // above SCRIPT_REVIEW_TIMEOUT_MS (60 s)
    expect(ttl).toBeLessThanOrEqual(90);
  });

  it('a slot whose holder died self-heals when the safety TTL expires', async () => {
    const orgId = randomUUID();
    for (let i = 0; i < SCRIPT_REVIEW_ORG_CONCURRENCY; i++) await tryAcquireOrgReviewSlot(orgId);
    expect(await tryAcquireOrgReviewSlot(orgId)).toBe(false); // wedged: holders never release

    // Fast-forward the 90 s safety TTL to 1 s instead of sleeping 90 s.
    expect(await redis().expire(keyFor(orgId), 1)).toBe(1);
    await new Promise((r) => setTimeout(r, 1500));

    expect(await redis().exists(keyFor(orgId))).toBe(0);
    expect(await tryAcquireOrgReviewSlot(orgId)).toBe(true);
  });

  it('release is idempotent: extra releases never push the counter below zero', async () => {
    const orgId = randomUUID();
    await tryAcquireOrgReviewSlot(orgId);
    await releaseOrgReviewSlot(orgId);
    await releaseOrgReviewSlot(orgId); // double release
    await releaseOrgReviewSlot(orgId);

    const raw = await redis().get(keyFor(orgId));
    expect(Number(raw ?? '0')).toBe(0);

    // No manufactured capacity: still exactly `cap` slots, not cap+extra.
    const results = await Promise.all(
      Array.from({ length: SCRIPT_REVIEW_ORG_CONCURRENCY + 2 }, () => tryAcquireOrgReviewSlot(orgId)),
    );
    expect(results.filter(Boolean)).toHaveLength(SCRIPT_REVIEW_ORG_CONCURRENCY);
  });

  it('release without any prior acquire is a harmless no-op', async () => {
    const orgId = randomUUID();
    await releaseOrgReviewSlot(orgId);
    expect(await redis().get(keyFor(orgId))).toBeNull();
  });
});
