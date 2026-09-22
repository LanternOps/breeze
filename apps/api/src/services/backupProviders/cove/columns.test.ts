import { describe, it, expect } from 'vitest';
import {
  COVE_STATISTIC_COLUMNS,
  coveRowToVendorDevice,
  coveUnixToDate,
  mapCoveAccountType,
  mapCoveOsType,
  mapCoveSessionStatus,
  parseCoveDataSources,
  parseCoveMacAddresses,
  parseCoveSettings,
} from './columns';

describe('COVE_STATISTIC_COLUMNS', () => {
  it('requests exactly the 18 documented codes, with no duplicates', () => {
    expect(COVE_STATISTIC_COLUMNS).toEqual([
      'I0', 'I1', 'I8', 'I14', 'I16', 'I17', 'I18', 'I21', 'I32', 'I59', 'I78',
      'D09F00', 'D09F06', 'D09F07', 'D09F08', 'D09F09', 'D09F15', 'D09F18',
    ]);
    expect(new Set(COVE_STATISTIC_COLUMNS).size).toBe(COVE_STATISTIC_COLUMNS.length);
  });
});

describe('parseCoveSettings', () => {
  it('flattens the array of single-key objects into one map', () => {
    expect(parseCoveSettings([{ I0: '1001' }, { I1: 'SRV-FS01' }, { D09F00: '5' }]))
      .toEqual({ I0: '1001', I1: 'SRV-FS01', D09F00: '5' });
  });

  it('tolerates multi-key entries, nulls and non-objects without throwing', () => {
    expect(parseCoveSettings([{ I0: '1', I1: 'a' }, null as never, 'x' as never, { I8: 'Acme' }]))
      .toEqual({ I0: '1', I1: 'a', I8: 'Acme' });
  });

  it('returns an empty map for an absent or empty Settings array', () => {
    expect(parseCoveSettings([])).toEqual({});
    expect(parseCoveSettings(undefined as never)).toEqual({});
  });

  it('lets a later duplicate key win, so a re-sent column is not silently the old value', () => {
    expect(parseCoveSettings([{ I1: 'old' }, { I1: 'new' }])).toEqual({ I1: 'new' });
  });
});

describe('mapCoveSessionStatus', () => {
  it.each([
    [1, 'in_progress'],   // InProcess
    [2, 'failed'],        // Failed
    [3, 'interrupted'],   // Aborted
    [5, 'completed'],     // Completed
    [6, 'interrupted'],   // Interrupted
    [7, 'not_started'],   // NotStarted
    [8, 'completed_with_errors'], // CompletedWithErrors
    [9, 'in_progress'],   // InProgressWithFaults — faults ride on errorsCount
    [10, 'over_quota'],   // OverQuota
    [11, 'no_selection'], // NoSelection
    [12, 'in_progress'],  // Restarted
  ] as const)('maps F00 code %i to %s', (code, expected) => {
    expect(mapCoveSessionStatus(code)).toBe(expected);
  });

  it('treats an ABSENT D09F00 as no_backups, not unknown', () => {
    // A device Cove knows about that has never run is a real, actionable state
    // ("no backups recorded"), not a gap in our mapping.
    expect(mapCoveSessionStatus(undefined)).toBe('no_backups');
    expect(mapCoveSessionStatus(null)).toBe('no_backups');
  });

  it('treats an UNRECOGNISED code as unknown, not as a failure', () => {
    // A new vendor code must never be rendered as green or as red; `unknown`
    // is what makes the gap visible.
    expect(mapCoveSessionStatus(4)).toBe('unknown');
    expect(mapCoveSessionStatus(13)).toBe('unknown');
    expect(mapCoveSessionStatus(0)).toBe('unknown');
    expect(mapCoveSessionStatus(Number.NaN)).toBe('unknown');
  });

  it('covers every code the spec documents', () => {
    const documented = [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12];
    for (const code of documented) expect(mapCoveSessionStatus(code)).not.toBe('unknown');
  });
});

describe('mapCoveOsType / mapCoveAccountType', () => {
  it.each([
    ['1', 'workstation'], [1, 'workstation'],
    ['2', 'server'], [2, 'server'],
    ['0', 'unknown'], [0, 'unknown'],
    [undefined, 'unknown'], [null, 'unknown'], ['', 'unknown'], ['x', 'unknown'], [99, 'unknown'],
  ] as const)('mapCoveOsType(%p) -> %s', (input, expected) => {
    expect(mapCoveOsType(input)).toBe(expected);
  });

  it.each([
    ['1', 'backup_manager'], [1, 'backup_manager'],
    ['2', 'm365'], [2, 'm365'],
    ['0', 'unknown'], [undefined, 'unknown'], [null, 'unknown'], ['x', 'unknown'], [7, 'unknown'],
  ] as const)('mapCoveAccountType(%p) -> %s', (input, expected) => {
    expect(mapCoveAccountType(input)).toBe(expected);
  });
});

describe('parseCoveDataSources', () => {
  it('splits the concatenated 3-char codes and normalizes each one', () => {
    expect(parseCoveDataSources('D01D02D10')).toEqual(['files', 'system_state', 'mssql']);
  });

  it('maps every documented code', () => {
    expect(parseCoveDataSources('D01')).toEqual(['files']);
    expect(parseCoveDataSources('D02')).toEqual(['system_state']);
    expect(parseCoveDataSources('D05')).toEqual(['m365_sharepoint']);
    expect(parseCoveDataSources('D08')).toEqual(['vmware']);
    expect(parseCoveDataSources('D10')).toEqual(['mssql']);
    expect(parseCoveDataSources('D14')).toEqual(['hyperv']);
    expect(parseCoveDataSources('D17')).toEqual(['bare_metal']);
    expect(parseCoveDataSources('D19')).toEqual(['m365_exchange']);
    expect(parseCoveDataSources('D20')).toEqual(['m365_onedrive']);
    expect(parseCoveDataSources('D23')).toEqual(['m365_teams']);
  });

  it('normalizes an UNDOCUMENTED code to `other` exactly once, never dropping the row', () => {
    expect(parseCoveDataSources('D01D99D98')).toEqual(['files', 'other']);
  });

  it('is empty for null, undefined, empty and a ragged tail', () => {
    expect(parseCoveDataSources(null)).toEqual([]);
    expect(parseCoveDataSources(undefined)).toEqual([]);
    expect(parseCoveDataSources('')).toEqual([]);
    // A trailing partial chunk is dropped rather than mis-decoded.
    expect(parseCoveDataSources('D01D')).toEqual(['files']);
  });

  it('de-duplicates and preserves first-seen order', () => {
    expect(parseCoveDataSources('D01D02D01')).toEqual(['files', 'system_state']);
  });

  it('is case-insensitive on the code letter', () => {
    expect(parseCoveDataSources('d01d02')).toEqual(['files', 'system_state']);
  });
});

describe('parseCoveMacAddresses', () => {
  it('lower-cases and colon-separates, accepting hyphen and dot forms', () => {
    expect(parseCoveMacAddresses('00-11-22-AA-BB-CC')).toEqual(['00:11:22:aa:bb:cc']);
    expect(parseCoveMacAddresses('0011.22AA.BBCC')).toEqual(['00:11:22:aa:bb:cc']);
    expect(parseCoveMacAddresses('00:11:22:aa:bb:cc')).toEqual(['00:11:22:aa:bb:cc']);
  });

  it('splits a multi-NIC value on comma, semicolon and whitespace, de-duplicating', () => {
    expect(parseCoveMacAddresses('00-11-22-AA-BB-CC, 00:11:22:aa:bb:cc; DE-AD-BE-EF-00-01'))
      .toEqual(['00:11:22:aa:bb:cc', 'de:ad:be:ef:00:01']);
  });

  it('drops the all-zero placeholder and anything that is not a MAC', () => {
    // A Cove agent on a host with no resolvable NIC reports 00:00:00:00:00:00;
    // matching devices on it would link every such host to the same Breeze
    // device.
    expect(parseCoveMacAddresses('00-00-00-00-00-00')).toEqual([]);
    expect(parseCoveMacAddresses('not-a-mac')).toEqual([]);
    expect(parseCoveMacAddresses(null)).toEqual([]);
    expect(parseCoveMacAddresses('')).toEqual([]);
  });
});

describe('coveUnixToDate', () => {
  it('converts Unix SECONDS (number or string) to a Date', () => {
    expect(coveUnixToDate(1_789_000_000)?.toISOString()).toBe(new Date(1_789_000_000_000).toISOString());
    expect(coveUnixToDate('1789000000')?.toISOString()).toBe(new Date(1_789_000_000_000).toISOString());
  });

  it('treats 0, negative, empty, null and non-numeric as "never"', () => {
    // Cove sends 0 for "no such session"; a naive conversion would claim a
    // backup succeeded in 1970 and make the device read as merely stale.
    expect(coveUnixToDate(0)).toBeNull();
    expect(coveUnixToDate('0')).toBeNull();
    expect(coveUnixToDate(-1)).toBeNull();
    expect(coveUnixToDate('')).toBeNull();
    expect(coveUnixToDate(null)).toBeNull();
    expect(coveUnixToDate(undefined)).toBeNull();
    expect(coveUnixToDate('later')).toBeNull();
  });
});

describe('coveRowToVendorDevice', () => {
  const row = {
    AccountId: 1001,
    PartnerId: 2001,
    Settings: [
      { I0: '1001' },
      { I1: 'SRV-FS01' },
      { I8: 'Acme Corp' },
      { I14: '128849018880' },
      { I16: 'Windows Server 2022' },
      { I17: '23.5.0.1' },
      { I18: 'srv-fs01' },
      { I21: '00-11-22-AA-BB-CC' },
      { I32: '2' },
      { I59: '1' },
      { I78: 'D01D02D10' },
      { D09F00: '5' },
      { D09F06: '0' },
      { D09F07: '107374182400' },
      { D09F08: 'opaque-colour-bar' },
      { D09F09: '1789000000' },
      { D09F15: '1789003600' },
      { D09F18: '1789003600' },
    ],
  };

  it('projects a complete row onto VendorDevice', () => {
    const device = coveRowToVendorDevice(row);
    expect(device).toMatchObject({
      vendorDeviceId: '1001',
      vendorCustomerId: '2001',
      name: 'SRV-FS01',
      computerName: 'srv-fs01',
      osType: 'server',
      osVersion: 'Windows Server 2022',
      clientVersion: '23.5.0.1',
      macAddresses: ['00:11:22:aa:bb:cc'],
      accountType: 'backup_manager',
      dataSources: ['files', 'system_state', 'mssql'],
      status: 'completed',
      vendorStatusCode: 5,
      selectedBytes: 107_374_182_400,
      usedBytes: 128_849_018_880,
      errorsCount: 0,
    });
    expect(device.lastSuccessAt?.toISOString()).toBe(new Date(1_789_000_000_000).toISOString());
    expect(device.lastSessionAt?.toISOString()).toBe(new Date(1_789_003_600_000).toISOString());
    expect(device.lastCompletedAt?.toISOString()).toBe(new Date(1_789_003_600_000).toISOString());
    // Not derivable from any documented column in this call — see the DECISION.
    expect(device.vendorCreatedAt).toBeNull();
    expect(device.vendorExpiresAt).toBeNull();
  });

  it('keeps the whole parsed Settings map in `raw`, including the opaque colour bar', () => {
    const device = coveRowToVendorDevice(row);
    expect(device.raw).toMatchObject({ D09F08: 'opaque-colour-bar', I8: 'Acme Corp' });
  });

  it('reports no_backups with a null vendorStatusCode when D09F00 is absent', () => {
    const device = coveRowToVendorDevice({
      AccountId: 1002, PartnerId: 2001,
      Settings: [{ I1: 'NEW-LAPTOP' }, { I59: '1' }],
    });
    expect(device.status).toBe('no_backups');
    expect(device.vendorStatusCode).toBeNull();
    expect(device.lastSuccessAt).toBeNull();
    expect(device.errorsCount).toBe(0);
  });

  it('carries faults on errorsCount for an in-progress-with-faults row', () => {
    const device = coveRowToVendorDevice({
      AccountId: 1003, PartnerId: 2001,
      Settings: [{ I1: 'WKS-04' }, { D09F00: '9' }, { D09F06: '4' }],
    });
    expect(device.status).toBe('in_progress');
    expect(device.errorsCount).toBe(4);
  });

  it('marks an M365 account and gives it no computer identity to match on', () => {
    const device = coveRowToVendorDevice({
      AccountId: 1004, PartnerId: 2001,
      Settings: [{ I1: 'acme.onmicrosoft.com' }, { I59: '2' }, { I78: 'D19D20' }, { D09F00: '5' }],
    });
    expect(device.accountType).toBe('m365');
    expect(device.computerName).toBeNull();
    expect(device.macAddresses).toEqual([]);
    expect(device.dataSources).toEqual(['m365_exchange', 'm365_onedrive']);
  });

  it('falls back to I0 for the id and to the id for the name when I1 is absent', () => {
    const device = coveRowToVendorDevice({ AccountId: null, PartnerId: 2001, Settings: [{ I0: '1005' }] });
    expect(device.vendorDeviceId).toBe('1005');
    expect(device.name).toBe('1005');
  });

  it('throws rather than emitting a row with no identity', () => {
    // A row we cannot key would upsert under a blank vendor_device_id and
    // collide with every other identity-less row on
    // (connection_id, vendor_device_id).
    expect(() => coveRowToVendorDevice({ AccountId: null, PartnerId: 2001, Settings: [] }))
      .toThrow(/AccountId/);
    expect(() => coveRowToVendorDevice({ AccountId: 1006, PartnerId: null, Settings: [] }))
      .toThrow(/PartnerId/);
  });
});
