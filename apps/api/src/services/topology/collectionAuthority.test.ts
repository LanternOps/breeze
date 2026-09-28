import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../db', () => ({ db: {}, assertInTransaction: vi.fn() }));
import {
  authorizeTopologyPhysicalProducer, registerTopologyProducerAuthority, topologyPhysicalProducerCredentials, topologySourceIdentity,
} from './collectionAuthority';

const scope = { orgId: '00000000-0000-4000-8000-000000000001', siteId: '00000000-0000-4000-8000-000000000002' };
const device = { id: '00000000-0000-4000-8000-000000000003', orgId: scope.orgId, siteId: scope.siteId };
const request = (over = {}) => ({ producerKind: 'discovery' as const, scope, device, authorityKey: 'snmp:192.0.2.10', ...over });

describe('server-derived source identity (D1)', () => {
  it('formats agent, discovery and unifi identities from server facts only', () => {
    expect(topologySourceIdentity({ scope, producerKind: 'agent', deviceId: device.id })).toBe(`${scope.orgId}:${scope.siteId}:agent:${device.id}`);
    expect(topologySourceIdentity({ scope, producerKind: 'discovery', deviceId: device.id })).toBe(`${scope.orgId}:${scope.siteId}:discovery:${device.id}`);
    expect(topologySourceIdentity({ scope, producerKind: 'unifi', deviceId: device.id, collectorId: 'c-1' })).toBe(`${scope.orgId}:${scope.siteId}:unifi:${device.id}:c-1`);
  });
  it('refuses a unifi identity without a collector and a discovery identity with one', () => {
    expect(() => topologySourceIdentity({ scope, producerKind: 'unifi', deviceId: device.id })).toThrow('producer_identity_mismatch');
    expect(() => topologySourceIdentity({ scope, producerKind: 'discovery', deviceId: device.id, collectorId: 'c-1' })).toThrow('producer_identity_mismatch');
  });
});

describe('physical producer credentials', () => {
  const root = { producerEpoch: 'root-epoch', configurationRevision: 'r'.repeat(64) };
  const input = { root, producerKind: 'discovery' as const, authorityKey: 'snmp:192.0.2.10', configurationGeneration: 'gen-1' };
  it('derives a stable 64-hex epoch and configuration revision', () => {
    const a = topologyPhysicalProducerCredentials(input);
    expect(a).toEqual(topologyPhysicalProducerCredentials(input));
    expect(a.producerEpoch).toMatch(/^[a-f0-9]{64}$/);
    expect(a.configurationRevision).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each([
    ['generation', { configurationGeneration: 'gen-2' }],
    ['authority', { authorityKey: 'snmp:192.0.2.11' }],
    ['device configuration', { root: { ...root, configurationRevision: 's'.repeat(64) } }],
    ['kind', { producerKind: 'unifi' as const, collectorId: 'c-1' }],
  ])('rotates both when the %s changes', (_label, change) => {
    const a = topologyPhysicalProducerCredentials(input), b = topologyPhysicalProducerCredentials({ ...input, ...change });
    expect(b.producerEpoch).not.toBe(a.producerEpoch);
    expect(b.configurationRevision).not.toBe(a.configurationRevision);
  });
  it('rotates the epoch (not the configuration) when the heartbeat root epoch is reissued', () => {
    const a = topologyPhysicalProducerCredentials(input), b = topologyPhysicalProducerCredentials({ ...input, root: { ...root, producerEpoch: 'root-epoch-2' } });
    expect(b.producerEpoch).not.toBe(a.producerEpoch);
    expect(b.configurationRevision).toBe(a.configurationRevision);
  });
});

describe('pluggable producer authority', () => {
  let unregister: (() => void) | undefined;
  afterEach(() => { unregister?.(); unregister = undefined; });
  it('denies every physical kind by default', async () => {
    await expect(authorizeTopologyPhysicalProducer(request())).resolves.toEqual({ authorized: false, reason: 'producer_authority_unavailable' });
    await expect(authorizeTopologyPhysicalProducer(request({ producerKind: 'unifi', collectorId: 'c-1', authorityKey: 'c-1:site-a' }))).resolves.toMatchObject({ authorized: false });
  });
  it('uses the registered check and restores default-deny on unregister', async () => {
    const check = vi.fn().mockResolvedValue({ authorized: true, configurationGeneration: 'gen-1' });
    unregister = registerTopologyProducerAuthority('discovery', check);
    await expect(authorizeTopologyPhysicalProducer(request())).resolves.toEqual({ authorized: true, configurationGeneration: 'gen-1' });
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ authorityKey: 'snmp:192.0.2.10', device }));
    unregister(); unregister = undefined;
    await expect(authorizeTopologyPhysicalProducer(request())).resolves.toMatchObject({ authorized: false });
  });
  it('refuses a double registration so a second module cannot silently replace authority', () => {
    unregister = registerTopologyProducerAuthority('discovery', vi.fn());
    expect(() => registerTopologyProducerAuthority('discovery', vi.fn())).toThrow();
  });
  it('fails closed on a malformed or throwing decision', async () => {
    unregister = registerTopologyProducerAuthority('discovery', vi.fn().mockResolvedValue({ authorized: true, configurationGeneration: '' }));
    await expect(authorizeTopologyPhysicalProducer(request())).resolves.toMatchObject({ authorized: false, reason: 'producer_authority_invalid' });
    unregister();
    unregister = registerTopologyProducerAuthority('discovery', vi.fn().mockRejectedValue(new Error('boom')));
    await expect(authorizeTopologyPhysicalProducer(request())).rejects.toThrow('boom');
  });
  it('rejects a unifi authority key outside its collector namespace before asking the check', async () => {
    const check = vi.fn().mockResolvedValue({ authorized: true, configurationGeneration: 'g' });
    unregister = registerTopologyProducerAuthority('unifi', check);
    await expect(authorizeTopologyPhysicalProducer(request({ producerKind: 'unifi', collectorId: 'c-1', authorityKey: 'c-2:site-a' }))).resolves.toMatchObject({ authorized: false, reason: 'producer_authority_denied' });
    expect(check).not.toHaveBeenCalled();
  });
});
