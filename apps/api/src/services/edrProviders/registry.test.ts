import { describe, expect, it } from 'vitest';
import { EDR_PROVIDER_KEYS, getEdrProvider, isEdrProviderKey, listEdrProviders } from './registry';
import { EDR_PROVIDER_LABELS } from './providerKeys';

describe('edr provider registry', () => {
  it('throws on an unknown key, including inherited object keys', () => {
    for (const k of ['nope', '__proto__', 'constructor', 'toString']) {
      expect(() => getEdrProvider(k)).toThrow(/Unknown EDR provider/);
      expect(isEdrProviderKey(k)).toBe(false);
    }
  });

  it('every registered adapter declares a non-empty host allowlist and a self-consistent capability set', () => {
    for (const a of listEdrProviders()) {
      expect(a.hostAllowlist.length).toBeGreaterThan(0);
      expect(a.capabilities.actions.length === 0 || typeof a.performAction === 'function').toBe(true);
      expect(a.capabilities.detectionDelivery === 'poll' || typeof a.verifyWebhook === 'function').toBe(true);
      expect(a.capabilities.installer === 'none' || typeof a.getInstaller === 'function').toBe(true);
      // A5: the re-read status model needs its read hook, and only that model has one.
      expect(typeof a.rereadDetectionStatus === 'function').toBe(a.capabilities.detectionStatusModel === 'reread_open_on_inventory');
    }
  });

  it('registry keys are the pinned set and each adapter reports its own key', () => {
    expect([...EDR_PROVIDER_KEYS]).toEqual(['bitdefender', 'emsisoft']);
    for (const k of EDR_PROVIDER_KEYS) expect(getEdrProvider(k).key).toBe(k);
  });

  it('the import-free display labels match each adapter label (#8166)', () => {
    for (const k of EDR_PROVIDER_KEYS) expect(EDR_PROVIDER_LABELS[k]).toBe(getEdrProvider(k).label);
  });

  it('declares the incidents operation class budget', () => {
    expect(getEdrProvider('bitdefender').capabilities.operationBudgets?.incidents).toEqual({ perMinute: 2 });
  });

  it('emsisoft declares no connection-wide incidents budget (its incidents are per workspace; scheduler.ts:22-27 assumes one call per run)', () => {
    expect(getEdrProvider('emsisoft').capabilities.operationBudgets?.incidents).toBeUndefined();
  });
});
