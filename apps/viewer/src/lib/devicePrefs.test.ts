import { describe, it, expect, vi } from 'vitest';
import {
  createMemoryPrefsStore,
  devicePrefsKey,
  loadDevicePrefs,
  loadKeyboardMode,
  sanitizeDevicePrefs,
  saveKeyboardMode,
  saveDevicePrefs,
  type PrefsStore,
} from './devicePrefs';

const DEVICE = '3f1c2a4e-9b7d-4c1e-8a2f-0d9e8c7b6a51';

describe('devicePrefsKey', () => {
  it('keys by device id and refuses ids that are not plain identifiers', () => {
    expect(devicePrefsKey(DEVICE)).toBe(`device:${DEVICE}`);
    expect(devicePrefsKey('')).toBeNull();
    expect(devicePrefsKey(undefined)).toBeNull();
    expect(devicePrefsKey('../../etc')).toBeNull();
    expect(devicePrefsKey('x'.repeat(129))).toBeNull();
  });
});

describe('sanitizeDevicePrefs', () => {
  it('keeps only known fields with the right types', () => {
    expect(sanitizeDevicePrefs({ remapCmdCtrl: true, viewScaling: 'actual', audio: false })).toEqual({
      remapCmdCtrl: true, viewScaling: 'actual', audio: false,
    });
    expect(sanitizeDevicePrefs({ remapCmdCtrl: 'yes', viewScaling: '200%', audio: 1, extra: 'x' })).toEqual({});
    expect(sanitizeDevicePrefs({ keyboardMode: 'physical' })).toEqual({ keyboardMode: 'physical' });
    expect(sanitizeDevicePrefs({ keyboardMode: 'scancodes' })).toEqual({});
    expect(sanitizeDevicePrefs(null)).toEqual({});
    expect(sanitizeDevicePrefs('nope')).toEqual({});
  });
});

describe('load / save', () => {
  it('round-trips and merges a partial update into what was there', async () => {
    const store = createMemoryPrefsStore();
    await saveDevicePrefs(store, DEVICE, { remapCmdCtrl: false });
    await saveDevicePrefs(store, DEVICE, { viewScaling: 'actual' });
    expect(await loadDevicePrefs(store, DEVICE)).toEqual({ remapCmdCtrl: false, viewScaling: 'actual' });
  });

  it('two saves fired together both land (writes are serialized, review fix)', async () => {
    const base = createMemoryPrefsStore();
    // A slow read lets the second save's read overlap the first save's write.
    const slow: PrefsStore = {
      get: async (k) => { const v = await base.get(k); await new Promise((r) => setTimeout(r, 5)); return v; },
      set: (k, v) => base.set(k, v),
    };
    await Promise.all([
      saveDevicePrefs(slow, DEVICE, { audio: true }),
      saveDevicePrefs(slow, DEVICE, { viewScaling: 'actual' }),
      saveDevicePrefs(slow, DEVICE, { remapCmdCtrl: true }),
    ]);
    expect(await loadDevicePrefs(base, DEVICE)).toEqual({ audio: true, viewScaling: 'actual', remapCmdCtrl: true });
  });

  it('keeps devices apart', async () => {
    const store = createMemoryPrefsStore();
    await saveDevicePrefs(store, DEVICE, { audio: true });
    expect(await loadDevicePrefs(store, 'other-device')).toEqual({});
  });

  it('defaults when the store is missing, empty, corrupt or throws', async () => {
    expect(await loadDevicePrefs(null, DEVICE)).toEqual({});
    const throwing: PrefsStore = { get: vi.fn(async () => { throw new Error('io'); }), set: vi.fn() };
    const log = vi.fn();
    expect(await loadDevicePrefs(throwing, DEVICE, log)).toEqual({});
    expect(log).toHaveBeenCalled();
    const corrupt = createMemoryPrefsStore({ [`device:${DEVICE}`]: 'not an object' });
    expect(await loadDevicePrefs(corrupt, DEVICE)).toEqual({});
  });

  it('a failing save is logged, never thrown', async () => {
    const failing: PrefsStore = { get: async () => undefined, set: vi.fn(async () => { throw new Error('disk full'); }) };
    const log = vi.fn();
    await expect(saveDevicePrefs(failing, DEVICE, { audio: true }, log)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
  });

  it('does nothing without a usable device id', async () => {
    const store = createMemoryPrefsStore();
    const set = vi.spyOn(store, 'set');
    await saveDevicePrefs(store, undefined, { audio: true });
    expect(set).not.toHaveBeenCalled();
    expect(await loadDevicePrefs(store, undefined)).toEqual({});
  });
});

describe('keyboard mode (W06): per device, with a global default', () => {
  it('defaults to "Type what I see" when nothing is stored, the store is missing or throws', async () => {
    expect(await loadKeyboardMode(createMemoryPrefsStore(), DEVICE)).toBe('text');
    expect(await loadKeyboardMode(null, DEVICE)).toBe('text');
    const throwing: PrefsStore = { get: vi.fn(async () => { throw new Error('io'); }), set: vi.fn() };
    const log = vi.fn();
    expect(await loadKeyboardMode(throwing, DEVICE, log)).toBe('text');
    expect(log).toHaveBeenCalled();
  });

  it('a device without its own choice uses the global default', async () => {
    const store = createMemoryPrefsStore({ defaults: { keyboardMode: 'physical' } });
    expect(await loadKeyboardMode(store, DEVICE)).toBe('physical');
    expect(await loadKeyboardMode(store, undefined)).toBe('physical');
  });

  it("a device's own choice wins over the global default", async () => {
    const store = createMemoryPrefsStore({
      defaults: { keyboardMode: 'physical' },
      [`device:${DEVICE}`]: { keyboardMode: 'text' },
    });
    expect(await loadKeyboardMode(store, DEVICE)).toBe('text');
  });

  it('ignores a corrupt global default', async () => {
    const store = createMemoryPrefsStore({ defaults: { keyboardMode: 42 } });
    expect(await loadKeyboardMode(store, DEVICE)).toBe('text');
  });

  it('saving records the device choice and makes it the default for new devices, keeping other prefs', async () => {
    const store = createMemoryPrefsStore({ [`device:${DEVICE}`]: { audio: true } });
    await saveKeyboardMode(store, DEVICE, 'physical');
    expect(await loadDevicePrefs(store, DEVICE)).toEqual({ audio: true, keyboardMode: 'physical' });
    expect(await loadKeyboardMode(store, 'another-device')).toBe('physical');
  });

  it('a failing save is logged, never thrown', async () => {
    const failing: PrefsStore = { get: async () => undefined, set: vi.fn(async () => { throw new Error('disk full'); }) };
    const log = vi.fn();
    await expect(saveKeyboardMode(failing, DEVICE, 'physical', log)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
  });
});
