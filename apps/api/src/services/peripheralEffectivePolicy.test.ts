import { describe, expect, it } from 'vitest';
import {
  canonicalPeripheralEnvelopeBytes,
  comparePeripheralCandidates,
  digestPeripheralEnvelope,
  policyTargetsDevice,
  resolveEffectivePeripheralPolicySet,
  type PeripheralDeviceIdentity,
  type PeripheralPolicyCandidate,
} from './peripheralEffectivePolicy';
import canonicalGolden from '../testFixtures/peripheral-policy-v2-canonical.json';

const identity: PeripheralDeviceIdentity = {
  deviceId: '00000000-0000-4000-8000-000000000004',
  orgId: '00000000-0000-4000-8000-000000000001',
  partnerId: '00000000-0000-4000-8000-000000000002',
  siteId: '00000000-0000-4000-8000-000000000003',
  groupIds: [
    '00000000-0000-4000-8000-000000000006',
    '00000000-0000-4000-8000-000000000005',
  ],
};

function candidate(
  id: string,
  overrides: Partial<PeripheralPolicyCandidate> = {},
): PeripheralPolicyCandidate {
  return {
    id,
    orgId: identity.orgId,
    partnerId: null,
    deviceClass: 'storage',
    action: 'block',
    targetType: 'organization',
    priority: 100,
    targetIds: {},
    exceptions: [],
    isActive: true,
    ...overrides,
  };
}

describe('policyTargetsDevice', () => {
  it.each([
    ['organization owner', candidate('10000000-0000-4000-8000-000000000001'), true],
    ['partner owner', candidate('10000000-0000-4000-8000-000000000002', { orgId: null, partnerId: identity.partnerId }), true],
    ['other organization', candidate('10000000-0000-4000-8000-000000000003', { orgId: '90000000-0000-4000-8000-000000000001' }), false],
    ['other partner', candidate('10000000-0000-4000-8000-000000000004', { orgId: null, partnerId: '90000000-0000-4000-8000-000000000002' }), false],
    ['site target', candidate('10000000-0000-4000-8000-000000000005', { targetType: 'site', targetIds: { siteIds: [identity.siteId] } }), true],
    ['other site', candidate('10000000-0000-4000-8000-000000000006', { targetType: 'site', targetIds: { siteIds: ['90000000-0000-4000-8000-000000000003'] } }), false],
    ['overlapping group', candidate('10000000-0000-4000-8000-000000000007', { targetType: 'group', targetIds: { groupIds: [identity.groupIds[0]!] } }), true],
    ['other group', candidate('10000000-0000-4000-8000-000000000008', { targetType: 'group', targetIds: { groupIds: ['90000000-0000-4000-8000-000000000005'] } }), false],
    ['device target', candidate('10000000-0000-4000-8000-000000000009', { targetType: 'device', targetIds: { deviceIds: [identity.deviceId] } }), true],
    ['inactive policy', candidate('10000000-0000-4000-8000-000000000010', { isActive: false }), false],
  ] as const)('%s', (_name, policy, expected) => {
    expect(policyTargetsDevice(policy, identity)).toBe(expected);
  });
});

describe('comparePeripheralCandidates', () => {
  it.each([
    ['device target over group', { targetType: 'device' }, { targetType: 'group' }],
    ['group target over site', { targetType: 'group' }, { targetType: 'site' }],
    ['site target over organization', { targetType: 'site' }, { targetType: 'organization' }],
    ['organization owner over partner owner', {}, { orgId: null, partnerId: identity.partnerId }],
    ['exact storage over all_usb fallback', { deviceClass: 'storage' }, { deviceClass: 'all_usb' }],
    ['lower priority', { priority: 1 }, { priority: 2 }],
    ['block over read_only', { action: 'block' }, { action: 'read_only' }],
    ['read_only over alert', { action: 'read_only' }, { action: 'alert' }],
    ['alert over allow', { action: 'alert' }, { action: 'allow' }],
    ['lower UUID', {}, { id: 'f0000000-0000-4000-8000-000000000001' }],
  ] as const)('%s', (_name, left, right) => {
    const a = candidate('10000000-0000-4000-8000-000000000001', left);
    const b = candidate('20000000-0000-4000-8000-000000000001', right);
    expect(comparePeripheralCandidates(a, b)).toBeLessThan(0);
    expect(comparePeripheralCandidates(b, a)).toBeGreaterThan(0);
  });
});

describe('resolveEffectivePeripheralPolicySet', () => {
  it('is independent of creation/input order and retains one winner per effective class', () => {
    const policies = [
      candidate('30000000-0000-4000-8000-000000000003', { deviceClass: 'bluetooth', action: 'alert' }),
      candidate('30000000-0000-4000-8000-000000000002', { deviceClass: 'storage', action: 'allow', priority: 900 }),
      candidate('30000000-0000-4000-8000-000000000001', { deviceClass: 'all_usb', action: 'block', priority: 0 }),
      candidate('30000000-0000-4000-8000-000000000004', { deviceClass: 'storage', targetType: 'device', targetIds: { deviceIds: [identity.deviceId] }, action: 'read_only' }),
    ];

    const expected = [
      expect.objectContaining({ policyId: policies[2]!.id, configuredClass: 'all_usb', effectiveClass: 'all_usb' }),
      expect.objectContaining({ policyId: policies[0]!.id, configuredClass: 'bluetooth', effectiveClass: 'bluetooth' }),
      expect.objectContaining({ policyId: policies[3]!.id, configuredClass: 'storage', effectiveClass: 'storage', action: 'read_only' }),
    ];
    expect(resolveEffectivePeripheralPolicySet({ identity, policies })).toEqual(expected);
    expect(resolveEffectivePeripheralPolicySet({ identity, policies: [...policies].reverse() })).toEqual(expected);
  });

  it('uses all_usb only as storage fallback and never for Bluetooth or Thunderbolt', () => {
    const allUsb = candidate('40000000-0000-4000-8000-000000000001', { deviceClass: 'all_usb' });
    expect(resolveEffectivePeripheralPolicySet({ identity, policies: [allUsb] })).toEqual([
      expect.objectContaining({ effectiveClass: 'all_usb', configuredClass: 'all_usb' }),
      expect.objectContaining({ effectiveClass: 'storage', configuredClass: 'all_usb' }),
    ]);
  });

  it('returns an empty set when no active accessible policy targets the device', () => {
    expect(resolveEffectivePeripheralPolicySet({
      identity,
      policies: [candidate('50000000-0000-4000-8000-000000000001', { orgId: '90000000-0000-4000-8000-000000000001' })],
    })).toEqual([]);
  });
});

describe('canonical peripheral envelope', () => {
  const envelope = {
    schemaVersion: 2 as const,
    phase: 'enforce' as const,
    identity,
    revision: 7,
    effectivePolicies: [{
      policyId: '60000000-0000-4000-8000-000000000001',
      source: 'organization' as const,
      effectiveClass: 'storage' as const,
      configuredClass: 'storage' as const,
      action: 'block' as const,
      priority: 10,
      exceptions: [{ serialNumber: 'ABC', allow: true }],
    }],
  };

  it('uses recursively sorted keys, sorted group UUIDs, UTF-8, and no whitespace', () => {
    expect(new TextDecoder().decode(canonicalPeripheralEnvelopeBytes(envelope))).toBe(
      canonicalGolden.canonicalJson,
    );
  });

  it('matches the frozen SHA-256 golden digest', () => {
    expect(digestPeripheralEnvelope(envelope)).toBe(canonicalGolden.digest);
  });
});
