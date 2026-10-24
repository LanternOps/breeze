import { describe, expect, it } from 'vitest';
import {
  buildComplianceDeviceRows,
  devicePercent,
  pageComplianceDevices,
  summarizeComplianceDevices,
  type ComplianceDeviceDetail,
  type NeedingDevice,
} from './complianceDevices';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '99999999-9999-4999-8999-999999999999';

const detail = (id: string, over: Partial<ComplianceDeviceDetail> = {}): ComplianceDeviceDetail => ({
  id,
  hostname: `host-${id}`,
  displayName: null,
  osType: 'windows',
  lastSeenAt: null,
  status: 'online',
  orgId: ORG_A,
  pendingReboot: false,
  ...over,
});

const needing = (id: string, over: Partial<NeedingDevice> = {}): NeedingDevice => ({
  id,
  name: `host-${id}`,
  os: 'windows',
  missingCount: 1,
  approvedMissing: 1,
  unapprovedMissing: 0,
  failedMissing: 0,
  criticalCount: 0,
  importantCount: 0,
  osMissing: 1,
  thirdPartyMissing: 0,
  lastInstalledAt: undefined,
  pendingReboot: false,
  lastScannedAt: undefined,
  lastSeen: undefined,
  ...over,
});

// a: compliant, reboot pending. b: 3 pending, 1 critical. c: 2 pending, 1 failed,
// 1 third-party (other org). d: compliant. e: stale image only.
function fixture() {
  const details = [
    detail('a', { pendingReboot: true, displayName: 'Front Desk' }),
    detail('b'),
    detail('c', { orgId: ORG_B }),
    detail('d'),
    detail('e'),
  ];
  const need = new Map<string, NeedingDevice>([
    ['b', needing('b', { missingCount: 3, approvedMissing: 3, criticalCount: 1 })],
    ['c', needing('c', { missingCount: 2, approvedMissing: 1, failedMissing: 1, thirdPartyMissing: 1 })],
    ['e', needing('e', { missingCount: 0, approvedMissing: 0, osMissing: 0, staleImages: 1 })],
  ]);
  return buildComplianceDeviceRows(details, need);
}

describe('devicePercent', () => {
  it('is 0 for an empty fleet, never NaN', () => {
    expect(devicePercent(0, 0)).toBe(0);
  });
  it('rounds compliant over total', () => {
    expect(devicePercent(2, 3)).toBe(67);
    expect(devicePercent(5, 5)).toBe(100);
  });
});

describe('buildComplianceDeviceRows', () => {
  it('builds one row per counted device, carrying orgId and the DevicePatchRow fields', () => {
    const rows = fixture();
    expect(rows).toHaveLength(5);
    const c = rows.find((r) => r.id === 'c')!;
    expect(c).toMatchObject({
      id: 'c',
      hostname: 'host-c',
      osType: 'windows',
      status: 'online',
      orgId: ORG_B,
      pendingPatches: 2,
      approvedMissing: 1,
      failedMissing: 1,
      thirdPartyMissing: 1,
      compliant: false,
    });
    const a = rows.find((r) => r.id === 'a')!;
    expect(a).toMatchObject({ compliant: true, pendingPatches: 0, pendingReboot: true, displayName: 'Front Desk' });
    expect(rows.find((r) => r.id === 'e')).toMatchObject({ compliant: false, pendingPatches: 0, staleImages: 1 });
  });

  it('sorts critical desc, pending desc, non-compliant first, then id', () => {
    expect(fixture().map((r) => r.id)).toEqual(['b', 'c', 'e', 'a', 'd']);
  });
});

describe('summarizeComplianceDevices', () => {
  it('counts every status and totals outstanding patches', () => {
    const s = summarizeComplianceDevices(fixture());
    expect(s.deviceCounts).toEqual({
      all: 5,
      compliant: 2,
      needsPatches: 3,
      failed: 1,
      critical: 1,
      reboot: 1,
      thirdParty: 1,
    });
    expect(s.outstandingTotals).toEqual({ patches: 5, approved: 4, unapproved: 0, failed: 1, critical: 1 });
  });
});

describe('pageComplianceDevices', () => {
  it('status=compliant returns only compliant rows', () => {
    const page = pageComplianceDevices(fixture(), { status: 'compliant', limit: 50, offset: 0 });
    expect(page.devices.map((r) => r.id)).toEqual(['a', 'd']);
    expect(page.devices.every((r) => r.compliant)).toBe(true);
    expect(page.total).toBe(2);
  });

  it.each([
    ['needs-patches', ['b', 'c', 'e']],
    ['failed', ['c']],
    ['critical', ['b']],
    ['reboot', ['a']],
    ['third-party', ['c']],
    ['all', ['b', 'c', 'e', 'a', 'd']],
  ] as const)('status=%s selects its rows', (status, ids) => {
    expect(pageComplianceDevices(fixture(), { status, limit: 50, offset: 0 }).devices.map((r) => r.id)).toEqual(ids);
  });

  it('compliant + needs-patches page totals add up to totalDevices', () => {
    const rows = fixture();
    const compliant = pageComplianceDevices(rows, { status: 'compliant', limit: 1, offset: 0 }).total;
    const needs = pageComplianceDevices(rows, { status: 'needs-patches', limit: 1, offset: 0 }).total;
    expect(compliant + needs).toBe(rows.length);
  });

  it('pages with limit/offset and reports the filtered total', () => {
    const page = pageComplianceDevices(fixture(), { status: 'all', limit: 2, offset: 2 });
    expect(page.devices.map((r) => r.id)).toEqual(['e', 'a']);
    expect(page.total).toBe(5);
  });

  it('search matches hostname or display name, case-insensitively, and narrows the total', () => {
    expect(pageComplianceDevices(fixture(), { status: 'all', search: 'FRONT', limit: 50, offset: 0 }).devices.map((r) => r.id)).toEqual(['a']);
    const byHost = pageComplianceDevices(fixture(), { status: 'all', search: 'host-c', limit: 50, offset: 0 });
    expect(byHost.devices.map((r) => r.id)).toEqual(['c']);
    expect(byHost.total).toBe(1);
  });

  it('combines status and search, and the total is the combined count', () => {
    const page = pageComplianceDevices(fixture(), { status: 'needs-patches', search: 'HOST-', limit: 1, offset: 1 });
    expect(page.total).toBe(3);
    expect(page.devices.map((r) => r.id)).toEqual(['c']);
    expect(pageComplianceDevices(fixture(), { status: 'compliant', search: 'host-b', limit: 50, offset: 0 }).total).toBe(0);
  });

  it('an offset past the filtered total returns an empty page with the real total', () => {
    const page = pageComplianceDevices(fixture(), { status: 'all', limit: 2, offset: 10 });
    expect(page.devices).toEqual([]);
    expect(page.total).toBe(5);
  });

  it('treats search text literally (no wildcard semantics)', () => {
    expect(pageComplianceDevices(fixture(), { status: 'all', search: '%', limit: 50, offset: 0 }).total).toBe(0);
    expect(pageComplianceDevices(fixture(), { status: 'all', search: 'host_', limit: 50, offset: 0 }).total).toBe(0);
  });
});
