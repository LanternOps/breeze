import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HP_WARRANTY_OBSERVE_COMPONENT,
  HP_WARRANTY_OBSERVE_MAX_BYTES,
  hpWarrantyObservationSchema,
  isHpWarrantyObservableName,
  sanitizeHpWarrantyObserveFields,
} from './hpWarrantyObserve';

// The wire contract is frozen by these goldens. The agent's Go test
// (agent/internal/hpwarrantyobserve) decodes and re-encodes the same files, so a
// field renamed on one side fails on both.
const WIRE_DIR = path.resolve(__dirname, '../../../../agent/internal/hpwarrantyobserve/testdata/wire');
function readWire(name: string): any {
  return JSON.parse(readFileSync(path.join(WIRE_DIR, name), 'utf8'));
}
const GOLDENS = ['consumer_absent.json', 'business_present.json'] as const;

describe('hpWarrantyObservationSchema', () => {
  it.each(GOLDENS)('parses the %s golden', (name) => {
    const parsed = hpWarrantyObservationSchema.safeParse(readWire(name));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('every key is required: dropping any top-level key fails', () => {
    const golden = readWire('consumer_absent.json');
    for (const key of Object.keys(golden)) {
      const copy = { ...golden };
      delete copy[key];
      expect(hpWarrantyObservationSchema.safeParse(copy).success, key).toBe(false);
    }
  });

  it('is strict at every depth', () => {
    const mutations: Array<(o: any) => void> = [
      (o) => { o.serialNumber = 'X'; },
      (o) => { o.namespaces.extra = 'present'; },
      (o) => { o.classes.extra = 1; },
      (o) => { o.hpWarranty.extra = 1; },
      (o) => { o.hpWarranty.properties[0].value = 'X'; },
      (o) => { o.cmsl[0].path = 'C:\\x'; },
      (o) => { o.powershell.extra = true; },
      (o) => { o.winget.path = 'C:\\x'; },
      (o) => { o.errors.push({ step: 'x', code: 'y', message: 'z' }); },
    ];
    for (const mutate of mutations) {
      const o = readWire('business_present.json');
      mutate(o);
      expect(hpWarrantyObservationSchema.safeParse(o).success, mutate.toString()).toBe(false);
    }
  });

  it('refuses a value reported under a denied property name (deny beats allow)', () => {
    for (const name of ['SerialNumber', 'ProductNumber', 'SerialEndDate', 'CustomerType']) {
      const o = readWire('business_present.json');
      o.hpWarranty.rows[0][name] = 'X';
      expect(hpWarrantyObservationSchema.safeParse(o).success, name).toBe(false);
    }
  });

  it('refuses a date format for a denied property name', () => {
    const o = readWire('business_present.json');
    o.hpWarranty.dateFormats.SerialEndDate = 'iso8601';
    expect(hpWarrantyObservationSchema.safeParse(o).success).toBe(false);
  });

  it('bounds lists and strings', () => {
    const mutations: Array<(o: any) => void> = [
      (o) => { o.model = 'x'.repeat(65); },
      (o) => { o.model = 'line\nbreak'; },
      (o) => { o.hpWarranty.rows[0].Status = 'x'.repeat(65); },
      (o) => { o.hpWarranty.rows = Array.from({ length: 26 }, () => ({ Status: 'A' })); },
      (o) => { o.classes.names = Array.from({ length: 33 }, (_, i) => `C${i}`); },
      (o) => { o.hpWarranty.properties = Array.from({ length: 65 }, (_, i) => ({ name: `P${i}`, cimType: 'String' })); },
      (o) => { o.cmsl = Array.from({ length: 17 }, () => ({ name: 'HPCMSL', versions: [] })); },
      (o) => { o.conflicts = Array.from({ length: 5 }, () => ({ name: 'hp_insights', version: null })); },
      (o) => { o.errors = Array.from({ length: 17 }, () => ({ step: 'x', code: 'y' })); },
    ];
    for (const mutate of mutations) {
      const o = readWire('business_present.json');
      mutate(o);
      expect(hpWarrantyObservationSchema.safeParse(o).success, mutate.toString()).toBe(false);
    }
  });

  it('requires v-prefixed versions, so the log redactor cannot read one as an IPv4 address', () => {
    const o = readWire('consumer_absent.json');
    o.conflicts[0].version = '9.30.37.0';
    expect(hpWarrantyObservationSchema.safeParse(o).success).toBe(false);
  });

  it('accepts CIM type names with digits (UInt32, Real64, UInt8Array) and refuses others', () => {
    for (const cimType of ['UInt32', 'Real64', 'UInt8Array', 'SInt64']) {
      const o = readWire('business_present.json');
      o.hpWarranty.properties[0].cimType = cimType;
      expect(hpWarrantyObservationSchema.safeParse(o).success, cimType).toBe(true);
    }
    for (const cimType of ['9Bad', 'UInt 32', '', 'x'.repeat(25)]) {
      const o = readWire('business_present.json');
      o.hpWarranty.properties[0].cimType = cimType;
      expect(hpWarrantyObservationSchema.safeParse(o).success, cimType).toBe(false);
    }
  });

  it('accepts only HP module directory names for cmsl', () => {
    const o = readWire('business_present.json');
    o.cmsl[0].name = 'PSWindowsUpdate';
    expect(hpWarrantyObservationSchema.safeParse(o).success).toBe(false);
  });

  it('error codes are identifiers, never message text', () => {
    const o = readWire('consumer_absent.json');
    o.errors = [{ step: 'wmi', code: 'Access is denied.' }];
    expect(hpWarrantyObservationSchema.safeParse(o).success).toBe(false);
  });

  it(`refuses an observation over ${HP_WARRANTY_OBSERVE_MAX_BYTES} bytes`, () => {
    const o = readWire('business_present.json');
    const row = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`Status${i}`, 'x'.repeat(64)]));
    o.hpWarranty.rows = Array.from({ length: 25 }, () => row);
    expect(hpWarrantyObservationSchema.safeParse(o).success).toBe(false);
  });
});

describe('isHpWarrantyObservableName', () => {
  it.each(readWire('name_filter.json') as Array<{ name: string; allowed: boolean }>)(
    '$name → $allowed',
    ({ name, allowed }) => {
      expect(isHpWarrantyObservableName(name)).toBe(allowed);
    },
  );
});

describe('sanitizeHpWarrantyObserveFields', () => {
  it('keeps the component and the parsed observation, dropping every other key', () => {
    const observation = readWire('consumer_absent.json');
    const out = sanitizeHpWarrantyObserveFields({ component: HP_WARRANTY_OBSERVE_COMPONENT, observation, hostname: 'PC-1' });
    expect(out).toEqual({ component: HP_WARRANTY_OBSERVE_COMPONENT, observation });
  });

  it('replaces a record that fails the contract with a marker, keeping none of its contents', () => {
    const observation = readWire('business_present.json');
    observation.hpWarranty.rows[0].SerialNumber = '5CD1234XYZ';
    const out = sanitizeHpWarrantyObserveFields({ component: HP_WARRANTY_OBSERVE_COMPONENT, observation });
    expect(out).toEqual({ component: HP_WARRANTY_OBSERVE_COMPONENT, observationRejected: 'contract' });
    expect(JSON.stringify(out)).not.toContain('5CD1234XYZ');
  });

  it('marks a record with no observation at all', () => {
    expect(sanitizeHpWarrantyObserveFields(undefined)).toEqual({
      component: HP_WARRANTY_OBSERVE_COMPONENT,
      observationRejected: 'contract',
    });
  });
});
