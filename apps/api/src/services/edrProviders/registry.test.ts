import { describe, expect, it } from 'vitest';
import { EDR_PROVIDER_KEYS, getEdrProvider, isEdrProviderKey, listEdrProviders } from './registry';

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
    }
  });

  it('registry keys are the pinned set and each adapter reports its own key', () => {
    expect([...EDR_PROVIDER_KEYS]).toEqual(['bitdefender']);
    for (const k of EDR_PROVIDER_KEYS) expect(getEdrProvider(k).key).toBe(k);
  });

  it('declares the incidents operation class budget', () => {
    expect(getEdrProvider('bitdefender').capabilities.operationBudgets?.incidents).toEqual({ perMinute: 2 });
  });
});
