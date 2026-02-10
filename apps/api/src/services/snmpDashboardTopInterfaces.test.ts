import { describe, expect, it } from 'vitest';
import { buildTopInterfaces, type SnmpInterfaceMetricRow } from './snmpDashboardTopInterfaces';

function row(data: Partial<SnmpInterfaceMetricRow> & Pick<SnmpInterfaceMetricRow, 'deviceId' | 'deviceName'>): SnmpInterfaceMetricRow {
  return {
    deviceId: data.deviceId,
    deviceName: data.deviceName,
    oid: data.oid ?? null,
    name: data.name ?? null,
    value: data.value ?? null,
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
