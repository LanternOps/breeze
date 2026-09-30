import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  importSite: vi.fn(),
  capture: vi.fn(),
  globallyDisabled: vi.fn(() => false),
  contexts: [] as number[],
  nextContext: 0,
  flagsSeenByImport: [] as unknown[],
}));

vi.mock('../db', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const context = new AsyncLocalStorage<number>();
  return {
    db: { execute: (...args: unknown[]) => { mocks.contexts.push(context.getStore() ?? -1); return mocks.execute(...args); } },
    withSystemDbAccessContext: (fn: () => Promise<unknown>) => context.run(++mocks.nextContext, fn),
    runOutsideDbContext: (fn: () => unknown) => context.exit(fn),
    getCurrentDbAccessContext: () => undefined,
  };
});
vi.mock('../config/env', () => ({ topologyGloballyDisabled: mocks.globallyDisabled }));
vi.mock('../services/sentry', () => ({ captureException: mocks.capture }));
vi.mock('../services/topology/legacyImport', () => ({ importLegacyTopologySite: mocks.importSite }));

import { loadTopologyFlags } from '../services/topology/flags';
import { TopologyCaptureIncompleteError } from '../services/topology/legacyImportState';
import {
  TOPOLOGY_BOOTSTRAP_PASS_BUDGET_MS,
  TOPOLOGY_BOOTSTRAP_SITE_BATCH,
  resetTopologyBootstrapStateForTests,
  runTopologyBootstrapPass,
} from './topologyBootstrapPass';

const ORG = '00000000-0000-4000-8000-000000000001';
const on = { topologyFeatureFlags: { materialization: true } };
const candidate = (n: number, overrides: Record<string, unknown> = {}) => ({
  org_id: ORG,
  site_id: `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`,
  org_settings: on,
  partner_settings: {},
  ...overrides,
});
const sqlText = (call: unknown[]) => {
  const query = call[0] as { queryChunks?: unknown[] };
  return JSON.stringify(query?.queryChunks ?? query);
};

beforeEach(() => {
  vi.clearAllMocks();
  resetTopologyBootstrapStateForTests();
  mocks.contexts.length = 0; mocks.nextContext = 0; mocks.flagsSeenByImport.length = 0;
  mocks.globallyDisabled.mockReturnValue(false);
  mocks.execute.mockResolvedValue([]);
  mocks.importSite.mockImplementation(async (scope: { orgId: string; siteId: string }) => {
    // The import must see the pre-resolved flags without a nested read.
    mocks.flagsSeenByImport.push(await loadTopologyFlags({ scope }));
    return { complete: true };
  });
});

describe('topology first-snapshot bootstrap pass (#7557)', () => {
  it('does nothing (not even a candidate query) while topology is globally disabled', async () => {
    mocks.globallyDisabled.mockReturnValue(true);
    await runTopologyBootstrapPass();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.importSite).not.toHaveBeenCalled();
  });

  it('selects candidates in one bounded, set-based query that resolves flags and skips checkpointed/backed-off sites', async () => {
    await runTopologyBootstrapPass();
    expect(mocks.execute).toHaveBeenCalledOnce();
    const text = sqlText(mocks.execute.mock.calls[0]!);
    expect(text).toContain('topologyFeatureFlags');
    expect(text).toContain('legacyImport');
    expect(text).toContain('legacyImportBootstrap');
    expect(text).toContain('LIMIT');
    expect(mocks.execute.mock.calls[0]![0]).toBeDefined();
    expect(mocks.importSite).not.toHaveBeenCalled();
  });

  it('imports an enabled, never-imported site in its own system transaction with pre-resolved flags', async () => {
    mocks.execute.mockResolvedValueOnce([candidate(1)]);
    await runTopologyBootstrapPass();
    expect(mocks.importSite).toHaveBeenCalledOnce();
    expect(mocks.importSite.mock.calls[0]![0]).toEqual({ orgId: ORG, siteId: candidate(1).site_id });
    expect(mocks.flagsSeenByImport[0]).toMatchObject({ materialization: true });
    // candidate query + import each got a DIFFERENT system transaction
    expect(mocks.contexts.every(id => id > 0)).toBe(true);
    expect(mocks.nextContext).toBe(2);
  });

  it('re-resolves flags in TS and never imports a row whose flags are off (SQL/TS drift guard)', async () => {
    mocks.execute.mockResolvedValueOnce([
      candidate(1, { org_settings: { topologyFeatureFlags: { materialization: false } }, partner_settings: on }),
      candidate(2, { org_settings: {}, partner_settings: { topologyFeatureFlags: 'yes' } }),
    ]);
    await runTopologyBootstrapPass();
    expect(mocks.importSite).not.toHaveBeenCalled();
  });

  it('honors a partner-level enable when the org does not override it', async () => {
    mocks.execute.mockResolvedValueOnce([candidate(1, { org_settings: {}, partner_settings: on })]);
    await runTopologyBootstrapPass();
    expect(mocks.importSite).toHaveBeenCalledOnce();
  });

  it('treats incomplete capture as not-yet-eligible: no throw, no failure marker, global back-off, rate-limited alert', async () => {
    mocks.execute.mockResolvedValueOnce([candidate(1), candidate(2)]);
    mocks.importSite.mockRejectedValue(new TopologyCaptureIncompleteError(['topology_layout']));
    await expect(runTopologyBootstrapPass()).resolves.toBeUndefined();
    // capture is global: one probe, not one per site
    expect(mocks.importSite).toHaveBeenCalledOnce();
    expect(mocks.execute).toHaveBeenCalledOnce(); // no failure marker written
    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(mocks.capture.mock.calls[0]![2]).toMatchObject({ missing: 'topology_layout' });
    // back-off: the next pass does not even query
    await runTopologyBootstrapPass();
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.capture).toHaveBeenCalledOnce();
  });

  it('records a durable per-site failure marker and keeps going with the other sites', async () => {
    mocks.execute.mockResolvedValueOnce([candidate(1), candidate(2)]).mockResolvedValue([]);
    mocks.importSite.mockRejectedValueOnce(new Error('malformed legacy row'));
    await runTopologyBootstrapPass();
    expect(mocks.importSite).toHaveBeenCalledTimes(2);
    expect(mocks.execute).toHaveBeenCalledTimes(2); // candidates + one marker upsert
    const marker = sqlText(mocks.execute.mock.calls[1]!);
    expect(marker).toContain('legacyImportBootstrap');
    expect(marker).toContain('ON CONFLICT');
    expect(mocks.capture).toHaveBeenCalledOnce();
  });

  it.each(['40P01', '40001', '55P03'])('retries %s as a whole fresh transaction, never marking the site failed', async code => {
    mocks.execute.mockResolvedValueOnce([candidate(1)]);
    mocks.importSite.mockRejectedValueOnce({ cause: { code } });
    await runTopologyBootstrapPass();
    expect(mocks.importSite).toHaveBeenCalledTimes(2);
    expect(mocks.nextContext).toBe(3); // candidates + two separate import transactions
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it('defers a persistently contended site: unmarked, excluded from the next candidate query, one alert', async () => {
    mocks.execute.mockResolvedValueOnce([candidate(1)]);
    mocks.importSite.mockRejectedValue({ cause: { code: '40P01' } });
    await runTopologyBootstrapPass();
    expect(mocks.importSite).toHaveBeenCalledTimes(3);
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.capture).toHaveBeenCalledOnce();
    await runTopologyBootstrapPass();
    expect(sqlText(mocks.execute.mock.calls[1]!)).toContain(candidate(1).site_id);
    expect(sqlText(mocks.execute.mock.calls[0]!)).not.toContain(candidate(1).site_id);
  });

  it.each(['57014', '08006', '53300', '57P01', 'ECONNRESET', 'CONNECTION_CLOSED'])(
    'never marks a site failed for database/driver fault %s; defers it with rate-limited alerts',
    async code => {
      mocks.execute.mockResolvedValueOnce([candidate(1), candidate(2)]).mockResolvedValue([]);
      mocks.importSite.mockRejectedValue({ code });
      await runTopologyBootstrapPass();
      expect(mocks.importSite).toHaveBeenCalledTimes(2); // no in-transaction retry
      expect(mocks.execute).toHaveBeenCalledOnce(); // no failure marker
      expect(mocks.capture).toHaveBeenCalledOnce(); // two deferrals, one alert
    },
  );

  it('defers (does not re-alert every pass) when the failure marker itself cannot be written', async () => {
    mocks.execute.mockResolvedValueOnce([candidate(1)]).mockRejectedValueOnce(new Error('marker write failed')).mockResolvedValue([]);
    mocks.importSite.mockRejectedValueOnce(new Error('malformed legacy row'));
    await runTopologyBootstrapPass();
    expect(mocks.capture).toHaveBeenCalledOnce();
    await runTopologyBootstrapPass();
    expect(sqlText(mocks.execute.mock.calls[2]!)).toContain(candidate(1).site_id);
  });

  it('stops starting new imports once the pass time budget is spent', async () => {
    let now = 1_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      mocks.execute.mockResolvedValueOnce([candidate(1), candidate(2), candidate(3)]);
      mocks.importSite.mockImplementation(async () => { now += TOPOLOGY_BOOTSTRAP_PASS_BUDGET_MS; return { complete: true }; });
      await runTopologyBootstrapPass();
      expect(mocks.importSite).toHaveBeenCalledOnce();
    } finally { spy.mockRestore(); }
  });

  it('never imports more than the per-pass batch even if the query over-returns', async () => {
    mocks.execute.mockResolvedValueOnce(Array.from({ length: TOPOLOGY_BOOTSTRAP_SITE_BATCH + 4 }, (_, n) => candidate(n)));
    await runTopologyBootstrapPass();
    expect(mocks.importSite).toHaveBeenCalledTimes(TOPOLOGY_BOOTSTRAP_SITE_BATCH);
  });
});
