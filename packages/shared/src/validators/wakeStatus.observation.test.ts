import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WAKE_VENDOR_OBSERVATION_MAX_BYTES,
  wakeStatusSnapshotSchema,
  wakeVendorObservationSchema,
} from './wakeStatus';

// The agent's goldens (agent/internal/biosconfig/testdata/wire): what it sends
// as details.vendorObservation. Both sides test the same files.
const WIRE_DIR = path.resolve(__dirname, '../../../../agent/internal/biosconfig/testdata/wire');
const GOLDENS = ['hp', 'hp_absent', 'lenovo', 'lenovo_panic', 'surface', 'surface_vm'] as const;

function golden(name: string): any {
  return JSON.parse(readFileSync(path.join(WIRE_DIR, `${name}.json`), 'utf8'));
}

const snapshot = (vendorObservation: unknown) => ({
  readinessState: 'unproven',
  reasonCodes: ['vendor_observe_only'],
  vendor: 'lenovo',
  fingerprint: 'a'.repeat(64),
  collectedAt: '2026-11-19T10:00:00Z',
  lastApplyAt: null,
  lastApplyResult: null,
  lastWiredAdapterSeenAt: null,
  details: { os: 'windows', adapters: [], vendorObservation },
});

describe('wakeVendorObservationSchema', () => {
  it.each(GOLDENS)('accepts the agent golden %s', (name) => {
    const parsed = wakeVendorObservationSchema.safeParse(golden(name));
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(wakeStatusSnapshotSchema.safeParse(snapshot(golden(name))).success).toBe(true);
  });

  it('keeps details open for the readiness fields and optional for older agents', () => {
    const s = snapshot(undefined);
    delete (s.details as Record<string, unknown>).vendorObservation;
    expect(wakeStatusSnapshotSchema.safeParse(s).success).toBe(true);
    expect(wakeStatusSnapshotSchema.safeParse({ ...s, details: { anything: { nested: [1, 2] } } }).success).toBe(true);
  });

  it('vendorObservation is strict at every depth', () => {
    const extraTop = { ...golden('lenovo'), serial: 'X' };
    const extraBlock = golden('lenovo');
    extraBlock.lenovo.assetTag = 'X';
    const extraSetting = golden('lenovo');
    extraSetting.lenovo.settings[0].owner = 'X';
    const extraAdapter = golden('surface');
    extraAdapter.surface.adapters[0].mac = 'aa:bb:cc:dd:ee:ff';
    const wrongBlock = { ...golden('hp'), lenovo: golden('lenovo').lenovo };
    for (const bad of [extraTop, extraBlock, extraSetting, extraAdapter, wrongBlock]) {
      expect(wakeVendorObservationSchema.safeParse(bad).success).toBe(false);
      expect(wakeStatusSnapshotSchema.safeParse(snapshot(bad)).success).toBe(false);
    }
  });

  it('every key is required (nullable, never optional)', () => {
    const g = golden('hp');
    for (const key of Object.keys(g)) {
      const { [key]: _dropped, ...rest } = g;
      expect(wakeVendorObservationSchema.safeParse(rest).success, key).toBe(false);
    }
    for (const key of Object.keys(g.hp)) {
      const { [key]: _dropped, ...rest } = g.hp;
      expect(wakeVendorObservationSchema.safeParse({ ...g, hp: rest }).success, `hp.${key}`).toBe(false);
    }
  });

  it('rejects an unknown vendor, interface, arch or schema version', () => {
    for (const patch of [{ vendor: 'dell' }, { interface: 'maybe' }, { nativeArch: 'riscv' }, { schema: 2 }]) {
      expect(wakeVendorObservationSchema.safeParse({ ...golden('hp'), ...patch }).success).toBe(false);
    }
  });

  it('bounds strings, lists and counts', () => {
    const long = golden('lenovo');
    long.lenovo.settings[0].value = 'v'.repeat(65);
    const many = golden('lenovo');
    many.lenovo.settings[0].possibleValues = Array.from({ length: 17 }, (_, i) => `v${i}`);
    const tooMany = golden('hp');
    tooMany.hp.settings = Array.from({ length: 49 }, (_, i) => ({ name: `Wake ${i}`, value: 'x', possibleValues: [] }));
    const badCode = { ...golden('hp_absent'), errorCode: 'has spaces in it' };
    const badPnp = golden('surface');
    badPnp.surface.adapters[0].pnpId = 'USB\\VID_045E&PID_07C6\\SERIAL123';
    const badClass = golden('lenovo');
    badClass.lenovo.classes = ['Win32_Process'];
    const badMachineType = golden('lenovo');
    badMachineType.lenovo.machineType = 'ThinkPad';
    for (const bad of [long, many, tooMany, badCode, badPnp, badClass, badMachineType]) {
      expect(wakeVendorObservationSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('refuses control and format characters in device text', () => {
    for (const ch of ['\u0000', '\u001b', '\u007f', '\u0085', '​', '‮']) {
      const g = golden('lenovo');
      g.lenovo.settings[0].name = `Wake${ch}OnLAN`;
      expect(wakeVendorObservationSchema.safeParse(g).success, JSON.stringify(ch)).toBe(false);
    }
  });

  it('caps the settings list in UTF-8 bytes, not code points', () => {
    const g = golden('hp');
    // 48 settings of 64 three-byte characters: within every per-field and
    // count bound, over the 8 KiB byte cap.
    const wide = '€'.repeat(64);
    g.hp.settings = Array.from({ length: 48 }, () => ({ name: wide, value: wide, possibleValues: [] }));
    const parsed = wakeVendorObservationSchema.safeParse(g);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('bytes');
  });

  it('the whole-observation byte cap admits a maximal valid observation', () => {
    const g = golden('lenovo');
    const wide = '€'.repeat(64);
    g.lenovo.settings = [{ name: 'WakeOnLAN', value: 'x', possibleValues: [] }];
    g.lenovo.classes = Array.from({ length: 64 }, (_, i) => `Lenovo_${'X'.repeat(50)}${i}`);
    const surface = golden('surface');
    surface.surface.adapters = Array.from({ length: 16 }, () => ({ pnpId: null, driverProvider: wide, description: wide, surfaceMatch: false }));
    surface.surface.systemSku = wide;
    surface.surface.model = wide;
    const bytes = new TextEncoder().encode(JSON.stringify(surface)).length;
    expect(bytes).toBeLessThan(WAKE_VENDOR_OBSERVATION_MAX_BYTES); // the per-field bounds already keep Surface under
    expect(wakeVendorObservationSchema.safeParse(surface).success).toBe(true);
    expect(wakeVendorObservationSchema.safeParse(g).success).toBe(true);
  });
});
