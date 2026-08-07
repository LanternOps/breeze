import { describe, expect, it } from 'vitest';
import { buildTopInterfaces, type SnmpInterfaceMetricRow } from './snmpDashboardTopInterfaces';

function row(data: Partial<SnmpInterfaceMetricRow> & Pick<SnmpInterfaceMetricRow, 'deviceId' | 'deviceName'>): SnmpInterfaceMetricRow {
  return {
    deviceId: data.deviceId,
    deviceName: data.deviceName,
    oid: data.oid ?? null,
    name: data.name ?? null,
    value: data.value ?? null,
    valueType: data.valueType ?? null,
    timestamp: data.timestamp ?? '2026-02-09T12:00:00.000Z'
  };
}

describe('snmp dashboard top interface aggregation', () => {
  it('ranks interfaces by calculated octet usage', () => {
    const rows: SnmpInterfaceMetricRow[] = [
      row({ deviceId: 'dev-a', deviceName: 'Core-1', oid: '1.3.6.1.2.1.2.2.1.10.1', value: '1000', timestamp: '2026-02-09T12:00:00.000Z' }),
      row({ deviceId: 'dev-a', deviceName: 'Core-1', oid: '1.3.6.1.2.1.2.2.1.10.1', value: '2500', timestamp: '2026-02-09T12:20:00.000Z' }),
      row({ deviceId: 'dev-a', deviceName: 'Core-1', oid: '1.3.6.1.2.1.2.2.1.16.1', value: '400', timestamp: '2026-02-09T12:00:00.000Z' }),
      row({ deviceId: 'dev-a', deviceName: 'Core-1', oid: '1.3.6.1.2.1.2.2.1.16.1', value: '900', timestamp: '2026-02-09T12:20:00.000Z' }),
      row({ deviceId: 'dev-b', deviceName: 'Dist-1', name: 'ifInOctets.2', value: '6000', timestamp: '2026-02-09T12:00:00.000Z' }),
      row({ deviceId: 'dev-b', deviceName: 'Dist-1', name: 'ifOutOctets.2', value: '7000', timestamp: '2026-02-09T12:00:00.000Z' })
    ];

    const top = buildTopInterfaces(rows, 5);
    expect(top).toHaveLength(2);

    expect(top[0]).toMatchObject({
      deviceId: 'dev-b',
      name: 'Dist-1 / ifIndex 2',
      inOctets: 6000,
      outOctets: 7000,
      totalOctets: 13000
    });

    expect(top[1]).toMatchObject({
      deviceId: 'dev-a',
      name: 'Core-1 / ifIndex 1',
      inOctets: 1500,
      outOctets: 500,
      totalOctets: 2000
    });
  });

  it('ignores non-interface metrics and invalid octet values', () => {
    const rows: SnmpInterfaceMetricRow[] = [
      row({ deviceId: 'dev-a', deviceName: 'Core-1', oid: '1.3.6.1.2.1.1.5.0', value: 'hostname-1' }),
      row({ deviceId: 'dev-a', deviceName: 'Core-1', oid: '1.3.6.1.2.1.2.2.1.10.4', value: '-1' }),
      row({ deviceId: 'dev-a', deviceName: 'Core-1', oid: '1.3.6.1.2.1.2.2.1.16.4', value: 'not-a-number' })
    ];

    const top = buildTopInterfaces(rows, 5);
    expect(top).toEqual([]);
  });

  // A hex-encoded octet-string is bytes, not a counter, but it can be
  // all-digits ('001122304050' parses as 1.12e11) and would then dominate the
  // ranking. It has to be rejected on value_type, not on the string's shape.
  it('excludes hex-encoded values even when they parse as huge numbers', () => {
    const rows: SnmpInterfaceMetricRow[] = [
      row({ deviceId: 'dev-a', deviceName: 'Core-1', oid: '1.3.6.1.2.1.2.2.1.10.1', value: '001122304050', valueType: 'hex' }),
      row({ deviceId: 'dev-a', deviceName: 'Core-1', oid: '1.3.6.1.2.1.2.2.1.16.1', value: '788a2000d4e1', valueType: 'hex' }),
      row({ deviceId: 'dev-b', deviceName: 'Dist-1', oid: '1.3.6.1.2.1.2.2.1.10.2', value: '2000', valueType: 'number' }),
      row({ deviceId: 'dev-b', deviceName: 'Dist-1', oid: '1.3.6.1.2.1.2.2.1.16.2', value: '3000', valueType: 'number' })
    ];

    const top = buildTopInterfaces(rows, 5);

    // The legitimate 5000-octet interface is the ONLY entry, and it ranks
    // first because the 1.12e11 impostor never entered the aggregation.
    expect(top).toEqual([
      {
        deviceId: 'dev-b',
        name: 'Dist-1 / ifIndex 2',
        inOctets: 2000,
        outOctets: 3000,
        totalOctets: 5000
      }
    ]);
  });

  it('keeps rows whose value_type is absent, null or any non-hex type', () => {
    const rows: SnmpInterfaceMetricRow[] = [
      // Legacy rows predating value_type, and ordinary typed rows, must survive.
      { deviceId: 'dev-a', deviceName: 'Core-1', oid: '1.3.6.1.2.1.2.2.1.10.1', name: null, value: '1000', timestamp: '2026-02-09T12:00:00.000Z' },
      row({ deviceId: 'dev-a', deviceName: 'Core-1', oid: '1.3.6.1.2.1.2.2.1.16.1', value: '500', valueType: null }),
      row({ deviceId: 'dev-c', deviceName: 'Edge-2', oid: '1.3.6.1.2.1.2.2.1.10.3', value: '70', valueType: 'string' })
    ];

    const top = buildTopInterfaces(rows, 5);

    expect(top.map((t) => [t.name, t.totalOctets])).toEqual([
      ['Core-1 / ifIndex 1', 1500],
      ['Edge-2 / ifIndex 3', 70]
    ]);
  });

  it('uses latest value when only one sample exists in the window', () => {
    const rows: SnmpInterfaceMetricRow[] = [
      row({ deviceId: 'dev-z', deviceName: 'Edge-1', oid: '1.3.6.1.2.1.2.2.1.10.10', value: '2000' }),
      row({ deviceId: 'dev-z', deviceName: 'Edge-1', oid: '1.3.6.1.2.1.2.2.1.16.10', value: '3000' })
    ];

    const top = buildTopInterfaces(rows, 5);
    expect(top).toEqual([
      {
        deviceId: 'dev-z',
        name: 'Edge-1 / ifIndex 10',
        inOctets: 2000,
        outOctets: 3000,
        totalOctets: 5000
      }
    ]);
  });
});
