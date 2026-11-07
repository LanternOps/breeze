import { describe, expect, it } from 'vitest';
import '@/lib/i18n';
import { toDeviceListRow } from './deviceRowTransform';

const RAW = {
  id: 'd1',
  hostname: 'acme-laptop-01',
  osType: 'windows',
  osVersion: '11',
  status: 'online',
  cpuPercent: 37.456789012,
  ramPercent: 61.04,
  lastSeenAt: '2026-09-01T00:00:00.000Z',
  orgId: 'org-1',
  siteId: 'site-1',
  agentVersion: '1.0.0',
  tags: ['vip'],
};

describe('toDeviceListRow', () => {
  it('maps a raw /devices row to the DeviceList shape with rounded percents', () => {
    const row = toDeviceListRow(RAW);
    expect(row.os).toBe('windows');
    expect(row.lastSeen).toBe(RAW.lastSeenAt);
    expect(row.cpuPercent).toBe(37.5);
    expect(row.ramPercent).toBe(61);
    expect(row.siteName).toBe('');
    expect(row.orgName).toBe('');
    expect(row.pendingReboot).toBe(false);
    expect(row.linkGroupRole).toBeNull();
    expect(row.tags).toEqual(['vip']);
  });

  it('carries the hardware serial number through', () => {
    const row = toDeviceListRow({ ...RAW, hardware: { serialNumber: 'TEST-SERIAL-01' } });
    expect(row.hardware?.serialNumber).toBe('TEST-SERIAL-01');
  });

  it.each([undefined, null, 42, false, {}])('ignores invalid hardware serial number %j', serialNumber => {
    const row = toDeviceListRow({ ...RAW, hardware: { serialNumber } });
    expect(row.hardware?.serialNumber).toBeUndefined();
  });

  it('carries the hardware product number through (#9593)', () => {
    const row = toDeviceListRow({ ...RAW, hardware: { productSku: '5S3F8EA#ABB' } });
    expect(row.hardware?.productSku).toBe('5S3F8EA#ABB');
  });

  it.each([undefined, null, 42, false, {}])('ignores an invalid hardware product number %j', productSku => {
    const row = toDeviceListRow({ ...RAW, hardware: { productSku } });
    expect(row.hardware?.productSku).toBeUndefined();
  });

  it('prefers nested metrics and clamps to 0–100', () => {
    expect(toDeviceListRow({ ...RAW, metrics: { cpuPercent: 250 }, cpuPercent: 5 }).cpuPercent).toBe(100);
  });

  it('coerces string and null percents', () => {
    expect(toDeviceListRow({ ...RAW, cpuPercent: '37.456789012' }).cpuPercent).toBe(37.5);
    expect(toDeviceListRow({ ...RAW, cpuPercent: null }).cpuPercent).toBe(0);
  });

  it('falls back to the Unknown label when hostname is missing', () => {
    expect(toDeviceListRow({ ...RAW, hostname: undefined }).hostname).toBe('Unknown');
  });

  // #9863 — Warranty column.
  it('carries the warranty end date and a known status through', () => {
    const row = toDeviceListRow({ ...RAW, warrantyEndDate: '2026-12-31', warrantyStatus: 'subscription_active' });
    expect(row.warrantyEndDate).toBe('2026-12-31');
    expect(row.warrantyStatus).toBe('subscription_active');
  });

  it('nulls missing or unrecognised warranty values', () => {
    expect(toDeviceListRow(RAW)).toMatchObject({ warrantyEndDate: null, warrantyStatus: null });
    expect(toDeviceListRow({ ...RAW, warrantyEndDate: 42, warrantyStatus: 'bogus' }))
      .toMatchObject({ warrantyEndDate: null, warrantyStatus: null });
  });
});
