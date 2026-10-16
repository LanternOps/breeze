import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bucketSeverityScore, toEndpointDetail, toIncidentDetection, toQuarantineDetection, toVendorEndpoint,
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
    const d = toEndpointDetail('e', base);
    expect(d).toMatchObject({ vendorEndpointId: 'e', health: 'healthy', online: true, agentVersion: '7.9.12.345' });
    expect(d.lastSeenAt?.toISOString()).toBe('2026-10-08T09:30:00.000Z');
  });
  it('infected -> unhealthy; outdated signatures or unlicensed -> degraded; unknown state -> online null', () => {
    expect(toEndpointDetail('e', { ...base, malwareStatus: { infected: true } }).health).toBe('unhealthy');
    expect(toEndpointDetail('e', { ...base, agent: { signatureOutdated: true } }).health).toBe('degraded');
    expect(toEndpointDetail('e', { ...base, agent: { licensed: false } }).health).toBe('degraded');
    expect(toEndpointDetail('e', { ...base, state: 7 }).online).toBeNull();
    expect(toEndpointDetail('e', { ...base, state: 2 }).online).toBe(false);
  });
});

describe('toIncidentDetection', () => {
  const [open, closed, weird] = fx('incidents-page.json').items;
  it('maps an open incident', () => {
    const d = toIncidentDetection(open, T);
    expect(d).toMatchObject({
      vendorDetectionId: '6b0000000000000000000001', vendorKind: 'incident', vendorEndpointId: '6a0000000000000000000a01',
      severity: 'high', vendorSeverity: '85', status: 'open', vendorStatus: '1', title: 'Trojan.Example.A', resolvedAt: null,
      details: { incidentNumber: 101, mainAction: 'Process killed', priority: 2, attackTypes: ['Execution'] },
    });
    expect(d.lastVendorUpdateAt?.toISOString()).toBe('2026-10-07T08:10:00.000Z');
    expect(d.detectedAt?.toISOString()).toBe('2026-10-07T08:00:00.000Z');
  });
  it('closed incident sets resolvedAt; title falls back to Incident #n', () => {
    const d = toIncidentDetection(closed, T);
    expect(d.status).toBe('resolved');
    expect(d.resolvedAt?.toISOString()).toBe('2026-10-07T09:00:00.000Z');
    expect(d.title).toBe('Incident #102');
  });
  it('unknown status / null severity -> unknown buckets, never throws', () => {
    expect(toIncidentDetection(weird, T)).toMatchObject({ status: 'unknown', severity: 'unknown', vendorEndpointId: null, vendorSeverity: null });
  });
});

describe('toQuarantineDetection', () => {
  const [q, odd] = fx('quarantine-page.json').items;
  it('quarantined -> mitigated, medium, file path + sha in details', () => {
    expect(toQuarantineDetection(q, T)).toMatchObject({
      vendorDetectionId: '6c0000000000000000000001', vendorKind: 'quarantine_item', status: 'mitigated', severity: 'medium',
      threatName: 'Eicar-Test-File', filePath: '/tmp/eicar.com', vendorEndpointId: '6a0000000000000000000a02',
      details: { canBeRestored: true, canBeRemoved: true },
    });
  });
  it('unknown action status -> unknown; restored/removed buckets', () => {
    expect(toQuarantineDetection(odd, T).status).toBe('unknown');
    expect(toQuarantineDetection({ ...q, actionStatus: 'Restored' }, T).status).toBe('dismissed');
    expect(toQuarantineDetection({ ...q, actionStatus: 'removed' }, T).status).toBe('resolved');
  });
});
