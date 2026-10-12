import { describe, it, expect, vi } from 'vitest';
import {
  createMemoryPrefsStore,
  devicePrefsKey,
  loadDevicePrefs,
  sanitizeDevicePrefs,
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
