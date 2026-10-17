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
});
