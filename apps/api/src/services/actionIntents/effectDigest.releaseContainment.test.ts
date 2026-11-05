import { getTableColumns, getTableName } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db';
import {
  computeEffectDigestForRelease, computeEffectDigestOutcome, effectDigestResolverKey, requiresPinnedEffectDigest,
} from './effectDigest';

/**
 * Network-isolation W13 (#10101, spec §3.8 "Approval binding"): a four-eyes
 * `release_containment` approval is bound to the episode's
 * `(orgId, deviceId, isolationId, generation)` at approval-request time.
 * The release path recomputes it, so an extend (generation N → N+1) or an org
 * move between approval and release is `content_changed`, and the matching
 * recompute hands the handler the binding the service re-checks under the
 * episode lock.
 */
const ORG = '22222222-2222-4222-8222-222222222222';
const MOVED_ORG = '44444444-4444-4444-8444-444444444444';
const DEVICE = '11111111-1111-4111-8111-111111111111';
const OTHER_DEVICE = '55555555-5555-4555-8555-555555555555';
const ISOLATION = '33333333-3333-4333-8333-333333333333';
const args = { deviceId: DEVICE, isolationId: ISOLATION, reason: 'Incident contained' };

type Row = Record<string, unknown>;
let rows: Record<string, Row[]>;
let database: Database;

function episode(extra: Row = {}): Row {
  return {
    id: ISOLATION, orgId: ORG, deviceId: DEVICE, generation: 3, state: 'verified', desiredState: 'isolated',
    expiresAt: new Date('2026-11-05T00:00:00.000Z'), lastJournalSeq: 5, breakGlassSecretEnc: 'enc:never-pinned', ...extra,
  };
}

beforeEach(() => {
  rows = { device_network_isolations: [episode()] };
  const writes = vi.fn(() => { throw new Error('digest must never write'); });
  const select = vi.fn((shape?: Record<string, unknown>) => {
    let table: Parameters<typeof getTableName>[0];
    const chain: Record<string, unknown> = {};
    chain.from = (value: typeof table) => { table = value; return chain; };
    for (const method of ['where', 'limit', 'orderBy']) chain[method] = () => chain;
    chain.then = (resolve: (value: unknown) => unknown) => {
      const columns = getTableColumns(table);
      const result = (rows[getTableName(table)] ?? []).map(row => shape
        ? Object.fromEntries(Object.entries(shape).map(([key, column]) => {
          const sourceKey = Object.keys(columns).find(name => columns[name] === column);
          return [key, sourceKey === undefined ? undefined : row[sourceKey]];
        })) : row);
      return resolve(result);
    };
    return chain;
  });
  database = { select, update: writes, insert: writes, delete: writes } as unknown as Database;
});

async function pinned(input: Record<string, unknown> = args): Promise<string> {
  const outcome = await computeEffectDigestOutcome('release_containment', input, database);
  if (outcome.kind !== 'pinned') throw new Error(`expected a pinned digest, got ${JSON.stringify(outcome)}`);
  return outcome.digest;
}

describe('release_containment effect digest (W13 #10101)', () => {
  it('has a whole-tool resolver and a mandatory pin', () => {
    expect(effectDigestResolverKey('release_containment')).toBe('release_containment');
    expect(requiresPinnedEffectDigest('release_containment', args)).toBe(true);
  });

  it('pins the same digest for the same episode generation', async () => {
    expect(await pinned()).toMatch(/^[0-9a-f]{64}$/);
    expect(await pinned()).toBe(await pinned());
  });

  it('an approval for generation N does not match generation N+1 (an extend)', async () => {
    const approvedAt = await pinned();
    rows.device_network_isolations = [episode({ generation: 4 })];
    expect(await pinned()).not.toBe(approvedAt);
  });

  it('an approval issued before an org move does not match after it', async () => {
    const approvedAt = await pinned();
    rows.device_network_isolations = [episode({ orgId: MOVED_ORG })];
    expect(await pinned()).not.toBe(approvedAt);
  });

  it('agent progress at the same generation keeps the approval valid', async () => {
    // Only the binding is pinned: state, expiry, journal and the secret are not.
    const approvedAt = await pinned();
    rows.device_network_isolations = [episode({
      state: 'applied', expiresAt: new Date('2026-11-06T00:00:00.000Z'), lastJournalSeq: 9, breakGlassSecretEnc: '',
    })];
    expect(await pinned()).toBe(approvedAt);
  });

  it('the reason is not part of the effect (the argument digest already pins it)', async () => {
    expect(await pinned({ ...args, reason: 'Another reason' })).toBe(await pinned());
  });

  it.each([
    ['no isolationId', { deviceId: DEVICE, reason: 'r' }],
    ['no deviceId', { isolationId: ISOLATION, reason: 'r' }],
    ['a non-string isolationId', { ...args, isolationId: 42 }],
  ])('is unresolved (missing_arg) with %s', async (_label, input) => {
    expect(await computeEffectDigestOutcome('release_containment', input, database))
      .toEqual({ kind: 'unresolved', reason: 'missing_arg' });
  });

  it('is unresolved (target_absent) for an unknown episode', async () => {
    rows.device_network_isolations = [];
    expect(await computeEffectDigestOutcome('release_containment', args, database))
      .toEqual({ kind: 'unresolved', reason: 'target_absent' });
  });

  it('is unresolved (target_absent) for an episode on another device', async () => {
    rows.device_network_isolations = [episode({ deviceId: OTHER_DEVICE })];
    expect(await computeEffectDigestOutcome('release_containment', args, database))
      .toEqual({ kind: 'unresolved', reason: 'target_absent' });
  });

  it('is unresolved (target_absent) for a malformed isolation id, without querying', async () => {
    expect(await computeEffectDigestOutcome('release_containment', { ...args, isolationId: 'not-a-uuid' }, database))
      .toEqual({ kind: 'unresolved', reason: 'target_absent' });
  });

  it('hands the release path the verified binding alongside the same digest', async () => {
    const approvedAt = await pinned();
    const release = await computeEffectDigestForRelease('release_containment', args, database);
    expect(release.digest).toBe(approvedAt);
    expect(release.context).toEqual({
      verifiedIsolationRelease: { orgId: ORG, deviceId: DEVICE, isolationId: ISOLATION, generation: 3 },
    });
  });

  it('the release-time binding tracks the CURRENT row, so a drifted row also mismatches the stored digest', async () => {
    const approvedAt = await pinned();
    rows.device_network_isolations = [episode({ generation: 4 })];
    const release = await computeEffectDigestForRelease('release_containment', args, database);
    expect(release.digest).not.toBe(approvedAt);
    expect(release.context?.verifiedIsolationRelease?.generation).toBe(4);
  });
});
