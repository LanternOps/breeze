import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  products: [] as Array<{ product: string; category: string; active: boolean; lastSyncStatus: string | null }>,
  saved: [] as Array<{ sourceKey: string | null }>,
}));
vi.mock('../postureEvidence', () => ({
  TRUST_PAGE_EVIDENCE_POLICY: {},
  loadPostureEvidence: vi.fn(async () => ({ report: { productEvidence: state.products } })),
}));
vi.mock('../../db', () => {
  const c: any = {};
  for (const m of ['select', 'from', 'where']) c[m] = vi.fn(() => c);
  c.then = (r: any) => Promise.resolve(state.saved).then(r);
  return { db: c };
});

import { suggestSubprocessors } from './subprocessorSuggestions';

const ORG = '11111111-1111-4111-8111-111111111111';
const asOf = new Date('2026-10-17T00:00:00Z');

describe('suggestSubprocessors', () => {
  beforeEach(() => { state.products = []; state.saved = []; });

  it('maps detected products to a purpose, source and sourceKey', async () => {
    state.products = [
      { product: 'SentinelOne', category: 'edr', active: true, lastSyncStatus: null },
      { product: 'Cisco Umbrella', category: 'dns_filtering', active: true, lastSyncStatus: null },
      { product: 'Backup (Acronis)', category: 'backup', active: true, lastSyncStatus: null },
      { product: 'Microsoft 365', category: 'identity', active: true, lastSyncStatus: null },
    ];
    const out = await suggestSubprocessors(ORG, asOf);
    expect(out).toEqual([
      { name: 'SentinelOne', purpose: 'Endpoint security', location: null, websiteUrl: null, source: 'security_product', sourceKey: 'security_product:sentinelone' },
      { name: 'Cisco Umbrella', purpose: 'DNS filtering', location: null, websiteUrl: null, source: 'security_product', sourceKey: 'security_product:cisco umbrella' },
      { name: 'Backup (Acronis)', purpose: 'Backup', location: null, websiteUrl: null, source: 'backup', sourceKey: 'backup:backup (acronis)' },
      { name: 'Microsoft 365', purpose: 'Microsoft 365 — identity and productivity', location: null, websiteUrl: null, source: 'm365', sourceKey: 'm365:microsoft 365' },
    ]);
  });

  it('never returns a key already saved on the page', async () => {
    state.products = [
      { product: 'SentinelOne', category: 'edr', active: true, lastSyncStatus: null },
      { product: 'Huntress', category: 'mdr', active: true, lastSyncStatus: null },
    ];
    state.saved = [{ sourceKey: 'security_product:sentinelone' }, { sourceKey: null }];
    const out = await suggestSubprocessors(ORG, asOf);
    expect(out.map((s) => s.name)).toEqual(['Huntress']);
  });

  it('dedupes by sourceKey and skips inactive products and non-processor identity (Google)', async () => {
    state.products = [
      { product: 'Huntress', category: 'mdr', active: true, lastSyncStatus: null },
      { product: 'HUNTRESS', category: 'edr', active: true, lastSyncStatus: null },
      { product: 'Old AV', category: 'antivirus', active: false, lastSyncStatus: null },
      { product: 'Google Workspace', category: 'identity', active: true, lastSyncStatus: null },
    ];
    const out = await suggestSubprocessors(ORG, asOf);
    expect(out.map((s) => s.sourceKey)).toEqual(['security_product:huntress']);
  });
});
