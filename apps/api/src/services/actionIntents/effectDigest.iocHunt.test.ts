/**
 * #6268: effect-digest pins for ioc_hunt's two Tier-3 actions. Both are
 * mandatory (PINNED_EFFECT_DIGEST_REQUIRED): an unresolved pin refuses intent
 * creation and a release with no pinned digest fails closed.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db';
import { computeEffectDigestOutcome, effectDigestResolverKey, requiresPinnedEffectDigest } from './effectDigest';

/** Every select chain resolves to the next queued rows (see effectDigest.test.ts). */
function makeFakeDb(queue: unknown[][]): { database: Database; select: ReturnType<typeof vi.fn> } {
  const take = async () => queue.shift() ?? [];
  const chain = {
    limit: vi.fn(take),
    orderBy: vi.fn(take),
    then: (resolve: (rows: unknown[]) => unknown, reject: (err: unknown) => unknown) => take().then(resolve, reject),
  };
  const select = vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => chain) })) }));
  return { database: { select } as unknown as Database, select };
}

const ORG = '11111111-1111-4111-8111-111111111111';
const SET_A = '22222222-2222-4222-8222-222222222222';
const SET_B = '33333333-3333-4333-8333-333333333333';
const DIGEST = 'd'.repeat(64);
const setRow = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, enabled: true, publishedVersion: 3, publishedSha256: 'a'.repeat(64), currentVersion: 3, ...overrides,
});
const sweepArgs = (extra: Record<string, unknown> = {}) => ({
  action: 'sweep', orgId: ORG, ruleSetIds: [SET_A, SET_B], scope: { kind: 'all' }, scanType: 'quick',
  expectedDeviceCount: 4, previewDigest: DIGEST, ...extra,
});

async function digest(args: Record<string, unknown>, rows: unknown[][]): Promise<string> {
  const outcome = await computeEffectDigestOutcome('ioc_hunt', args, makeFakeDb(rows).database);
  if (outcome.kind !== 'pinned') throw new Error(`not pinned: ${JSON.stringify(outcome)}`);
  return outcome.digest;
}

describe('ioc_hunt effect digests (#6268)', () => {
  it('are mandatory and keyed per Tier-3 action only', () => {
    expect(requiresPinnedEffectDigest('ioc_hunt')).toBe(true);
    expect(effectDigestResolverKey('ioc_hunt', 'sweep')).toBe('ioc_hunt:sweep');
    expect(effectDigestResolverKey('ioc_hunt', 'import_iocs')).toBe('ioc_hunt:import_iocs');
    expect(effectDigestResolverKey('ioc_hunt', 'preview_sweep')).toBeNull();
  });

  describe('sweep', () => {
    it('pins orgId + previewDigest + the sets {id, version, sha256}, independent of id order', async () => {
      const base = await digest(sweepArgs(), [[setRow(SET_A), setRow(SET_B)]]);
      expect(base).toMatch(/^[0-9a-f]{64}$/);
      expect(await digest(sweepArgs({ ruleSetIds: [SET_B, SET_A] }), [[setRow(SET_B), setRow(SET_A)]])).toBe(base);
      // A republished set (new version + sha) is different material.
      expect(await digest(sweepArgs(), [[setRow(SET_A, { publishedVersion: 4, publishedSha256: 'b'.repeat(64) }), setRow(SET_B)]])).not.toBe(base);
      // A different preview (targets changed) or org is different material.
      expect(await digest(sweepArgs({ previewDigest: 'e'.repeat(64) }), [[setRow(SET_A), setRow(SET_B)]])).not.toBe(base);
      expect(await digest(sweepArgs({ orgId: SET_B }), [[setRow(SET_A), setRow(SET_B)]])).not.toBe(base);
    });

    it('missing or malformed orgId / previewDigest / ruleSetIds → missing_arg, no read', async () => {
      for (const bad of [{ orgId: undefined }, { orgId: 'nope' }, { previewDigest: undefined }, { previewDigest: 'xyz' }, { ruleSetIds: [] }, { ruleSetIds: ['nope'] }, { ruleSetIds: 'x' }]) {
        const { database, select } = makeFakeDb([]);
        expect(await computeEffectDigestOutcome('ioc_hunt', sweepArgs(bad), database)).toEqual({ kind: 'unresolved', reason: 'missing_arg' });
        expect(select).not.toHaveBeenCalled();
      }
    });

    it('a missing, disabled or unpublished set → target_absent', async () => {
      for (const rows of [[setRow(SET_A)], [setRow(SET_A), setRow(SET_B, { enabled: false })], [setRow(SET_A), setRow(SET_B, { publishedVersion: null, publishedSha256: null })]]) {
        expect(await computeEffectDigestOutcome('ioc_hunt', sweepArgs(), makeFakeDb([rows]).database))
          .toEqual({ kind: 'unresolved', reason: 'target_absent' });
      }
    });
  });

  describe('import_iocs', () => {
    const importArgs = (extra: Record<string, unknown> = {}) => ({
      action: 'import_iocs', ruleSetId: SET_A, label: 'Advisory 7',
      iocs: [{ kind: 'md5', value: 'f'.repeat(32) }, { kind: 'domain', value: 'bad.example' }], ...extra,
    });

    it('pins ruleSetId + the set versions + an IOC digest independent of order', async () => {
      const base = await digest(importArgs(), [[setRow(SET_A)]]);
      expect(await digest(importArgs({ iocs: [{ kind: 'domain', value: 'bad.example' }, { kind: 'md5', value: 'f'.repeat(32) }] }), [[setRow(SET_A)]])).toBe(base);
      // The set was edited (draft version bumped) or republished after approval.
      expect(await digest(importArgs(), [[setRow(SET_A, { currentVersion: 4 })]])).not.toBe(base);
      expect(await digest(importArgs(), [[setRow(SET_A, { publishedVersion: 4 })]])).not.toBe(base);
      expect(await digest(importArgs({ iocs: [{ kind: 'md5', value: 'e'.repeat(32) }] }), [[setRow(SET_A)]])).not.toBe(base);
      // A never-published set pins version 0.
      expect(await digest(importArgs(), [[setRow(SET_A, { publishedVersion: null, publishedSha256: null })]])).toMatch(/^[0-9a-f]{64}$/);
    });

    it('missing ruleSetId / iocs → missing_arg; unknown set → target_absent', async () => {
      expect(await computeEffectDigestOutcome('ioc_hunt', importArgs({ ruleSetId: undefined }), makeFakeDb([]).database))
        .toEqual({ kind: 'unresolved', reason: 'missing_arg' });
      expect(await computeEffectDigestOutcome('ioc_hunt', importArgs({ iocs: [] }), makeFakeDb([]).database))
        .toEqual({ kind: 'unresolved', reason: 'missing_arg' });
      // Malformed elements are refused, never coerced into the pin.
      for (const bad of [[null], [{ kind: 'md5' }], [{ kind: 'md5', value: 5 }], ['md5:abc']]) {
        expect(await computeEffectDigestOutcome('ioc_hunt', importArgs({ iocs: bad }), makeFakeDb([]).database))
          .toEqual({ kind: 'unresolved', reason: 'missing_arg' });
      }
      expect(await computeEffectDigestOutcome('ioc_hunt', importArgs(), makeFakeDb([[]]).database))
        .toEqual({ kind: 'unresolved', reason: 'target_absent' });
    });
  });
});
