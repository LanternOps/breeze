import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ flags: vi.fn(), config: vi.fn(), select: vi.fn() }));
vi.mock('../../db', () => ({ db: { select: mocks.select } }));
vi.mock('./flags', async (original) => ({ ...await original<object>(), loadTopologyFlags: mocks.flags }));
vi.mock('./siteConfiguration', () => ({ loadTopologyConfiguration: mocks.config }));
// The full settings contract is covered by the settings integration suite; this unit pins the capability.
vi.mock('@breeze/shared', async (original) => ({ ...await original<object>(), topologySiteSettingsSchema: { parse: (value: unknown) => value } }));
vi.mock('./legacyImportState', () => ({ readLegacyImportCheckpoint: () => ({ status: 'complete' }) }));
vi.mock('../../middleware/auth', () => ({ hasSatisfiedMfa: () => true }));
import { readTopologySiteSettings } from './siteSettings';
import type { TopologyRequestContext } from './access';

const ORG = '10000000-0000-4000-8000-000000000001';
const SITE = '20000000-0000-4000-8000-000000000001';
const ctx = { auth: { user: { id: '50000000-0000-4000-8000-000000000001' } }, permissions: { permissions: [] }, scope: { orgId: ORG, siteId: SITE } } as unknown as TopologyRequestContext;
const flags = { materialization: true, ui: true, physical: true, interfaceHealth: false, diagnostics: false, ai: false };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.mockResolvedValue({ settingsRevision: '1', resolved: {}, binding: null, layers: { defaultsVersion: 1, resolverVersion: 1, site: null } });
  mocks.select.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [{ effectiveSettings: {} }] }) }) });
});

describe('site settings physical capability (D9)', () => {
  it('reports physical available when materialization and the physical flag are on, without a collector', async () => {
    mocks.flags.mockResolvedValue(flags);
    const settings = await readTopologySiteSettings(ctx).catch((error) => { throw error; });
    expect(settings.capabilities.physical).toEqual({ available: true, reason: null });
  });
  it('reports physical_disabled when the flag is off', async () => {
    mocks.flags.mockResolvedValue({ ...flags, physical: false });
    const settings = await readTopologySiteSettings(ctx);
    expect(settings.capabilities.physical).toEqual({ available: false, reason: 'physical_disabled' });
  });
});

describe('site settings interface-health capability (M3 Task 11)', () => {
  // Like physical (D9), port measurement is an EXPOSURE capability: the history
  // and link-health reads gate on `topologyInterfaceHealthExposed`, so the UI
  // must see the same answer rather than a never-reported agent capability.
  it('reports interfaceHealth available exactly when history/link health are exposed', async () => {
    mocks.flags.mockResolvedValue({ ...flags, interfaceHealth: true });
    const settings = await readTopologySiteSettings(ctx);
    expect(settings.capabilities.interfaceHealth).toEqual({ available: true, reason: null });
  });
  it('stays unavailable when the flag or the physical exposure it depends on is off', async () => {
    mocks.flags.mockResolvedValue({ ...flags, interfaceHealth: false });
    expect((await readTopologySiteSettings(ctx)).capabilities.interfaceHealth).toEqual({ available: false, reason: 'interface_health_disabled' });
    mocks.flags.mockResolvedValue({ ...flags, physical: false, interfaceHealth: true });
    expect((await readTopologySiteSettings(ctx)).capabilities.interfaceHealth.available).toBe(false);
  });
});

describe('site settings diagnostics capability (M3 Task 11)', () => {
  // On-demand diagnostics are per-origin: the collectors read reports which
  // agents can run a recipe. The site capability is the flag exposure, so the
  // Diagnose/trace UI is reachable on a real server whenever the flag is on.
  it('reports diagnostics available when materialization and the diagnostics flag are on', async () => {
    mocks.flags.mockResolvedValue({ ...flags, diagnostics: true });
    expect((await readTopologySiteSettings(ctx)).capabilities.diagnostics).toEqual({ available: true, reason: null });
    mocks.flags.mockResolvedValue({ ...flags, diagnostics: false });
    expect((await readTopologySiteSettings(ctx)).capabilities.diagnostics).toEqual({ available: false, reason: 'diagnostics_disabled' });
  });
});
