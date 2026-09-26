import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, { value: string; ttlMs: number }>());
const redis = vi.hoisted(() => ({
  get: vi.fn(async (key: string) => store.get(key)?.value ?? null),
  set: vi.fn(async (key: string, value: string, _px: string, ttlMs: number) => { store.set(key, { value, ttlMs }); return 'OK'; }),
  del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
}));
const mocks = vi.hoisted(() => ({ getRedis: vi.fn() }));
vi.mock('../redis', () => ({ getRedis: mocks.getRedis }));

import { deleteCachedTopologyExplanation, getCachedTopologyExplanation, setCachedTopologyExplanation, topologyAiCacheKey, type TopologyAiCacheKeyParts } from './aiCache';

const ORG = '10000000-0000-4000-8000-000000000001';
const SITE = '20000000-0000-4000-8000-000000000001';
const ctx = { auth: { user: { id: 'u1' } }, permissions: {}, scope: { orgId: ORG, siteId: SITE } } as never;
const NOW = new Date('2026-09-26T12:00:00.000Z');
const parts: TopologyAiCacheKeyParts = {
  userId: 'u1', effectiveSites: 'all', permissionVersion: '4', revisions: { graph: '7', health: '3' }, scopeStampHash: 'abc',
  selection: { siteId: SITE, subject: { kind: 'node', id: SITE }, view: 'physical', graphRevision: '7' }, question: 'why is the uplink down? 10.0.0.5',
  promptVersion: 'p1', schemaVersion: 1, providerRevision: 'platform',
};
const answer = { schemaVersion: 1 as const, status: 'complete' as const, findings: [], missingData: [], nextChecks: [], citationIds: [], citations: [], reasons: [] };

beforeEach(() => { store.clear(); vi.clearAllMocks(); mocks.getRedis.mockReturnValue(redis); });

describe('topology AI answer cache (M4 Task 3)', () => {
  it('is tenant-scoped and never carries question text or addresses in the key', () => {
    const key = topologyAiCacheKey(ctx, parts);
    expect(key.startsWith(`topology-ai:{${ORG}}:answer:`)).toBe(true);
    expect(key).not.toContain('uplink');
    expect(key).not.toContain('10.0.0.5');
  });

  it('changes the key for any input that changes authority or meaning', () => {
    const base = topologyAiCacheKey(ctx, parts);
    for (const changed of [{ userId: 'u2' }, { permissionVersion: '5' }, { effectiveSites: 'b' }, { revisions: { graph: '8', health: '3' } }, { revisions: { graph: '7', health: '4' } },
      { scopeStampHash: 'def' }, { question: 'other' }, { promptVersion: 'p2' }, { providerRevision: 'partner:9' },
      { selection: { ...parts.selection, view: 'logical' as const } }]) {
      expect(topologyAiCacheKey(ctx, { ...parts, ...changed }), JSON.stringify(changed)).not.toBe(base);
    }
  });

  it('stores for at most five minutes and never beyond evidence freshness', async () => {
    await setCachedTopologyExplanation(ctx, parts, answer, new Date(NOW.getTime() + 60 * 60_000), NOW);
    expect([...store.values()][0]!.ttlMs).toBe(300_000);
    store.clear();
    await setCachedTopologyExplanation(ctx, parts, answer, new Date(NOW.getTime() + 90_000), NOW);
    expect([...store.values()][0]!.ttlMs).toBe(90_000);
    store.clear();
    await setCachedTopologyExplanation(ctx, parts, answer, new Date(NOW.getTime() - 1), NOW);
    expect(store.size).toBe(0);
  });

  it('returns only a schema-valid answer, and treats a corrupt or foreign entry as a miss', async () => {
    await setCachedTopologyExplanation(ctx, parts, answer, new Date(NOW.getTime() + 60_000), NOW);
    expect(await getCachedTopologyExplanation(ctx, parts)).toEqual(answer);
    store.set(topologyAiCacheKey(ctx, parts), { value: JSON.stringify({ explanation: { ...answer, prose: 'raw' } }), ttlMs: 1 });
    expect(await getCachedTopologyExplanation(ctx, parts)).toBeNull();
    store.set(topologyAiCacheKey(ctx, parts), { value: 'not json', ttlMs: 1 });
    expect(await getCachedTopologyExplanation(ctx, parts)).toBeNull();
  });

  it('degrades to a miss (never an error) when Redis is unavailable, and deletes one entry on invalidation', async () => {
    await setCachedTopologyExplanation(ctx, parts, answer, new Date(NOW.getTime() + 60_000), NOW);
    await deleteCachedTopologyExplanation(ctx, parts);
    expect(await getCachedTopologyExplanation(ctx, parts)).toBeNull();
    mocks.getRedis.mockReturnValue(null);
    expect(await getCachedTopologyExplanation(ctx, parts)).toBeNull();
    await expect(setCachedTopologyExplanation(ctx, parts, answer, new Date(NOW.getTime() + 60_000), NOW)).resolves.toBeUndefined();
  });
});
