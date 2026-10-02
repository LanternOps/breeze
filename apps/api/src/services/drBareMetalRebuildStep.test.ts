import { describe, expect, it, vi } from 'vitest';
import { WHOLE_MACHINE_RESTORE_TIMEOUT_MS } from './commandTimeouts';
import {
  DR_BARE_METAL_REBUILD_DEFAULT_OUTPUT_DIR,
  DR_BARE_METAL_REBUILD_DEFAULT_OUTPUT_DIR_LINUX,
  DR_BARE_METAL_REBUILD_DEFAULT_OUTPUT_DIR_WINDOWS,
  defaultRebuildOutputDir,
  drBareMetalRebuildConfigSchema,
  drRestoreConfigSchema,
  isBareMetalRebuildConfig,
  joinRebuildOutputPath,
  resolveLatestRestorableSnapshot,
  resolveLatestRestorableSnapshotId,
} from './drBareMetalRebuildStep';

const HOST_ID = '99999999-9999-4999-8999-999999999999';

describe('drBareMetalRebuildConfigSchema', () => {
  it('applies the documented defaults', () => {
    expect(drBareMetalRebuildConfigSchema.parse({ commandType: 'BARE_METAL_REBUILD' })).toEqual({
      commandType: 'BARE_METAL_REBUILD',
      snapshotSelection: 'latest_restorable',
      outputDir: DR_BARE_METAL_REBUILD_DEFAULT_OUTPUT_DIR,
      waitTimeoutMinutes: 1440,
    });
  });

  // #7087: a Windows whole-machine rebuild of 133k files / 20.6 GB took 5h23m
  // in the lab. The step's wait budget must not cancel a rebuild that the
  // bare_metal_rebuild command's own reaper ceiling would still let run.
  it('defaults the wait budget to the whole-machine restore command ceiling (#7087)', () => {
    const { waitTimeoutMinutes } = drBareMetalRebuildConfigSchema.parse({ commandType: 'BARE_METAL_REBUILD' });
    expect(waitTimeoutMinutes * 60_000).toBe(WHOLE_MACHINE_RESTORE_TIMEOUT_MS);
  });

  it.each([
    ['waitTimeoutMinutes below 5', { waitTimeoutMinutes: 2 }],
    ['waitTimeoutMinutes above 1440', { waitTimeoutMinutes: 1441 }],
    ['non-integer waitTimeoutMinutes', { waitTimeoutMinutes: 10.5 }],
    ['relative outputDir', { outputDir: 'out' }],
    ['non-uuid rebuildHostDeviceId', { rebuildHostDeviceId: 'host-1' }],
    ['other snapshotSelection', { snapshotSelection: 'pinned' }],
  ])('rejects %s', (_label, extra) => {
    expect(drBareMetalRebuildConfigSchema.safeParse({ commandType: 'BARE_METAL_REBUILD', ...extra }).success).toBe(false);
  });
});

// W06d (Task 20): the default output dir is host-OS-dependent at DISPATCH; the
// stored config keeps the Linux default (normalised) and dispatch maps it.
describe('per-OS rebuild output paths (W06d)', () => {
  it('defaults outputDir per host OS when omitted', () => {
    expect(defaultRebuildOutputDir('windows')).toBe('C:\\ProgramData\\Breeze\\rebuild\\out');
    expect(defaultRebuildOutputDir('linux')).toBe('/var/lib/breeze/rebuild/out');
    expect(DR_BARE_METAL_REBUILD_DEFAULT_OUTPUT_DIR_WINDOWS).toBe('C:\\ProgramData\\Breeze\\rebuild\\out');
    expect(DR_BARE_METAL_REBUILD_DEFAULT_OUTPUT_DIR_LINUX).toBe('/var/lib/breeze/rebuild/out');
    // The legacy name stays the Linux default so stored, normalised configs keep matching it.
    expect(DR_BARE_METAL_REBUILD_DEFAULT_OUTPUT_DIR).toBe(DR_BARE_METAL_REBUILD_DEFAULT_OUTPUT_DIR_LINUX);
  });

  it('joins a Windows output dir with a backslash and a POSIX dir with a slash', () => {
    expect(joinRebuildOutputPath('C:\\ProgramData\\Breeze\\rebuild\\out', 'dev-1-rec-1.vhdx')).toBe(
      'C:\\ProgramData\\Breeze\\rebuild\\out\\dev-1-rec-1.vhdx',
    );
    expect(joinRebuildOutputPath('/var/lib/breeze/rebuild/out', 'dev-1-rec-1.vhdx')).toBe(
      '/var/lib/breeze/rebuild/out/dev-1-rec-1.vhdx',
    );
  });

  it('does not double a trailing separator (one or many)', () => {
    expect(joinRebuildOutputPath('D:\\out\\', 'x.vhdx')).toBe('D:\\out\\x.vhdx');
    expect(joinRebuildOutputPath('D:\\', 'x.vhdx')).toBe('D:\\x.vhdx');
    expect(joinRebuildOutputPath('/srv/out//', 'x.vhdx')).toBe('/srv/out/x.vhdx');
    expect(joinRebuildOutputPath('/', 'x.vhdx')).toBe('/x.vhdx');
  });

  it('accepts a Windows drive-letter outputDir', () => {
    const parsed = drBareMetalRebuildConfigSchema.safeParse({ commandType: 'BARE_METAL_REBUILD', outputDir: 'D:\\rebuild\\out' });
    expect(parsed.success).toBe(true);
  });

  it('rejects a relative outputDir the same way it does today, for both separators', () => {
    expect(drBareMetalRebuildConfigSchema.safeParse({ commandType: 'BARE_METAL_REBUILD', outputDir: 'out' }).success).toBe(false);
    expect(drBareMetalRebuildConfigSchema.safeParse({ commandType: 'BARE_METAL_REBUILD', outputDir: 'out\\x' }).success).toBe(false);
    expect(drBareMetalRebuildConfigSchema.safeParse({ commandType: 'BARE_METAL_REBUILD', outputDir: '\\\\srv\\share' }).success).toBe(false);
  });

  it('carries no hyperv field — DR rehearsals stop at the VHDX', () => {
    expect(drBareMetalRebuildConfigSchema.parse({ commandType: 'BARE_METAL_REBUILD', hyperv: { vmName: 'x' } })).not.toHaveProperty('hyperv');
  });
});

describe('drRestoreConfigSchema', () => {
  it('passes other step types through untouched (open record)', () => {
    const cfg = { commandType: 'vm_restore_from_backup', payload: { snapshotId: 'snap-1', anything: true } };
    expect(drRestoreConfigSchema.parse(cfg)).toEqual(cfg);
  });

  it('normalises a BARE_METAL_REBUILD config', () => {
    expect(drRestoreConfigSchema.parse({ commandType: 'BARE_METAL_REBUILD', rebuildHostDeviceId: HOST_ID })).toEqual({
      commandType: 'BARE_METAL_REBUILD',
      snapshotSelection: 'latest_restorable',
      rebuildHostDeviceId: HOST_ID,
      outputDir: DR_BARE_METAL_REBUILD_DEFAULT_OUTPUT_DIR,
      waitTimeoutMinutes: 1440,
    });
  });

  // A plain z.union([strict, record]) would let this fall through to the open record.
  it('does NOT let an invalid BARE_METAL_REBUILD config fall through to the open record', () => {
    const result = drRestoreConfigSchema.safeParse({ commandType: 'BARE_METAL_REBUILD', waitTimeoutMinutes: 2 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path.join('.'))).toContain('waitTimeoutMinutes');
    }
  });
});

describe('drRestoreConfigSchema — no stored credentials', () => {
  it.each([
    ['a top-level storage destination', { commandType: 'hyperv_restore', providerConfig: { bucket: 'b' }, payload: {} }],
    ['a payload storage destination', {
      commandType: 'mssql_restore',
      payload: { snapshotId: 'snap-1', provider: 's3', providerConfig: { accessKey: 'AKIA-SYNTHETIC', secretKey: 'synthetic' } },
    }],
    ['a sealed destination copied from a command', { commandType: 'hyperv_restore', payload: { providerConfigEnvelope: 'enc:v3:x' } }],
    ['a password', { commandType: 'vm_restore_from_backup', payload: { snapshotId: 'snap-1', password: 'synthetic' } }],
    ['a nested secret key', { commandType: 'vm_instant_boot', payload: { options: { secretAccessKey: 'synthetic' } } }],
    ['a bearer recovery token', { commandType: 'bmr_recover', payload: { recoveryToken: 'synthetic', serverUrl: 'https://x.example' } }],
    ['an api key', { commandType: 'vm_restore_from_backup', payload: { apiKey: 'synthetic' } }],
  ])('rejects %s', (_label, cfg) => {
    const result = drRestoreConfigSchema.safeParse(cfg);
    expect(result.success).toBe(false);
  });

  it('still accepts ordinary step configuration and identifiers', () => {
    const cfg = {
      commandType: 'hyperv_restore',
      payload: {
        snapshotId: 'snap-1',
        vmName: 'Recovered VM',
        generateNewId: true,
        noRecovery: false,
        tokenExpiresAt: '2026-10-01T00:00:00Z',
        recoveryTokenId: '99999999-9999-4999-8999-999999999999',
      },
    };
    expect(drRestoreConfigSchema.parse(cfg)).toEqual(cfg);
  });
});

describe('isBareMetalRebuildConfig', () => {
  it.each([
    [{ commandType: 'BARE_METAL_REBUILD' }, true],
    [{ commandType: 'bmr_recover' }, false],
    [null, false],
    [['BARE_METAL_REBUILD'], false],
    ['BARE_METAL_REBUILD', false],
  ])('%j -> %s', (value, expected) => {
    expect(isBareMetalRebuildConfig(value)).toBe(expected);
  });
});

describe('resolveLatestRestorableSnapshotId', () => {
  function txReturning(rows: unknown[]) {
    const chain: any = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve(rows));
    return { select: vi.fn(() => chain), chain };
  }

  it('returns the newest restorable snapshot id through the given transaction', async () => {
    const tx = txReturning([{ id: 'snap-newest' }]);
    await expect(resolveLatestRestorableSnapshotId('org-1', 'dev-1', tx as any)).resolves.toBe('snap-newest');
    expect(tx.select).toHaveBeenCalledTimes(1);
    expect(tx.chain.limit).toHaveBeenCalledWith(1);
  });

  it('returns null when the device has no restorable snapshot', async () => {
    const tx = txReturning([]);
    await expect(resolveLatestRestorableSnapshotId('org-1', 'dev-1', tx as any)).resolves.toBeNull();
  });
});

describe('resolveLatestRestorableSnapshot (W06d — id + platform for the dispatcher)', () => {
  function txReturning(rows: unknown[]) {
    const chain: any = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve(rows));
    return { select: vi.fn(() => chain), chain };
  }

  it('returns the newest restorable snapshot with the platform from its layout manifest', async () => {
    const tx = txReturning([{ id: 'snap-newest', layoutManifest: { schemaVersion: 1, platform: 'windows', disks: [] } }]);
    await expect(resolveLatestRestorableSnapshot('org-1', 'dev-1', tx as any)).resolves.toEqual({ id: 'snap-newest', platform: 'windows' });
    expect(tx.chain.limit).toHaveBeenCalledWith(1);
  });

  it('returns platform null when the layout has no platform', async () => {
    const tx = txReturning([{ id: 'snap-old', layoutManifest: { schemaVersion: 1, disks: [] } }]);
    await expect(resolveLatestRestorableSnapshot('org-1', 'dev-1', tx as any)).resolves.toEqual({ id: 'snap-old', platform: null });
  });

  it('returns null when the device has no restorable snapshot', async () => {
    const tx = txReturning([]);
    await expect(resolveLatestRestorableSnapshot('org-1', 'dev-1', tx as any)).resolves.toBeNull();
  });
});
