import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OEM_OBSERVE_RESULT_MAX_BYTES,
  oemObservePayloadSchema,
  oemObserveResultSchema,
} from './oemObserve';
import { agentSupportsOemObserve, OEM_OBSERVE_LANES } from '../utils/oemUpdates';

// The wire contract is frozen by these goldens. The agent's Go test
// (agent/internal/oemupdates/observe) decodes and re-encodes the same files, so
// a field renamed on one side fails on both.
const WIRE_DIR = path.resolve(__dirname, '../../../../agent/internal/oemupdates/observe/testdata/wire');
function golden(lane: 'surface' | 'hp' | 'lenovo'): Record<string, any> {
  return JSON.parse(readFileSync(path.join(WIRE_DIR, `${lane}.json`), 'utf8'));
}

function allKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, into));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      allKeys(v, into);
    }
  }
  return into;
}

describe('oemObservePayloadSchema', () => {
  const ok = { lane: 'surface', observeLevel: 'passive', escrowedProtectorIds: [] };

  it('accepts a passive observe for each observable lane', () => {
    for (const lane of OEM_OBSERVE_LANES) {
      expect(oemObservePayloadSchema.safeParse({ ...ok, lane }).success).toBe(true);
    }
  });

  it('refuses observeLevel scan until D-OEM-2', () => {
    expect(oemObservePayloadSchema.safeParse({ ...ok, observeLevel: 'scan' }).success).toBe(false);
  });

  it('refuses dell: no stage entry, nothing to observe', () => {
    expect(oemObservePayloadSchema.safeParse({ ...ok, lane: 'dell' }).success).toBe(false);
  });

  it('is strict', () => {
    expect(oemObservePayloadSchema.safeParse({ ...ok, categories: ['driver'] }).success).toBe(false);
  });
});

describe('oemObserveResultSchema', () => {
  it.each(['surface', 'hp', 'lenovo'] as const)('parses the %s golden', (lane) => {
    const parsed = oemObserveResultSchema.safeParse(golden(lane));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('strict at every depth', () => {
    const mutations: Array<(r: Record<string, any>) => void> = [
      (r) => { r.extra = 1; },
      (r) => { r.smbios.serialNumber = 'X'; },
      (r) => { r.bios.extra = 1; },
      (r) => { r.power.extra = 1; },
      (r) => { r.bitlocker.recoveryPassword = 'x'; },
      (r) => { r.tools.push({ name: 'lenovo_lsuclient', version: null, publisher: null, signatureValid: null, location: 'other', path: 'C:\\x' }); },
      (r) => { r.conflicts.push({ name: 'lenovo_vantage', version: null, extra: 1 }); },
      (r) => { r.errors.push({ step: 'x', code: 'y', message: 'z' }); },
      (r) => { r.lenovo.extra = 1; },
      (r) => { r.lenovo.catalog.extra = 1; },
      (r) => { r.lenovo.catalog.byRebootType['2'] = 1; },
    ];
    for (const mutate of mutations) {
      const r = golden('lenovo');
      mutate(r);
      expect(oemObserveResultSchema.safeParse(r).success).toBe(false);
    }
    const s = golden('surface');
    s.surface.updates[0].installPath = 'C:\\x';
    expect(oemObserveResultSchema.safeParse(s).success).toBe(false);
    const h = golden('hp');
    h.hp.platformCatalog.url = 'https://x';
    expect(oemObserveResultSchema.safeParse(h).success).toBe(false);
  });

  it('a lane carries only its own vendor block', () => {
    const r = golden('hp');
    r.lenovo = golden('lenovo').lenovo;
    expect(oemObserveResultSchema.safeParse(r).success).toBe(false);
    const swapped = golden('hp');
    swapped.lane = 'surface';
    expect(oemObserveResultSchema.safeParse(swapped).success).toBe(false);
  });

  it('no path, serial, MAC, host, user or key field exists', () => {
    // Every key is required (nullable, never optional), so the three goldens
    // between them carry every key the schema has.
    const keys = [...allKeys(golden('surface')), ...allKeys(golden('hp')), ...allKeys(golden('lenovo'))]
      .map((k) => k.toLowerCase());
    for (const banned of ['path', 'serial', 'macaddr', 'host', 'user', 'uuid', 'asset', 'key', 'password', 'sid', 'ip']) {
      expect(keys.filter((k) => k.includes(banned)), banned).toEqual([]);
    }
    // `machineType` is the Lenovo MTM, a product number: only a bare `mac` is banned.
    expect(keys).not.toContain('mac');
  });

  it('tool and conflict names are a closed list, not free text', () => {
    const r = golden('lenovo');
    r.tools[0].name = 'C:\\Users\\someone\\tool.exe';
    expect(oemObserveResultSchema.safeParse(r).success).toBe(false);
    const c = golden('hp');
    c.conflicts[0].name = 'Some Other App';
    expect(oemObserveResultSchema.safeParse(c).success).toBe(false);
  });

  it('refuses control characters in vendor text', () => {
    const r = golden('surface');
    r.surface.updates[0].title = 'bad\u001b[31m';
    expect(oemObserveResultSchema.safeParse(r).success).toBe(false);
  });

  it('refuses a Lenovo machine type that is not 4 alphanumerics', () => {
    const r = golden('lenovo');
    r.lenovo.machineType = '21K5/../x';
    expect(oemObserveResultSchema.safeParse(r).success).toBe(false);
  });

  it('bounds the lists', () => {
    const r = golden('surface');
    r.surface.updates = Array.from({ length: 51 }, () => r.surface.updates[0]);
    expect(oemObserveResultSchema.safeParse(r).success).toBe(false);
    const e = golden('hp');
    e.errors = Array.from({ length: 17 }, () => ({ step: 'x', code: 'y' }));
    expect(oemObserveResultSchema.safeParse(e).success).toBe(false);
  });

  it(`result over ${OEM_OBSERVE_RESULT_MAX_BYTES} bytes is refused`, () => {
    const r = golden('surface');
    // 50 updates within every field bound still exceed 32 KiB with long titles.
    r.surface.updates = Array.from({ length: 50 }, (_, i) => ({
      ...r.surface.updates[0],
      title: `${'t'.repeat(190)}${i}`,
      driverModel: 'm'.repeat(200),
      driverManufacturer: 'f'.repeat(128),
      driverProvider: 'p'.repeat(128),
    }));
    expect(JSON.stringify(r).length).toBeGreaterThan(OEM_OBSERVE_RESULT_MAX_BYTES);
    expect(oemObserveResultSchema.safeParse(r).success).toBe(false);
  });
});

describe('agentSupportsOemObserve', () => {
  it('fails closed and has its own minimum', () => {
    expect(agentSupportsOemObserve(undefined)).toBe(false);
    expect(agentSupportsOemObserve('dev')).toBe(false);
    expect(agentSupportsOemObserve('0.130.0')).toBe(false);
    expect(agentSupportsOemObserve('0.131.0-rc.1')).toBe(true);
    expect(agentSupportsOemObserve('0.131.0')).toBe(true);
  });
});
