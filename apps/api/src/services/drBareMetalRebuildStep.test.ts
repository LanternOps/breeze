import { describe, expect, it, vi } from 'vitest';
import {
  DR_BARE_METAL_REBUILD_DEFAULT_OUTPUT_DIR,
  drBareMetalRebuildConfigSchema,
  drRestoreConfigSchema,
  isBareMetalRebuildConfig,
  resolveLatestRestorableSnapshotId,
} from './drBareMetalRebuildStep';

const HOST_ID = '99999999-9999-4999-8999-999999999999';

describe('drBareMetalRebuildConfigSchema', () => {
  it('applies the documented defaults', () => {
    expect(drBareMetalRebuildConfigSchema.parse({ commandType: 'BARE_METAL_REBUILD' })).toEqual({
      commandType: 'BARE_METAL_REBUILD',
      snapshotSelection: 'latest_restorable',
      outputDir: DR_BARE_METAL_REBUILD_DEFAULT_OUTPUT_DIR,
      waitTimeoutMinutes: 240,
    });
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
      waitTimeoutMinutes: 240,
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
