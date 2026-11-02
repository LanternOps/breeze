import { describe, expect, it } from 'vitest';

import { csvRow } from '../../lib/csvExport';
import { buildDevicesCsv, devicesCsvFilename, exportColumns, formatAttentionForCsv } from './deviceCsvExport';
import type { ColumnId } from './columnVisibility';
import type { Device } from './DeviceList';

const base: Device = {
  id: 'd1',
  deviceClass: 'agent',
  hostname: 'web-01',
  os: 'windows',
  osVersion: '11',
  status: 'online',
  cpuPercent: 0,
  ramPercent: 0,
  lastSeen: '2026-10-01T12:00:00Z',
  orgId: 'o',
  orgName: 'Acme',
  siteId: 's',
  siteName: 'HQ',
  agentVersion: '0.1.0',
  tags: ['a', 'b'],
};
const dev = (o: Partial<Device>): Device => ({ ...base, ...o });
const build = (devices: Device[], columns: ColumnId[]) =>
  buildDevicesCsv({ devices, columns, customFieldDefs: [], statusLabel: (d) => d.status });
const rows = (csv: string) => csv.split('\n');

describe('deviceCsvExport (#9726)', () => {
  it('forces hostname first and keeps the given order', () => {
    expect(exportColumns(['site', 'hostname', 'status'])).toEqual(['hostname', 'site', 'status']);
    expect(exportColumns(['site'])).toEqual(['hostname', 'site']);
  });

  it('puts units in numeric headers and keeps 0 as 0, not blank', () => {
    const csv = build(
      [dev({ cpuPercent: 0, hardware: { cpuCores: 0, ramTotalMb: 16384, diskTotalGb: 512 }, uptimeSeconds: 90 })],
      ['cpu', 'cores', 'ramTotal', 'diskTotal', 'uptime'],
    );
    expect(rows(csv)).toEqual([
      csvRow(['Device', 'CPU %', 'Cores', 'RAM (MB)', 'Disk (GB)', 'Uptime (s)']),
      csvRow(['web-01', '0', '0', '16384', '512', '90']),
    ]);
  });

  it('blanks cpu/uptime for offline agents and for non-agent rows', () => {
    const csv = build(
      [dev({ status: 'offline', cpuPercent: 50, uptimeSeconds: 5 }), dev({ deviceClass: 'network', cpuPercent: 0 })],
      ['cpu', 'uptime'],
    );
    expect(rows(csv).slice(1)).toEqual([csvRow(['web-01', '', '']), csvRow(['web-01', '', ''])]);
  });

  it('gates serial / asset tag / location / source by device class', () => {
    const agent = dev({ hardware: { serialNumber: 'AG-1' }, assetTag: 'leak', location: 'leak', source: 'scan' });
    const manual = dev({ deviceClass: 'manual', serialNumber: 'M-1', assetTag: 'T-9', location: 'Rack 2' });
    const network = dev({ deviceClass: 'network', source: 'unifi', hardware: { serialNumber: 'leak' } });
    const csv = build([agent, manual, network], ['serial', 'assetTag', 'location', 'source']);
    expect(rows(csv).slice(1)).toEqual([
      csvRow(['web-01', 'AG-1', '', '', '']),
      csvRow(['web-01', 'M-1', 'T-9', 'Rack 2', '']),
      csvRow(['web-01', '', '', '', 'unifi']),
    ]);
  });

  it('exports dates as ISO and blanks missing or unparsable ones', () => {
    const csv = build(
      [dev({ lastSeen: '2026-10-01T12:00:00Z', enrolledAt: undefined }), dev({ lastSeen: 'garbage', enrolledAt: '2026-01-02T03:04:05Z' })],
      ['lastSeen', 'enrolled'],
    );
    expect(rows(csv).slice(1)).toEqual([
      csvRow(['web-01', '2026-10-01T12:00:00.000Z', '']),
      csvRow(['web-01', '', '2026-01-02T03:04:05.000Z']),
    ]);
  });

  it('reduces the server URL to its hostname and joins tags', () => {
    const csv = build(
      [dev({ agentServerUrl: 'https://api.example.test:8443/x' }), dev({ agentServerUrl: 'not a url', tags: [] })],
      ['serverUrl', 'tags'],
    );
    expect(rows(csv).slice(1)).toEqual([csvRow(['web-01', 'api.example.test', 'a, b']), csvRow(['web-01', '', ''])]);
  });

  it('renders custom fields: dropdown label, boolean, array, empty', () => {
    const defs = [
      { fieldKey: 'tier', name: 'Tier', type: 'dropdown', options: { choices: [{ label: 'Gold', value: 'g' }] } },
      { fieldKey: 'ok', name: 'OK', type: 'boolean' },
      { fieldKey: 'list', name: 'List', type: 'text' },
      { fieldKey: 'none', name: 'None', type: 'text' },
    ];
    const csv = buildDevicesCsv({
      devices: [dev({ customFields: { tier: 'g', ok: true, list: ['x', 'y'], none: '' } })],
      columns: [],
      customFieldDefs: defs,
      statusLabel: () => '',
    });
    expect(rows(csv)).toEqual([csvRow(['Device', 'Tier', 'OK', 'List', 'None']), csvRow(['web-01', 'Gold', 'Yes', 'x, y', ''])]);
  });

  it('formats attention: counts, nothing open, failed', () => {
    const zero = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    expect(formatAttentionForCsv({ alerts: { ...zero, critical: 2, low: 1 }, tickets: 3 })).toBe(
      'alerts: critical 2, low 1; tickets: 3',
    );
    expect(formatAttentionForCsv(null)).toBe('');
    expect(formatAttentionForCsv({ alerts: zero, tickets: 0 })).toBe('');
    expect(formatAttentionForCsv('failed')).toBe('unavailable');
  });

  it('neutralises formula prefixes in every cell, header included', () => {
    const csv = build([dev({ hostname: '@cmd', siteName: '+1', orgName: '-x' })], ['site', 'organization']);
    expect(rows(csv)[1]).toBe(csvRow(["'@cmd", "'+1", "'-x"]));
  });

  it('names the file by date', () => {
    expect(devicesCsvFilename(new Date('2026-10-22T23:59:00Z'))).toBe('devices-2026-10-22.csv');
  });
});
