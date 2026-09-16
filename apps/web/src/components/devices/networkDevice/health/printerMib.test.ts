import { describe, expect, it } from 'vitest';
import {
  decodeErrorState,
  groupSupplies,
  lowestSupply,
  PRINTER_OIDS,
  readPageCount,
  readStatusWords,
  summariseDeltas,
} from './printerMib';
import type { Collection } from '../types';

import { walkOid, xeroxCollection as xerox } from './printerMib.fixtures';

describe('groupSupplies', () => {
  it('joins the four supply OIDs by instance index, not array position', () => {
    const supplies = groupSupplies(xerox);
    expect(supplies).toHaveLength(5);
    const cyan = supplies.find((s) => s.instance === '1.1')!;
    expect(cyan.description).toBe('Cyan Toner Cartridge');
    expect(cyan.colorant).toBe('cyan');
    expect(cyan.level).toBe(37);
    expect(cyan.maxCapacity).toBe(100);
    expect(cyan.percent).toBe(37);
    expect(cyan.unknown).toBe(false);
  });

  it('treats any negative level or capacity as unknown, never as a percentage', () => {
    const waste = groupSupplies(xerox).find((s) => s.instance === '1.5')!;
    expect(waste.unknown).toBe(true);
    expect(waste.percent).toBeNull();
    // -3 is RFC 3805's "some remaining"; it is still not a number to draw.
    expect(waste.level).toBe(-3);
  });

  it('returns [] when the supply OIDs were never collected', () => {
    expect(groupSupplies({ ...xerox, oids: [] })).toEqual([]);
    expect(groupSupplies(null)).toEqual([]);
  });
});

describe('lowestSupply', () => {
  it('picks the lowest KNOWN supply', () => {
    expect(lowestSupply(xerox)!.instance).toBe('1.1');
  });

  it('returns null when every supply is unknown', () => {
    const allUnknown: Collection = {
      ...xerox,
      oids: [
        walkOid(PRINTER_OIDS.suppliesDescription, 'prtMarkerSuppliesDescription', [['1.1', 'Drum']]),
        walkOid(PRINTER_OIDS.suppliesLevel, 'prtMarkerSuppliesLevel', [['1.1', '-2']]),
      ],
    };
    expect(lowestSupply(allUnknown)).toBeNull();
  });
});

describe('readPageCount', () => {
  it('reads the lifetime count and its instance OID', () => {
    expect(readPageCount(xerox)).toEqual({
      instanceOid: `${PRINTER_OIDS.lifeCount}.1.1`,
      value: 184230,
    });
  });

  it('returns null when the OID is unsupported on this printer', () => {
    expect(readPageCount({ ...xerox, oids: xerox.oids.filter((o) => o.baseOid !== PRINTER_OIDS.lifeCount) })).toBeNull();
  });
});

describe('decodeErrorState', () => {
  it('decodes a hex bitmask, MSB-first per RFC 3805 BITS', () => {
    // 0x80 = bit 0 = lowPaper
    expect(decodeErrorState('0x80')).toEqual(['lowPaper']);
    // 0x24 = bits 2 and 5 = lowToner + jammed
    expect(decodeErrorState('0x24')).toEqual(['lowToner', 'jammed']);
    // Second byte: 0x0020 -> bit 10 = markerSupplyMissing
    expect(decodeErrorState('0x0020')).toEqual(['markerSupplyMissing']);
  });

  it('accepts spaced hex and a bare decimal byte', () => {
    expect(decodeErrorState('24 00')).toEqual(['lowToner', 'jammed']);
    expect(decodeErrorState('128')).toEqual(['lowPaper']);
  });

  it('returns [] for no errors, an empty value, or an unparseable one', () => {
    expect(decodeErrorState('0x00')).toEqual([]);
    expect(decodeErrorState('')).toEqual([]);
    expect(decodeErrorState(null)).toEqual([]);
    expect(decodeErrorState('not-a-bitmask')).toEqual([]);
  });
});

describe('readStatusWords', () => {
  it('decodes both status enums and the error bits', () => {
    expect(readStatusWords(xerox)).toEqual({
      printerStatus: 'idle',
      deviceStatus: 'warning',
      errors: ['markerSupplyMissing'],
    });
  });

  it('returns nulls, not guesses, when the status OIDs were not collected', () => {
    expect(readStatusWords({ ...xerox, oids: [] })).toEqual({
      printerStatus: null,
      deviceStatus: null,
      errors: [],
    });
  });
});

describe('summariseDeltas', () => {
  it('reads yesterday from the last bucket and last week from the last seven', () => {
    const points: Array<[string, number]> = [
      ['2026-09-08', 100], ['2026-09-09', 90], ['2026-09-10', 80], ['2026-09-11', 70],
      ['2026-09-12', 60], ['2026-09-13', 50], ['2026-09-14', 40], ['2026-09-15', 30],
    ];
    expect(summariseDeltas(points)).toEqual({ yesterday: 30, lastWeek: 420 });
  });

  it('returns nulls when there is not enough history to claim either number', () => {
    expect(summariseDeltas([])).toEqual({ yesterday: null, lastWeek: null });
    expect(summariseDeltas([['2026-09-15', 30]])).toEqual({ yesterday: 30, lastWeek: null });
  });
});
