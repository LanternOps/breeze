import { describe, expect, it } from 'vitest';
import {
  POLL_LIMITS,
  SLOW_CADENCE_EVERY,
  buildOidSpecs,
  includesSlowCadence,
  selectOidSpecsForSeq,
  type OidSpec,
} from './snmpOidSpecs';

/** The shipped built-in entry shape: {oid,name,type,description}, no mode/cadence. */
const SEED_ENTRIES = [
  { oid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime', type: 'timeticks', description: 'Uptime' },
  { oid: '1.3.6.1.2.1.43.11.1.1.9', name: 'prtMarkerSuppliesLevel', type: 'table', description: 'Level' },
  { oid: '1.3.6.1.2.1.31.1.1.1.6', name: 'ifHCInOctets', type: 'counter64', description: 'In octets' },
  { oid: '1.3.6.1.2.1.43.11.1.1.6', name: 'prtMarkerSuppliesDescription', type: 'string', description: 'Supply name' },
];

describe('buildOidSpecs — mode defaults from the OID, not from `type`', () => {
  it.each([
    ['1.3.6.1.2.1.1.3.0', 'get'],
    ['1.3.6.1.2.1.1.5.0', 'get'],
    ['1.3.6.1.2.1.43.11.1.1.9', 'walk'],
    ['1.3.6.1.2.1.2.2.1.2', 'walk'],
  ])('%s defaults to %s', (oid, mode) => {
    expect(buildOidSpecs([{ oid, name: 'x', type: 'table' }])[0]!.mode).toBe(mode);
  });

  it('walks counter64 and string columns, which `type` alone would misclassify', () => {
    const byName = Object.fromEntries(buildOidSpecs(SEED_ENTRIES).map((s) => [s.name, s]));
    expect(byName.sysUpTime!.mode).toBe('get');
    expect(byName.ifHCInOctets!.mode).toBe('walk');
    expect(byName.prtMarkerSuppliesDescription!.mode).toBe('walk');
    expect(byName.prtMarkerSuppliesLevel!.mode).toBe('walk');
  });

  it('defaults every seed entry to fast cadence', () => {
    expect(buildOidSpecs(SEED_ENTRIES).every((s) => s.cadence === 'fast')).toBe(true);
  });

  it('falls back to the OID as the name when the entry has none', () => {
    expect(buildOidSpecs([{ oid: '1.3.6.1.2.1.1.3.0' }])[0]).toEqual({
      oid: '1.3.6.1.2.1.1.3.0', name: '1.3.6.1.2.1.1.3.0', mode: 'get', cadence: 'fast',
    });
  });
});

describe('buildOidSpecs — explicit overrides win', () => {
  it('honours an explicit mode against the .0 default', () => {
    const specs = buildOidSpecs([
      { oid: '1.3.6.1.2.1.1.3.0', name: 'weird', mode: 'walk' },
      { oid: '1.3.6.1.2.1.2.2.1.2', name: 'ifDescr', mode: 'get' },
    ]);
    expect(specs.map((s) => s.mode)).toEqual(['walk', 'get']);
  });

  it('honours an explicit slow cadence', () => {
    expect(buildOidSpecs([{ oid: '1.3.6.1.2.1.2.2.1.2', name: 'ifDescr', cadence: 'slow' }])[0]!.cadence).toBe('slow');
  });

  it('ignores an unrecognised mode or cadence rather than shipping it to the agent', () => {
    const [spec] = buildOidSpecs([{ oid: '1.3.6.1.2.1.2.2.1.2', name: 'ifDescr', mode: 'bulk' as never, cadence: 'hourly' as never }]);
    expect(spec).toEqual({ oid: '1.3.6.1.2.1.2.2.1.2', name: 'ifDescr', mode: 'walk', cadence: 'fast' });
  });
});

describe('buildOidSpecs — junk input', () => {
  it.each([[null], [undefined], ['{}'], [42], [{}]])('returns [] for %p', (input) => {
    expect(buildOidSpecs(input)).toEqual([]);
  });

  it('drops entries with no usable oid and keeps the rest', () => {
    const specs = buildOidSpecs([
      { oid: '' }, { oid: '   ' }, { name: 'no oid' }, null, 'string-entry',
      { oid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime' },
    ]);
    expect(specs.map((s) => s.oid)).toEqual(['1.3.6.1.2.1.1.3.0']);
  });

  it('trims surrounding whitespace on the oid', () => {
    expect(buildOidSpecs([{ oid: ' 1.3.6.1.2.1.1.3.0 ', name: 'sysUpTime' }])[0]!.oid).toBe('1.3.6.1.2.1.1.3.0');
  });

  it('de-duplicates by oid, keeping the first entry — a duplicated walk doubles the row budget', () => {
    const specs = buildOidSpecs([
      { oid: '1.3.6.1.2.1.2.2.1.2', name: 'ifDescr' },
      { oid: '1.3.6.1.2.1.2.2.1.2', name: 'ifDescr-again' },
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.name).toBe('ifDescr');
  });
});

describe('cadence gating', () => {
  const specs: OidSpec[] = [
    { oid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime', mode: 'get', cadence: 'fast' },
    { oid: '1.3.6.1.2.1.2.2.1.2', name: 'ifDescr', mode: 'walk', cadence: 'slow' },
  ];

  it('includes slow specs on the very first poll (poll_seq 0)', () => {
    expect(includesSlowCadence(0)).toBe(true);
    expect(selectOidSpecsForSeq(specs, 0)).toEqual(specs);
  });

  it.each([1, 2, 5, 11, 13])('excludes slow specs on poll_seq %i', (seq) => {
    expect(selectOidSpecsForSeq(specs, seq).map((s) => s.name)).toEqual(['sysUpTime']);
  });

  it('includes slow specs again every SLOW_CADENCE_EVERY polls', () => {
    expect(SLOW_CADENCE_EVERY).toBe(12);
    for (const seq of [12, 24, 120]) expect(selectOidSpecsForSeq(specs, seq)).toEqual(specs);
  });

  it('falls back to the full set when nothing is fast, so an all-slow template never polls nothing', () => {
    const allSlow: OidSpec[] = [{ oid: '1.3.6.1.2.1.2.2.1.2', name: 'ifDescr', mode: 'walk', cadence: 'slow' }];
    expect(selectOidSpecsForSeq(allSlow, 5)).toEqual(allSlow);
  });

  it('treats a missing or nonsensical poll_seq as a slow poll rather than skipping data', () => {
    for (const seq of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(selectOidSpecsForSeq(specs, seq)).toEqual(specs);
    }
  });

  it('returns [] for [] without inventing work', () => {
    expect(selectOidSpecsForSeq([], 3)).toEqual([]);
  });
});

describe('POLL_LIMITS', () => {
  it('matches the values the plan index fixes', () => {
    expect(POLL_LIMITS).toEqual({ maxRowsPerOid: 512, maxRowsPerPoll: 4096, maxBytesPerPoll: 1048576, maxDurationMs: 20000 });
  });
});
