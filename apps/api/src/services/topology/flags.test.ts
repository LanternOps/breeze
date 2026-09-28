import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbSelect, partnerRead, globallyDisabled } = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  partnerRead: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  globallyDisabled: vi.fn(() => false),
}));

vi.mock('../../db', () => ({ db: { select: dbSelect } }));
vi.mock('../../db/partnerAxisRead', () => ({
  readWithPartnerAxisVisibility: partnerRead,
}));
vi.mock('../../db/schema', () => ({
  organizations: {
    id: 'organizations.id',
    partnerId: 'organizations.partnerId',
    settings: 'organizations.settings',
  },
  partners: { id: 'partners.id', settings: 'partners.settings' },
}));
vi.mock('../../config/env', () => ({ topologyGloballyDisabled: globallyDisabled }));

import {
  getTopologyCapabilities,
  loadTopologyFlags,
  resolveTopologyFlags,
  topologyPhysicalExposed,
  withResolvedTopologyFlags,
  type TopologyRequestContextLike,
} from './flags';

const ctx = {
  scope: {
    orgId: '11111111-1111-4111-8111-111111111111',
    siteId: '22222222-2222-4222-8222-222222222222',
  },
} as TopologyRequestContextLike;

function selectResult(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue(rows) })),
    })),
  } as never;
}

describe('topology rollout flags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globallyDisabled.mockReturnValue(false);
  });

  it('defaults every flag off', () => {
    expect(resolveTopologyFlags({})).toEqual({
      materialization: false,
      ui: false,
      physical: false,
      interfaceHealth: false,
      diagnostics: false,
      ai: false,
    });
  });

  it('applies strict partner booleans before stricter org booleans', () => {
    expect(resolveTopologyFlags({
      partnerSettings: {
        topologyFeatureFlags: {
          materialization: true,
          ui: true,
          physical: true,
          interfaceHealth: true,
        },
      },
      orgSettings: {
        topologyFeatureFlags: {
          materialization: false,
          physical: false,
        },
      },
    })).toEqual({
      materialization: false,
      ui: true,
      physical: false,
      interfaceHealth: true,
      diagnostics: false,
      ai: false,
    });
  });

  it('ignores strings, numbers, arrays and flags outside topologyFeatureFlags', () => {
    expect(resolveTopologyFlags({
      partnerSettings: {
        topologyFeatureFlags: {
          materialization: 'true',
          ui: 1,
          physical: [],
        },
        diagnostics: true,
      },
      orgSettings: {
        topologyFeatureFlags: {
          interfaceHealth: null,
          diagnostics: { enabled: true },
          ai: true,
        },
      },
    })).toEqual({
      materialization: false,
      ui: false,
      physical: false,
      interfaceHealth: false,
      diagnostics: false,
      ai: true,
    });
  });

  it('forces every flag off through the global deployment kill switch', () => {
    expect(resolveTopologyFlags({
      globallyDisabled: true,
      partnerSettings: {
        topologyFeatureFlags: {
          materialization: true,
          ui: true,
          physical: true,
          interfaceHealth: true,
          diagnostics: true,
          ai: true,
        },
      },
    })).toEqual({
      materialization: false,
      ui: false,
      physical: false,
      interfaceHealth: false,
      diagnostics: false,
      ai: false,
    });
  });

  it('loads the RLS-visible org before its partner-axis settings', async () => {
    dbSelect
      .mockReturnValueOnce(selectResult([{
        partnerId: '33333333-3333-4333-8333-333333333333',
        settings: { topologyFeatureFlags: { materialization: true } },
      }]))
      .mockReturnValueOnce(selectResult([{
        settings: { topologyFeatureFlags: { ui: true } },
      }]));

    await expect(loadTopologyFlags(ctx)).resolves.toMatchObject({
      materialization: true,
      ui: true,
    });
    expect(dbSelect).toHaveBeenCalledTimes(2);
    expect(partnerRead).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the org is inaccessible under request RLS', async () => {
    dbSelect.mockReturnValueOnce(selectResult([]));

    await expect(loadTopologyFlags(ctx)).resolves.toEqual({
      materialization: false,
      ui: false,
      physical: false,
      interfaceHealth: false,
      diagnostics: false,
      ai: false,
    });
    expect(dbSelect).toHaveBeenCalledTimes(1);
    expect(partnerRead).not.toHaveBeenCalled();
  });

  it('uses the call-time deployment kill switch while loading', async () => {
    globallyDisabled.mockReturnValue(true);

    await expect(loadTopologyFlags(ctx)).resolves.toEqual({
      materialization: false,
      ui: false,
      physical: false,
      interfaceHealth: false,
      diagnostics: false,
      ai: false,
    });
    expect(dbSelect).not.toHaveBeenCalled();
  });
});

describe('topology capabilities', () => {
  const allFlags = {
    materialization: true,
    ui: true,
    physical: true,
    interfaceHealth: true,
    diagnostics: true,
    ai: true,
  };

  it('reports UI unavailable when materialization is off even if UI is on', () => {
    const capabilities = getTopologyCapabilities(
      { ...allFlags, materialization: false },
      true,
      {},
    );

    expect(capabilities.ui).toEqual({
      available: false,
      reason: 'materialization_disabled',
    });
  });

  it('reports the pre-first-build preparing state', () => {
    const capabilities = getTopologyCapabilities(allFlags, false, {});
    expect(capabilities.ui).toEqual({ available: false, reason: 'topology_preparing' });
  });

  it('keeps pre-M1 collection and diagnostics unavailable with machine reasons', () => {
    const capabilities = getTopologyCapabilities(allFlags, true, {});
    expect(capabilities.ui).toEqual({ available: true, reason: null });
    expect(capabilities.collection).toEqual({
      available: false,
      reason: 'collection_unavailable',
    });
    expect(capabilities.diagnostics).toEqual({
      available: false,
      reason: 'diagnostics_unavailable',
    });
  });

  it('requires each dependent flag and matching milestone capability', () => {
    const capabilities = getTopologyCapabilities(
      { ...allFlags, physical: false },
      true,
      {
        collection: true,
        physical: true,
        interfaceHealth: true,
        diagnostics: true,
        ai: true,
      },
    );

    expect(capabilities.collection).toEqual({ available: true, reason: null });
    expect(capabilities.physical).toEqual({ available: false, reason: 'physical_disabled' });
    expect(capabilities.interfaceHealth).toEqual({ available: true, reason: null });
    expect(capabilities.diagnostics).toEqual({ available: true, reason: null });
    expect(capabilities.ai).toEqual({ available: true, reason: null });
  });
});

describe('physical exposure (D9/D15.4)', () => {
  const base = resolveTopologyFlags({});
  it('is the deployed capability materialization && physical, independent of collectors', () => {
    expect(topologyPhysicalExposed({ ...base, materialization: true, physical: true })).toBe(true);
    expect(topologyPhysicalExposed({ ...base, materialization: true, physical: false })).toBe(false);
    expect(topologyPhysicalExposed({ ...base, materialization: false, physical: true })).toBe(false);
  });
  it('reports the settings capability from the same predicate', () => {
    const capabilities = getTopologyCapabilities({ ...base, materialization: true, physical: true }, true, { physical: topologyPhysicalExposed({ ...base, materialization: true, physical: true }) });
    expect(capabilities.physical).toEqual({ available: true, reason: null });
  });
});

// US 2026-09-22 pool deadlock: the heartbeat ran loadTopologyFlags inside its
// org transaction while holding the per-org partner-export advisory lock, and
// readWithPartnerAxisVisibility then waited for a SECOND pooled connection.
// With the pool full of same-org heartbeats queued on that lock, nothing freed.
describe('pre-resolved topology flags (no nested pool connection)', () => {
  const enabled = { ...resolveTopologyFlags({}), materialization: true, ui: true };

  beforeEach(() => {
    vi.clearAllMocks();
    dbSelect.mockReset();
    globallyDisabled.mockReturnValue(false);
  });

  it('serves pre-resolved flags without touching the database', async () => {
    const flags = await withResolvedTopologyFlags(
      { orgId: ctx.scope.orgId, flags: enabled },
      () => loadTopologyFlags(ctx),
    );

    expect(flags).toEqual(enabled);
    expect(dbSelect).not.toHaveBeenCalled();
    expect(partnerRead).not.toHaveBeenCalled();
  });

  it('fails closed without a DB read when the scope org differs from the resolved org', async () => {
    const flags = await withResolvedTopologyFlags(
      { orgId: '33333333-3333-4333-8333-333333333333', flags: enabled },
      () => loadTopologyFlags(ctx),
    );

    expect(flags).toEqual(resolveTopologyFlags({}));
    expect(dbSelect).not.toHaveBeenCalled();
    expect(partnerRead).not.toHaveBeenCalled();
  });

  it('returns defaults without any DB read when topology is globally disabled', async () => {
    globallyDisabled.mockReturnValue(true);

    await expect(loadTopologyFlags(ctx)).resolves.toEqual(resolveTopologyFlags({}));
    expect(dbSelect).not.toHaveBeenCalled();
    expect(partnerRead).not.toHaveBeenCalled();
  });

  it('does not leak pre-resolved flags outside the callback', async () => {
    await withResolvedTopologyFlags({ orgId: ctx.scope.orgId, flags: enabled }, async () => undefined);
    dbSelect.mockReturnValueOnce(selectResult([]));

    await expect(loadTopologyFlags(ctx)).resolves.toEqual(resolveTopologyFlags({}));
    expect(dbSelect).toHaveBeenCalledTimes(1);
  });
});
