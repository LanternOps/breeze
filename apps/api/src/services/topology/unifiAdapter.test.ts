import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalizeUnifiResource, physicalSourceSectionSchema, unifiResourceSchema, type UnifiResource } from '@breeze/shared';
import vectors from '../../../../../packages/shared/src/testing/topology-unifi-v1.json';
import { normalizeUnifiResource, uniqueSiteMacMatch, unifiAdapterRejection, unifiNormalizedDigest, unifiWireDigestMatches } from './unifiAdapter';
import { unifiAuthorityGeneration, unifiAuthorityKey, unifiCollectorRevision, unifiCollectorTopologyCredentials } from './unifiAuthority';

const scope = { orgId: 'org-a', siteId: 'site-a' };
const mac = '02:00:00:00:00:01';

describe('uniqueSiteMacMatch', () => {
  it('never binds the first org-wide MAC match', () => {
    expect(uniqueSiteMacMatch(scope, mac, [{ id: 'foreign', orgId: 'org-a', siteId: 'site-b', mac }])).toBeNull();
    expect(uniqueSiteMacMatch(scope, mac, [{ id: 'a', ...scope, mac }, { id: 'b', ...scope, mac }])).toBeNull();
  });
  it('binds exactly one same-site candidate, normalizing case and separators', () => {
    expect(uniqueSiteMacMatch(scope, '02-00-00-00-00-01', [{ id: 'a', ...scope, mac: '02:00:00:00:00:01'.toUpperCase() }])).toBe('a');
    // Two NIC rows of the same device are one candidate.
    expect(uniqueSiteMacMatch(scope, mac, [{ id: 'a', ...scope, mac }, { id: 'a', ...scope, mac }, { id: 'x', orgId: 'org-b', siteId: 'site-a', mac }])).toBe('a');
    expect(uniqueSiteMacMatch(scope, mac, [{ id: 'a', ...scope, mac: '02:00:00:00:00:02' }])).toBeNull();
    expect(uniqueSiteMacMatch(scope, '', [{ id: 'a', ...scope, mac: '' }])).toBeNull();
  });
});

describe('UniFi authority derivation', () => {
  const collector = { id: '8b0c0a58-2d6c-4b8f-9b43-6f0d3d7f0a11', integrationId: 'i', orgId: 'org-a', siteId: 'site-a', unifiHostId: 'host:1', collectorDeviceId: 'dev', controllerUrl: 'https://c', isEnabled: true, topologyGeneration: 0 };
  it('namespaces the authority key under the collector and refuses keys ingest would reject', () => {
    expect(unifiAuthorityKey(collector.id, 'default')).toBe(`${collector.id}:default`);
    expect(unifiAuthorityKey(collector.id, 'a/b')).toBeNull();
    expect(unifiAuthorityKey(collector.id, 'has space')).toBeNull();
    expect(unifiAuthorityKey(collector.id, 'x'.repeat(200))).toBeNull();
  });
  it('rotates the generation on authority changes but not on bookkeeping churn', () => {
    const mapping = { id: 'm1', orgId: 'org-a', siteId: 'site-a', topologyGeneration: 0 };
    const base = unifiAuthorityGeneration(mapping, collector);
    expect(unifiAuthorityGeneration({ ...mapping }, { ...collector })).toBe(base);
    expect(unifiAuthorityGeneration({ ...mapping, siteId: 'site-b' }, collector)).not.toBe(base);
    expect(unifiAuthorityGeneration({ ...mapping, id: 'm2' }, collector)).not.toBe(base);
    expect(unifiAuthorityGeneration({ ...mapping, topologyGeneration: 1 }, collector)).not.toBe(base);
    expect(unifiAuthorityGeneration(mapping, { ...collector, topologyGeneration: 1 })).not.toBe(base);
    expect(unifiAuthorityGeneration(mapping, { ...collector, collectorDeviceId: 'other' })).not.toBe(base);
    expect(unifiCollectorRevision({ ...collector, isEnabled: false })).not.toBe(unifiCollectorRevision(collector));
  });
  it('binds the advertised collector epoch to the heartbeat root and collector revision', () => {
    const root = { producerEpoch: 'root-1', configurationRevision: 'rev-1' };
    const a = unifiCollectorTopologyCredentials({ root, collector, deviceId: 'dev' });
    expect(a.sourceIdentity).toBe(`org-a:site-a:unifi:dev:${collector.id}`);
    expect(unifiCollectorTopologyCredentials({ root: { ...root, producerEpoch: 'root-2' }, collector, deviceId: 'dev' }).producerEpoch).not.toBe(a.producerEpoch);
    expect(unifiCollectorTopologyCredentials({ root, collector: { ...collector, controllerUrl: 'https://d' }, deviceId: 'dev' }).producerEpoch).not.toBe(a.producerEpoch);
    expect(unifiCollectorTopologyCredentials({ root, collector, deviceId: 'dev' })).toEqual(a);
  });
});

describe('normalizeUnifiResource', () => {
  const vector = vectors.vectors[0]!;
  const resources = vector.report.resources.map(r => unifiResourceSchema.parse(r)) as UnifiResource[];
  const byKind = (kind: string) => resources.find(r => r.kind === kind)!;
  const context = { hostKey: 'host:1', authorityKey: 'c1:site-1' };

  it('verifies the collector digest with the shared canonicalizer (cross-language fixture)', () => {
    const identity = { sourceIdentity: vector.sourceIdentity, producerEpoch: vector.report.producerEpoch };
    for (const resource of resources) {
      expect(createHash('sha256').update(canonicalizeUnifiResource(identity, resource)).digest('hex')).toBe(resource.contentDigest);
      expect(unifiWireDigestMatches(identity, resource)).toBe(true);
      expect(unifiWireDigestMatches({ ...identity, producerEpoch: 'other' }, resource)).toBe(false);
    }
  });

  it('adds scoped endpoint identity and same-site bindings, and yields a valid retained section', () => {
    const clients = byKind('client_list');
    const wired = clients.rows.find(r => 'clientType' in r && r.clientType === 'WIRED')!;
    const bindings = new Map([[(wired as { mac: string }).mac, '11111111-1111-4111-8111-111111111111']]);
    const section = normalizeUnifiResource({ ...context, resource: clients, bindings });
    expect(section.kind).toBe('unifi_client_list');
    expect(section.contextKey).toBe(context.authorityKey);
    const rows = section.rows as Array<Record<string, unknown>>;
    const wiredRow = rows.find(r => r.rowKey === wired.rowKey)!;
    expect(wiredRow.endpointKey).toBe(`unifi:host%3A1:${clients.controllerSiteId}:mac:${encodeURIComponent((wired as { mac: string }).mac)}`);
    expect(wiredRow.uplinkEndpointKey).toBe(`unifi:host%3A1:${clients.controllerSiteId}:device:dev-switch-1`);
    expect(wiredRow.inventoryDeviceId).toBe('11111111-1111-4111-8111-111111111111');
    const vpn = rows.find(r => r.clientType === 'VPN')!;
    expect(vpn.endpointKey).toBe(`unifi:host%3A1:${clients.controllerSiteId}:client:client-vpn-1`);
    expect(vpn.uplinkEndpointKey).toBeNull();
    expect(vpn.inventoryDeviceId).toBeNull();
    expect(physicalSourceSectionSchema.safeParse({ ...section, contentDigest: 'a'.repeat(64) }).success).toBe(true);
    for (const kind of ['device_list', 'device_details', 'statistics']) {
      const other = normalizeUnifiResource({ ...context, resource: byKind(kind), bindings: new Map() });
      expect(physicalSourceSectionSchema.safeParse({ ...other, contentDigest: 'a'.repeat(64) }).success).toBe(true);
    }
  });

  it('digests the normalized section deterministically and binds it to the scoped producer', () => {
    const section = normalizeUnifiResource({ ...context, resource: byKind('device_list'), bindings: new Map() });
    const producer = { sourceIdentity: 's', producerEpoch: 'e' };
    const digest = unifiNormalizedDigest(producer, section);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(unifiNormalizedDigest(producer, { ...section, rows: [...section.rows].reverse() } as typeof section)).toBe(digest);
    expect(unifiNormalizedDigest({ ...producer, producerEpoch: 'e2' }, section)).not.toBe(digest);
    const bound = normalizeUnifiResource({ ...context, resource: byKind('device_list'), bindings: new Map([['02:00:00:00:02:01', '11111111-1111-4111-8111-111111111111']]) });
    expect(unifiNormalizedDigest(producer, bound)).not.toBe(digest);
  });
});

describe('unifiAdapterRejection', () => {
  it('maps a NOWAIT lock loss to producer_busy whether or not Drizzle wrapped the driver error', () => {
    expect(unifiAdapterRejection(Object.assign(new Error('x'), { code: '55P03' }))).toBe('producer_busy');
    expect(unifiAdapterRejection(Object.assign(new Error('Failed query'), { cause: { code: '55P03' } }))).toBe('producer_busy');
  });
  it('passes expected producer rejections through and nothing else', () => {
    expect(unifiAdapterRejection(new Error('producer_epoch_changed'))).toBe('producer_epoch_changed');
    expect(unifiAdapterRejection(new Error('boom'))).toBeNull();
    expect(unifiAdapterRejection(Object.assign(new Error('Failed query'), { cause: { code: '40P01' } }))).toBeNull();
  });
});
