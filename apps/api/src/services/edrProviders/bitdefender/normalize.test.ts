import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bucketSeverityScore, toEndpointDetail, toIncidentDetection, toQuarantineDetection, toVendorEndpoint, ZONE_NOT_READ,
} from './normalize';

const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, '__fixtures__', n), 'utf8')).result;
const T = '5f0a1b2c3d4e5f60718293a1';

describe('bucketSeverityScore', () => {
  it.each([
    [100, 'critical'], [90, 'critical'], [89, 'high'], [70, 'high'], [69, 'medium'], [40, 'medium'],
    [39, 'low'], [1, 'low'], [0, 'unknown'], [null, 'unknown'], [undefined, 'unknown'], ['x', 'unknown'], [NaN, 'unknown'],
  ])('%s -> %s', (score, bucket) => {
    expect(bucketSeverityScore(score)).toBe(bucket);
  });
});

describe('toVendorEndpoint', () => {
  const [alpha, beta] = fx('inventory-page1.json').items;
  it('maps short hostname, fqdn, lower-case MACs, isolation, outdated -> degraded, server type', () => {
    const e = toVendorEndpoint(alpha, T);
    expect(e).toMatchObject({
      vendorEndpointId: '6a0000000000000000000a01', vendorTenantId: T, hostname: 'WS-ALPHA',
      fqdn: 'ws-alpha.corp.example.test', macAddresses: ['aa:bb:cc:00:11:22'], ipAddresses: ['10.0.0.11'],
      osPlatform: 'windows', endpointType: 'server', isolationState: 'isolated', health: 'degraded',
      policyName: 'Default policy', online: null, lastSeenAt: null,
    });
    expect(e.raw).toBe(alpha);
  });
  it('linux workstation, not isolated, no outdated flag -> unknown health', () => {
    expect(toVendorEndpoint(beta, T)).toMatchObject({
      hostname: 'lnx-beta', osPlatform: 'linux', endpointType: 'workstation', isolationState: 'not_isolated', health: 'unknown',
    });
  });
  it('missing isIsolated -> unknown; empty item never throws', () => {
    expect(toVendorEndpoint({ id: 'x' }, T)).toMatchObject({ isolationState: 'unknown', osPlatform: 'other', hostname: null, ipAddresses: [] });
  });
});

describe('toEndpointDetail', () => {
  const base = fx('endpoint-details.json');
  it('clean agent -> healthy, online, version, lastSeen', () => {
    const d = toEndpointDetail('e', base, 'UTC');
    expect(d).toMatchObject({ vendorEndpointId: 'e', health: 'healthy', online: true, agentVersion: '7.9.12.345' });
    expect(d.lastSeenAt?.toISOString()).toBe('2026-10-08T09:30:00.000Z');
  });
  it('infected -> unhealthy; outdated signatures or unlicensed -> degraded; unknown state -> online null', () => {
    expect(toEndpointDetail('e', { ...base, malwareStatus: { infected: true } }, 'UTC').health).toBe('unhealthy');
    expect(toEndpointDetail('e', { ...base, agent: { signatureOutdated: true } }, 'UTC').health).toBe('degraded');
    expect(toEndpointDetail('e', { ...base, agent: { licensed: false } }, 'UTC').health).toBe('degraded');
    expect(toEndpointDetail('e', { ...base, state: 7 }, 'UTC').online).toBeNull();
    expect(toEndpointDetail('e', { ...base, state: 2 }, 'UTC').online).toBe(false);
  });
});

describe('toIncidentDetection', () => {
  const [open, closed, weird] = fx('incidents-page.json').items;
  it('maps an open incident', () => {
    const d = toIncidentDetection(open, T, 'UTC');
    expect(d).toMatchObject({
      vendorDetectionId: '6b0000000000000000000001', vendorKind: 'incident', vendorEndpointId: '6a0000000000000000000a01',
      severity: 'high', vendorSeverity: '85', status: 'open', vendorStatus: '1', title: 'Trojan.Example.A', resolvedAt: null,
      details: { incidentNumber: 101, mainAction: 'Process killed', priority: 2, attackTypes: ['Execution'] },
    });
    expect(d.lastVendorUpdateAt?.toISOString()).toBe('2026-10-07T08:10:00.000Z');
    expect(d.detectedAt?.toISOString()).toBe('2026-10-07T08:00:00.000Z');
  });
  it('closed incident sets resolvedAt; title falls back to Incident #n', () => {
    const d = toIncidentDetection(closed, T, 'UTC');
    expect(d.status).toBe('resolved');
    expect(d.resolvedAt?.toISOString()).toBe('2026-10-07T09:00:00.000Z');
    expect(d.title).toBe('Incident #102');
  });
  it('unknown status / null severity -> unknown buckets, never throws', () => {
    expect(toIncidentDetection(weird, T, 'UTC')).toMatchObject({ status: 'unknown', severity: 'unknown', vendorEndpointId: null, vendorSeverity: null });
  });
});

describe('toQuarantineDetection', () => {
  const [q, odd] = fx('quarantine-page.json').items;
  it('quarantined -> mitigated, medium, file path + sha in details', () => {
    expect(toQuarantineDetection(q, T, 'UTC')).toMatchObject({
      vendorDetectionId: '6c0000000000000000000001', vendorKind: 'quarantine_item', status: 'mitigated', severity: 'medium',
      threatName: 'Eicar-Test-File', filePath: '/tmp/eicar.com', vendorEndpointId: '6a0000000000000000000a02',
      details: { canBeRestored: true, canBeRemoved: true },
    });
  });
  it('unknown action status -> unknown; restored/removed buckets', () => {
    expect(toQuarantineDetection(odd, T, 'UTC').status).toBe('unknown');
    expect(toQuarantineDetection({ ...q, actionStatus: 'Restored' }, T, 'UTC').status).toBe('dismissed');
    expect(toQuarantineDetection({ ...q, actionStatus: 'removed' }, T, 'UTC').status).toBe('resolved');
  });
});

describe('vendor times arrive in the key owner timezone (#12821, live shapes)', () => {
  const NY = 'America/New_York';
  const personal = fx('live-endpoint-details-personal-key.json');
  const service = fx('live-endpoint-details-service-key.json');

  it('endpoint lastSeen: personal key (owner zone) and service key (UTC) store the same UTC instant', () => {
    expect(toEndpointDetail('e', personal, NY).lastSeenAt?.toISOString()).toBe('2026-11-27T22:17:34.000Z');
    expect(toEndpointDetail('e', service, 'UTC').lastSeenAt?.toISOString()).toBe('2026-11-27T22:17:34.000Z');
  });

  it('endpoint lastSeen with no known account timezone is null, not a time read as UTC', () => {
    expect(toEndpointDetail('e', personal, null).lastSeenAt).toBeNull();
  });

  it('incidents carry an explicit offset, so both key types give one instant even with no timezone', () => {
    const [p] = fx('live-incidents-personal-key.json').items;
    const [s] = fx('live-incidents-service-key.json').items;
    for (const d of [toIncidentDetection(p, T, null), toIncidentDetection(s, T, null)]) {
      expect(d.detectedAt?.toISOString()).toBe('2026-11-25T21:26:45.000Z');
      expect(d.lastVendorUpdateAt?.toISOString()).toBe('2026-11-25T21:29:18.000Z');
    }
  });

  it('quarantinedOn is offset-less: read in the account timezone, null when it is unknown', () => {
    const [q] = fx('live-quarantine-service-key.json').items;
    const utc = toQuarantineDetection(q, T, 'UTC');
    expect(utc.detectedAt?.toISOString()).toBe('2026-10-11T22:01:10.000Z');
    expect(utc.lastVendorUpdateAt?.toISOString()).toBe('2026-10-11T22:01:10.000Z');
    // The same wall time from a key owned by a New York account is four hours later in UTC (EDT).
    expect(toQuarantineDetection(q, T, NY).detectedAt?.toISOString()).toBe('2026-10-12T02:01:10.000Z');
    const unknown = toQuarantineDetection(q, T, null);
    expect(unknown.detectedAt).toBeNull();
    expect(unknown.lastVendorUpdateAt).toBeNull();
  });

  it('zone not read this run: offset-less times are left undefined (stored value kept); times with an offset are still read', () => {
    expect(toEndpointDetail('e', personal, ZONE_NOT_READ)).not.toHaveProperty('lastSeenAt');
    expect(toEndpointDetail('e', { ...personal, lastSeen: '2026-11-27T17:17:34-05:00' }, ZONE_NOT_READ).lastSeenAt?.toISOString())
      .toBe('2026-11-27T22:17:34.000Z');
    // A missing value is known to be empty, not "not read".
    expect(toEndpointDetail('e', { ...personal, lastSeen: undefined }, ZONE_NOT_READ).lastSeenAt).toBeNull();

    const [q] = fx('live-quarantine-service-key.json').items;
    const notRead = toQuarantineDetection(q, T, ZONE_NOT_READ);
    expect([notRead.detectedAt, notRead.lastVendorUpdateAt, notRead.resolvedAt]).toEqual([undefined, undefined, null]);

    const [p] = fx('live-incidents-personal-key.json').items;
    expect(toIncidentDetection(p, T, ZONE_NOT_READ).detectedAt?.toISOString()).toBe('2026-11-25T21:26:45.000Z');
    // A closed incident whose last change has no offset: resolvedAt is not read either (kept), never null.
    const closed = toIncidentDetection({ ...p, status: 'resolved', lastIncidentChange: '2026-11-25T16:29:18' }, T, ZONE_NOT_READ);
    expect(closed.status).toBe('resolved');
    expect([closed.resolvedAt, closed.lastVendorUpdateAt]).toEqual([undefined, undefined]);
  });
});
