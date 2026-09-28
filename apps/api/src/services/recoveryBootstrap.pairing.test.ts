import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {},
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => fn(),
}));
// Only the pure exports are exercised; keep the per-case re-import cheap.
vi.mock('../db/schema', () => ({
  backupConfigs: {},
  backupJobs: {},
  backupSnapshots: {},
  devices: {},
  recoveryMediaArtifacts: {},
  recoveryTokens: {},
  restoreJobs: {},
}));

// BMR_MIN_HELPER_VERSION is a module constant read at import time, so each case
// sets the env first and imports a fresh copy of the module.
async function loadWith(env: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.resetModules();
  return import('./recoveryBootstrap');
}

describe('BMR minimum helper version follows the binaries pairing', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.BINARY_GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPO;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('server-only image: the minimum is the paired binaries release, so its recovery helper is accepted', async () => {
    const mod = await loadWith({
      BREEZE_VERSION: '0.118.2',
      BREEZE_BINARIES_VERSION: '0.118.0',
      BINARY_VERSION: undefined,
    });
    expect(mod.BMR_MIN_HELPER_VERSION).toBe('0.118.0');
    // The helper baked into the 0.118.0 recovery media must pass the gate.
    expect(mod.isHelperVersionAtLeast('0.118.0', mod.BMR_MIN_HELPER_VERSION)).toBe(true);

    const payload = mod.buildAuthenticatedBootstrapPayload({
      tokenId: 't',
      deviceId: 'd',
      snapshotId: 's',
      restoreType: 'bare_metal',
      targetConfig: null,
      authenticatedAt: new Date(),
      device: null,
      snapshot: null,
      providerType: null,
      config: null,
    });
    expect(payload.minHelperVersion).toBe('0.118.0');
    expect(payload.bootstrap.minHelperVersion).toBe('0.118.0');
  });

  it.each([
    [{ BREEZE_VERSION: '0.118.0', BINARY_VERSION: undefined, BREEZE_BINARIES_VERSION: undefined }, '0.118.0'],
    [{ BREEZE_VERSION: '0.118.0', BINARY_VERSION: undefined, BREEZE_BINARIES_VERSION: '' }, '0.118.0'],
    [{ BREEZE_VERSION: '0.118.0', BINARY_VERSION: '0.117.0', BREEZE_BINARIES_VERSION: '' }, '0.118.0'],
    [{ BREEZE_VERSION: undefined, BINARY_VERSION: '0.117.0', BREEZE_BINARIES_VERSION: undefined }, '0.117.0'],
    [{ BREEZE_VERSION: undefined, BINARY_VERSION: undefined, BREEZE_BINARIES_VERSION: undefined }, '0.5.0'],
  ])('full-release image (pairing empty) is unchanged: %j → %s', async (env, expected) => {
    const mod = await loadWith(env);
    expect(mod.BMR_MIN_HELPER_VERSION).toBe(expected);
  });
});
