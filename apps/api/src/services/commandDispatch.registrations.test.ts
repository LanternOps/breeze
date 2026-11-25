import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The production entry must register the delivery revalidations on its own.
 * `install_patches` is in REVALIDATION_REQUIRED_TYPES, so if commandDispatch
 * stopped side-effect-importing `installPatchesRevalidation`, every queued
 * install would be cancelled at claim (`authority_unavailable`). The
 * integration suite and the module's unit test both import the revalidation
 * module directly, so neither would notice. This file imports ONLY
 * commandDispatch, in a fresh module registry, before reading the registry.
 */
describe('commandDispatch registers its delivery revalidations', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // A cold import of the real dispatch graph transforms a few hundred modules.
  it('install_patches has a registered revalidation after importing only commandDispatch', { timeout: 120_000 }, async () => {
    await import('./commandDispatch');
    const { commandRevalidations, REVALIDATION_REQUIRED_TYPES } = await import('./commandClaimEligibility');

    expect(REVALIDATION_REQUIRED_TYPES.has('install_patches')).toBe(true);
    expect(typeof commandRevalidations.install_patches).toBe('function');

    // And it is this module's check, not some other registration. Imported
    // only after the assertion above, so this import cannot be what registered it.
    const { revalidateInstallPatchesForDelivery } = await import('./installPatchesRevalidation');
    expect(commandRevalidations.install_patches).toBe(revalidateInstallPatchesForDelivery);
  });
});
