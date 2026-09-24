import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ queue: [] as unknown[][] }));

vi.mock('./automationReferenceAuthorization', () => ({
  AutomationReferenceAuthorizationError: class AutomationReferenceAuthorizationError extends Error {
    readonly code = 'unknown_or_unauthorized_reference';
    constructor() {
      super('Unknown or unauthorized automation reference');
    }
  },
  resolveOwnedAutomationReferences: vi.fn(),
}));

vi.mock('./automationRuntime', () => ({
  normalizeAutomationActions: vi.fn((actions: unknown) => actions),
  resolveAutomationReferencesForOwner: vi.fn(),
}));

vi.mock('../db', () => {
  const next = () => state.queue.shift() ?? [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit', 'innerJoin', 'leftJoin']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(next()).then(resolve);
  return { db: chain, withDbAccessContext: (_c: unknown, fn: () => unknown) => fn() };
});

import { listFeatureLinks } from './configurationPolicy';

describe('monitors link inheritance round-trip (W05c1)', () => {
  beforeEach(() => { state.queue = []; });

  it('returns inheritance from the link JSON when attachments exist', async () => {
    state.queue = [
      [{ id: 'link-1', configPolicyId: 'p1', featureType: 'monitors', featurePolicyId: null, inlineSettings: { items: [], inheritance: 'replace' } }],
      [{ id: 'row-1', featureLinkId: 'link-1', monitorId: 'm1', enabled: true, overrides: null, sortOrder: 0 }],
      [{ inlineSettings: { items: [], inheritance: 'replace' } }],
    ];
    const [link] = await listFeatureLinks('p1');
    expect(link!.inlineSettings).toEqual({ items: [{ monitorId: 'm1', enabled: true, overrides: null, sortOrder: 0 }], inheritance: 'replace' });
  });

  it('defaults to cumulative for a link saved before W05c1', async () => {
    state.queue = [
      [{ id: 'link-1', configPolicyId: 'p1', featureType: 'monitors', featurePolicyId: null, inlineSettings: { items: [] } }],
      [{ id: 'row-1', featureLinkId: 'link-1', monitorId: 'm1', enabled: true, overrides: null, sortOrder: 0 }],
      [{ inlineSettings: { items: [] } }],
    ];
    const [link] = await listFeatureLinks('p1');
    expect((link!.inlineSettings as { inheritance: string }).inheritance).toBe('cumulative');
  });
});
