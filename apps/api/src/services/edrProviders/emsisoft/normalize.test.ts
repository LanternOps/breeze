import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EdrSeverity } from '@breeze/shared';
import type { EmsiDevice, EmsiDeviceDetails, EmsiIncident } from './client';
import {
  EMSI_MITIGATING_ACTIONS, EMSI_NON_MITIGATING_ACTIONS,
  deviceNameKey, detectionIdFor, incidentStatus, toEndpointDetail, toIncidentDetections, toStatusUpdate, toVendorEndpoint,
} from './normalize';

const fx = <T>(name: string): T => JSON.parse(readFileSync(join(__dirname, '__fixtures__', name), 'utf8')) as T;
const WS = '00000000-0000-4000-8000-0000000000b1';
const D1 = '00000000-0000-4000-8000-0000000000d1';
const D2 = '00000000-0000-4000-8000-0000000000d2';
const INC = '00000000-0000-4000-8000-0000000000c1';

const incident = (over: Partial<EmsiIncident> = {}): EmsiIncident => ({
  guid: INC, type: 'File', verdict: 'New', actionTaken: 'Remediated', actionsTaken: ['Remediated'], highestSeverity: 'Malicious',
  lastDetectionAt: '2026-10-20T07:00:00Z', detectionComponent: 'FileGuard', involvedDevices: ['PC01'], involvedDeviceUsers: ['user1'],
  sha1: 'da39a3ee5e6b4b0d3255bfef95601890afd80709', sha256: 'abc', knownFileNames: ['eicar.example.test.com'], hostAddress: null,
  detailsPageLink: 'https://console.example.test/incident/c1', ...over,
});
const index = (entries: Array<[string, string | null]>) => new Map(entries);

describe('deviceNameKey', () => {
  it('trims, strips ONE trailing dot, lower-cases, keeps the FULL name', () => {
    expect(deviceNameKey('  PC01 ')).toBe('pc01');
    expect(deviceNameKey('PC01.')).toBe('pc01');
    expect(deviceNameKey('PC01..')).toBe('pc01.');
    expect(deviceNameKey('Pc01.Corp.Example.Test.')).toBe('pc01.corp.example.test');
    expect(deviceNameKey('')).toBeNull();
    expect(deviceNameKey('   ')).toBeNull();
    expect(deviceNameKey(null)).toBeNull();
    expect(deviceNameKey(undefined)).toBeNull();
  });
});

describe('incidentStatus', () => {
  const s = (verdict: string | null | undefined, actionTaken?: string | null, actionsTaken?: string[] | null) =>
    incidentStatus({ verdict, actionTaken, actionsTaken });

  it('ConfirmedBenign -> false_positive whatever the actions', () => {
    for (const a of [undefined, 'None', 'Remediated', 'Allowed']) expect(s('ConfirmedBenign', a)).toBe('false_positive');
  });
  it('InInvestigation -> in_progress whatever the actions', () => {
    for (const a of [undefined, 'None', 'Remediated']) expect(s('InInvestigation', a)).toBe('in_progress');
  });
  it('New / ConfirmedMalicious with a mitigating action and no contradicting entry -> mitigated', () => {
    for (const verdict of ['New', 'ConfirmedMalicious']) {
      for (const a of ['Remediated', 'Deleted', 'Blocked', 'Isolated', 'RollbackCompleted']) {
        expect(s(verdict, a, [a])).toBe('mitigated');
        expect(s(verdict, a, undefined)).toBe('mitigated');
      }
    }
  });
  it('a confirmed-malicious verdict is NOT a remediation: ConfirmedMalicious + None -> open', () => {
    expect(s('ConfirmedMalicious', 'None', ['None'])).toBe('open');
    expect(s('ConfirmedMalicious', 'Reported', ['Reported'])).toBe('open');
  });
  it('any mixed signal stays open: New + Remediated with actionsTaken [Remediated, Allowed] -> open', () => {
    expect(s('New', 'Remediated', ['Remediated', 'Allowed'])).toBe('open');
    expect(s('New', 'Remediated', ['Remediated', 'PartlyRemediated'])).toBe('open');
    expect(s('New', 'Remediated', ['Remediated', 'None'])).toBe('open');
    expect(s('New', 'Remediated', ['Remediated', 'Reported'])).toBe('open');
  });
  it('non-mitigating or missing actions -> open', () => {
    for (const a of ['None', 'Reported', 'Allowed', 'PartlyRemediated', undefined, null]) expect(s('New', a)).toBe('open');
  });
  it('Unknown / missing / unrecognised verdict -> unknown', () => {
    for (const v of ['Unknown', undefined, null, '', 'SomethingNew']) expect(s(v, 'Remediated')).toBe('unknown');
  });
  it('NEVER produces resolved or dismissed (cartesian guard)', () => {
    const verdicts = ['New', 'InInvestigation', 'ConfirmedMalicious', 'ConfirmedBenign', 'Unknown', undefined, 'x'];
    const actions = ['None', 'Reported', 'Remediated', 'Deleted', 'Blocked', 'Allowed', 'Isolated', 'PartlyRemediated', 'RollbackCompleted', undefined];
    for (const v of verdicts) for (const a of actions) for (const b of actions) {
      expect(['resolved', 'dismissed']).not.toContain(s(v, a, b ? [a ?? 'None', b] : undefined));
    }
  });
  it('the two action sets are disjoint', () => {
    for (const a of EMSI_MITIGATING_ACTIONS) expect(EMSI_NON_MITIGATING_ACTIONS.has(a)).toBe(false);
  });
});

describe('toVendorEndpoint (list item)', () => {
  const [pc, srv] = fx<{ data: EmsiDevice[] }>('devices-page1.json').data;

  it('a short name: hostname = name, fqdn null; placeholders until the detail call; no MAC, serial or isolation', () => {
    const e = toVendorEndpoint(pc!, WS);
    expect(e).toMatchObject({
      vendorEndpointId: D1, vendorTenantId: WS, hostname: 'PC01', fqdn: null, serialNumber: null,
      macAddresses: [], ipAddresses: [], osPlatform: 'other', osName: null, endpointType: 'unknown', agentVersion: null,
      health: 'unknown', online: null, isolationState: 'unknown', tamperProtection: null, policyName: 'Default', lastSeenAt: null,
    });
    expect(e.raw).toMatchObject({ guid: D1, name: 'PC01' });
  });

  it('a qualified name: hostname = first label (display casing kept), fqdn = the name', () => {
    expect(toVendorEndpoint(srv!, WS)).toMatchObject({ hostname: 'srv01', fqdn: 'srv01.corp.example.test' });
    expect(toVendorEndpoint({ ...pc!, name: 'Srv02.Corp.Example.Test.' }, WS)).toMatchObject({ hostname: 'Srv02', fqdn: 'Srv02.Corp.Example.Test' });
  });

  it('a nameless device has no hostname', () => {
    expect(toVendorEndpoint({ ...pc!, name: null }, WS)).toMatchObject({ hostname: null, fqdn: null });
  });
});

describe('toEndpointDetail', () => {
  const detail = fx<EmsiDeviceDetails>('device-details.json');

  it('domain with a dot -> lower-cased first-label.domain; IPs flattened v4 then v6, deduped', () => {
    const d = toEndpointDetail(D1, detail);
    expect(d.fqdn).toBe('pc01.corp.example.test');
    expect(d.ipAddresses).toEqual(['192.0.2.10', '192.0.2.11', '2001:db8::10']);
    expect(d).toMatchObject({
      vendorEndpointId: D1, osName: 'Windows 11 Pro', osPlatform: 'windows', endpointType: 'workstation',
      online: true, health: 'healthy', agentVersion: '2026.9.0.1',
    });
  });

  it('a NetBIOS workgroup domain -> explicit null fqdn (fetched as empty); a Server OS -> server', () => {
    const d = toEndpointDetail(D2, fx<EmsiDeviceDetails>('device-details-workgroup.json'));
    expect(d.fqdn).toBeNull();
    expect(d.endpointType).toBe('server');
    expect(d.online).toBe(false);
    expect(d.health).toBe('unhealthy');
    expect(d.ipAddresses).toEqual([]);
  });

  it('an empty / null domain -> null; a MISSING domain key -> undefined (not fetched != null)', () => {
    expect(toEndpointDetail(D1, { ...detail, domain: '' }).fqdn).toBeNull();
    expect(toEndpointDetail(D1, { ...detail, domain: null }).fqdn).toBeNull();
    const { domain: _omit, ...noDomain } = detail;
    const d = toEndpointDetail(D1, noDomain);
    expect(d.fqdn).toBeUndefined();
    expect('fqdn' in d).toBe(false);
  });

  it('caps the IP list at 16', () => {
    const many = { ...detail, networkAdapters: [{ iPv4Addresses: Array.from({ length: 30 }, (_, i) => `198.51.100.${i + 1}`), iPv6Addresses: [] }] };
    expect(toEndpointDetail(D1, many).ipAddresses).toHaveLength(16);
  });

  it('absent fields stay undefined so the stored value survives (os, version, updateStatus)', () => {
    const d = toEndpointDetail(D1, { name: 'PC01' });
    expect(d.osName).toBeUndefined();
    expect(d.osPlatform).toBeUndefined();
    expect(d.endpointType).toBeUndefined();
    expect(d.online).toBeUndefined();
    expect(d.health).toBeUndefined();
    expect(d.agentVersion).toBeUndefined();
  });

  it.each([
    ['Protected', 'healthy'], ['PartiallyProtected', 'degraded'], ['RebootRequired', 'degraded'], ['Connecting', 'degraded'],
    ['NotProtected', 'unhealthy'], ['NotManaged', 'unhealthy'], ['NewlyDiscovered', 'unhealthy'],
    ['Offline', 'unknown'], ['UnusedSeat', 'unknown'], ['Whatever', 'unknown'],
  ])('protectionStatus %s -> health %s (a device with no Emsisoft agent is never "protected")', (ps, health) => {
    expect(toEndpointDetail(D1, { ...detail, protectionStatus: ps }).health).toBe(health);
  });

  it('online: Online true, Offline false, Undefined/other null', () => {
    expect(toEndpointDetail(D1, { ...detail, updateStatus: { online: 'Undefined' } }).online).toBeNull();
  });
});

describe('toIncidentDetections (one row per distinct involved device)', () => {
  it('maps content fields; severity table; sibling-free details', () => {
    const rows = toIncidentDetections(incident({ involvedDevices: ['PC01', 'srv01.corp.example.test'] }), WS,
      index([['pc01', D1], ['srv01.corp.example.test', D2]]));
    expect(rows).toHaveLength(2);
    const [a, b] = rows;
    expect(a).toMatchObject({
      vendorDetectionId: `${INC}:pc01`, vendorKind: 'incident', vendorTenantId: WS, vendorEndpointId: D1, severity: 'critical',
      vendorSeverity: 'Malicious', status: 'mitigated', vendorStatus: 'New/Remediated', title: 'eicar.example.test.com',
      category: 'FileGuard', threatName: null, filePath: 'eicar.example.test.com', processName: null, mitreTechniques: [],
      vendorRef: 'da39a3ee5e6b4b0d3255bfef95601890afd80709', groupKey: INC,
    });
    expect(a!.detectedAt).toEqual(new Date('2026-10-20T07:00:00Z'));
    expect(a!.resolvedAt).toEqual(new Date('2026-10-20T07:00:00Z'));
    expect(a!.lastVendorUpdateAt).toEqual(new Date('2026-10-20T07:00:00Z'));
    expect(b).toMatchObject({ vendorDetectionId: `${INC}:srv01.corp.example.test`, vendorEndpointId: D2 });
    expect(a!.details).toMatchObject({
      incidentGuid: INC, type: 'File', verdict: 'New', actionTaken: 'Remediated', involvedDeviceName: 'PC01',
      deviceNameAmbiguous: false, involvedDeviceCount: 2, detailsPageLink: 'https://console.example.test/incident/c1',
    });
  });

  it('details NEVER carry a sibling device name or any involvedDeviceUsers value', () => {
    const rows = toIncidentDetections(incident({ involvedDevices: ['PC01', 'SECRET-SIBLING'], involvedDeviceUsers: ['SECRET-USER'] }), WS,
      index([['pc01', D1], ['secret-sibling', D2]]));
    const first = JSON.stringify(rows.find((r) => r.vendorEndpointId === D1)!.details);
    expect(first).not.toContain('SECRET-SIBLING');
    expect(first).not.toContain('SECRET-USER');
    expect(first).not.toContain('involvedDeviceUsers');
    expect(JSON.stringify(rows.find((r) => r.vendorEndpointId === D2)!.details)).not.toContain('PC01');
  });

  it('PC01 and pc01.corp.example.test are two different keys (full-name rule): an incident on "PC01" resolves', () => {
    const idx = index([['pc01', D1], ['pc01.corp.example.test', D2]]);
    const rows = toIncidentDetections(incident({ involvedDevices: ['PC01'] }), WS, idx);
    expect(rows[0]!.vendorEndpointId).toBe(D1);
    const q = toIncidentDetections(incident({ involvedDevices: ['pc01.corp.example.test'] }), WS, idx);
    expect(q[0]!.vendorEndpointId).toBe(D2);
  });

  it('two devices sharing the name key (index null) -> unattributed + deviceNameAmbiguous', () => {
    const rows = toIncidentDetections(incident({ involvedDevices: ['PC01'] }), WS, index([['pc01', null]]));
    expect(rows[0]).toMatchObject({ vendorEndpointId: null });
    expect(rows[0]!.details).toMatchObject({ deviceNameAmbiguous: true, involvedDeviceName: 'PC01' });
  });

  it('a name not in the workspace list -> unattributed, not ambiguous', () => {
    const rows = toIncidentDetections(incident({ involvedDevices: ['GHOST'] }), WS, index([['pc01', D1]]));
    expect(rows[0]).toMatchObject({ vendorEndpointId: null });
    expect(rows[0]!.details).toMatchObject({ deviceNameAmbiguous: false });
  });

  it('duplicate, trailing-dot twin and empty involved entries collapse', () => {
    const rows = toIncidentDetections(incident({ involvedDevices: ['PC01', 'pc01', 'PC01.', '', '  ', null as unknown as string] }), WS, index([['pc01', D1]]));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.vendorDetectionId).toBe(`${INC}:pc01`);
    expect(rows[0]!.details).toMatchObject({ involvedDeviceCount: 1 });
  });

  it('zero devices -> one bare-guid row, unattributed', () => {
    for (const involvedDevices of [[], null, undefined, ['']]) {
      const rows = toIncidentDetections(incident({ involvedDevices }), WS, index([]));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ vendorDetectionId: INC, vendorEndpointId: null });
      expect(rows[0]!.details).toMatchObject({ involvedDeviceCount: 0, involvedDeviceName: null });
    }
  });

  it('every row of one incident shares the groupKey and vendorRef', () => {
    const rows = toIncidentDetections(incident({ involvedDevices: ['a', 'b', 'c'] }), WS, index([]));
    expect(new Set(rows.map((r) => r.groupKey))).toEqual(new Set([INC]));
    expect(new Set(rows.map((r) => r.vendorRef)).size).toBe(1);
  });

  it('vendorRef falls back to the host address, then null; title falls back to host, then type', () => {
    const host = toIncidentDetections(incident({ sha1: null, knownFileNames: [], hostAddress: 'bad.example.test', type: 'Host' }), WS, index([]))[0]!;
    expect(host).toMatchObject({ vendorRef: 'bad.example.test', title: 'bad.example.test', filePath: null });
    const bare = toIncidentDetections(incident({ sha1: '', knownFileNames: null, hostAddress: null, type: 'Payload' }), WS, index([]))[0]!;
    expect(bare).toMatchObject({ vendorRef: null, title: 'Payload' });
  });

  it('open incidents are not resolved; false_positive ones are', () => {
    const open = toIncidentDetections(incident({ verdict: 'New', actionTaken: 'None', actionsTaken: ['None'] }), WS, index([]))[0]!;
    expect(open).toMatchObject({ status: 'open', resolvedAt: null });
    const fp = toIncidentDetections(incident({ verdict: 'ConfirmedBenign' }), WS, index([]))[0]!;
    expect(fp).toMatchObject({ status: 'false_positive' });
    expect(fp.resolvedAt).toEqual(new Date('2026-10-20T07:00:00Z'));
  });

  it.each([
    ['Malicious', 'critical'], ['LikelyMalicious', 'high'], ['Suspicious', 'medium'], ['Notable', 'low'], ['Unwanted', 'low'],
    ['FalseAlert', 'info'], ['None', 'info'], ['Weird', 'unknown'], [undefined, 'unknown'],
  ] as Array<[string | undefined, EdrSeverity]>)('highestSeverity %s -> %s', (sev, expected) => {
    expect(toIncidentDetections(incident({ highestSeverity: sev }), WS, index([]))[0]!.severity).toBe(expected);
  });
});

describe('detectionIdFor', () => {
  it('guid alone for a null key; guid:key when it fits; guid:h:<40 hex> when it does not (deterministic, never truncated)', () => {
    expect(detectionIdFor(INC, null)).toBe(INC);
    expect(detectionIdFor(INC, 'pc01')).toBe(`${INC}:pc01`);
    const long = 'x'.repeat(300);
    const id = detectionIdFor(INC, long);
    expect(id).toBe(`${INC}:h:${createHash('sha256').update(long).digest('hex').slice(0, 40)}`);
    expect(id.length).toBeLessThanOrEqual(255);
    expect(detectionIdFor(INC, long)).toBe(id);
    expect(detectionIdFor(INC, `${long}y`)).not.toBe(id);
  });

  it('exactly-fitting keys are kept verbatim (255 boundary)', () => {
    const fits = 'k'.repeat(255 - INC.length - 1);
    expect(detectionIdFor(INC, fits)).toBe(`${INC}:${fits}`);
    expect(detectionIdFor(INC, `${fits}k`)).toMatch(/:h:[0-9a-f]{40}$/);
  });

  it('two incidents on the same device get distinct ids', () => {
    expect(detectionIdFor(INC, 'pc01')).not.toBe(detectionIdFor('00000000-0000-4000-8000-0000000000c2', 'pc01'));
  });
});

describe('toStatusUpdate', () => {
  const ref = { vendorDetectionId: `${INC}:pc01`, vendorKind: 'incident' as const, vendorRef: 'sha', groupKey: INC };

  it('a ConfirmedBenign detail -> false_positive; severity and last-update from the detail', () => {
    const u = toStatusUpdate(ref, fx('incident-detail.json'));
    expect(u).toMatchObject({
      vendorDetectionId: ref.vendorDetectionId, vendorKind: 'incident', status: 'false_positive',
      vendorStatus: 'ConfirmedBenign/Allowed', severity: 'low', vendorSeverity: 'Unwanted',
    });
    expect(u.lastVendorUpdateAt).toEqual(new Date('2026-10-21T09:30:00Z'));
    expect(u.resolvedAt).toEqual(new Date('2026-10-21T09:30:00Z'));
  });

  it('a mitigated detail is resolved at the LATEST detection time (unordered detections)', () => {
    const u = toStatusUpdate(ref, {
      verdict: 'New', actionTaken: 'Remediated', actionsTaken: ['Remediated'], severity: 'Malicious',
      detections: [{ dateTime: '2026-10-22T00:00:00Z' }, { dateTime: '2026-10-25T00:00:00Z' }, { dateTime: '2026-10-21T00:00:00Z' }],
    });
    expect(u.status).toBe('mitigated');
    expect(u.resolvedAt).toEqual(new Date('2026-10-25T00:00:00Z'));
    expect(u.lastVendorUpdateAt).toEqual(new Date('2026-10-25T00:00:00Z'));
  });

  it('an open detail keeps resolvedAt null; no detections -> lastVendorUpdateAt null', () => {
    const u = toStatusUpdate(ref, { verdict: 'New', actionTaken: 'None', actionsTaken: ['None'], severity: 'Malicious', detections: [] });
    expect(u).toMatchObject({ status: 'open', severity: 'critical', resolvedAt: null, lastVendorUpdateAt: null });
  });
});
