import { beforeEach, describe, expect, it, vi } from 'vitest';

// ensureBuiltinPackage on a mocked db: the real-Postgres cases live in
// src/__tests__/integration/builtinDeploymentPackages.integration.test.ts.
const { state } = vi.hoisted(() => ({
  state: {
    catalog: [] as Array<Record<string, unknown>>,
    versions: [] as Array<Record<string, unknown>>,
    selects: 0,
  },
}));

vi.mock('../db', async () => {
  const schema = await import('../db/schema');
  const rowsFor = (table: unknown) => (table === schema.softwareCatalog ? state.catalog : state.versions);
  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () => { state.selects += 1; return rowsFor(table).slice(0, 1); },
          }),
        }),
      }),
      insert: (table: unknown) => ({
        values: (row: Record<string, unknown>) => {
          const stored = { id: `row-${rowsFor(table).length + 1}`, ...row };
          rowsFor(table).push(stored);
          return Object.assign(Promise.resolve(), { returning: async () => [{ id: stored.id }] });
        },
      }),
    },
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    runOutsideDbContext: (fn: () => unknown) => fn(),
  };
});
vi.mock('./softwarePolicyService', () => ({ compareSoftwareVersions: vi.fn() }));
vi.mock('./softwareVersionShared', () => ({ insertLatestSoftwareVersion: vi.fn() }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import {
  BUILTIN_PACKAGES,
  ensureBuiltinPackage,
  getBuiltinPackage,
  isBuiltinProvider,
} from './builtinDeploymentPackages';

const PARTNER = '00000000-0000-4000-8000-0000000000aa';
const setReleased = (released: boolean) => {
  (BUILTIN_PACKAGES.bitdefender as { released: boolean }).released = released;
};

beforeEach(() => {
  state.catalog.length = 0;
  state.versions.length = 0;
  state.selects = 0;
  setReleased(false);
});

describe('isBuiltinProvider', () => {
  it.each([
    ['huntress', true],
    ['sentinelone', true],
    ['bitdefender', true],
    ['emsisoft', false], // a framework provider with no installer
    ['nope', false],
    ['constructor', false],
    ['', false],
    [null, false],
    [undefined, false],
  ])('%s -> %s', (value, expected) => {
    expect(isBuiltinProvider(value)).toBe(expected);
  });
});

describe('the dormant GravityZone package', () => {
  it('ships unreleased, Windows only, with placeholder templates a resolver replaces', () => {
    expect(getBuiltinPackage('bitdefender')).toMatchObject({
      released: false,
      fileType: 'exe',
      supportedOs: ['windows'],
      installerPlatform: 'windows',
      requiresBinaryUpload: false,
      downloadUrlTemplate: '{edr_installer_url}',
      silentInstallArgsTemplate: '{edr_installer_args}',
      originalFileName: 'GravityZoneInstaller.exe',
    });
  });

  it('the legacy providers stay released', () => {
    expect(getBuiltinPackage('huntress').released).toBe(true);
    expect(getBuiltinPackage('sentinelone').released).toBe(true);
  });

  it('while unreleased, ensureBuiltinPackage touches the database not at all', async () => {
    await expect(ensureBuiltinPackage({ provider: 'bitdefender', partnerId: PARTNER })).resolves.toEqual({
      catalogId: null, skipped: 'unreleased',
    });
    expect(state.catalog).toEqual([]);
    expect(state.versions).toEqual([]);
    expect(state.selects).toBe(0);
  });

  it('once released, inserts one partner row and one latest version, idempotently', async () => {
    setReleased(true);
    const first = await ensureBuiltinPackage({ provider: 'bitdefender', partnerId: PARTNER });
    const second = await ensureBuiltinPackage({ provider: 'bitdefender', partnerId: PARTNER });
    expect(first).toEqual({ catalogId: 'row-1' });
    expect(second).toEqual(first);
    expect(state.catalog).toEqual([expect.objectContaining({ integrationProvider: 'bitdefender', orgId: null, partnerId: PARTNER })]);
    expect(state.versions).toEqual([expect.objectContaining({
      version: 'latest', isLatest: true, originalFileName: 'GravityZoneInstaller.exe', fileType: 'exe',
    })]);
  });
});

describe('the legacy packages keep their file names', () => {
  it('Huntress still writes HuntressInstaller.exe', async () => {
    await ensureBuiltinPackage({ provider: 'huntress', partnerId: PARTNER });
    expect(state.versions).toEqual([expect.objectContaining({ originalFileName: 'HuntressInstaller.exe' })]);
  });

  it('SentinelOne still writes no version (the partner uploads the binary)', async () => {
    await ensureBuiltinPackage({ provider: 'sentinelone', partnerId: PARTNER });
    expect(state.catalog).toHaveLength(1);
    expect(state.versions).toEqual([]);
  });
});
