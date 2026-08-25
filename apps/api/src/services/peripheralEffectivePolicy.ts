import { createHash } from 'node:crypto';
import { and, eq, or } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  deviceGroupMemberships,
  devices,
  organizations,
  peripheralPolicies,
  type PeripheralDeviceClass,
  type PeripheralExceptionRule,
  type PeripheralPolicyAction,
  type PeripheralPolicyTargetIds,
  type PeripheralPolicyTargetType,
} from '../db/schema';

export type PeripheralPolicyClass = 'storage' | 'all_usb' | 'bluetooth' | 'thunderbolt';

export type PeripheralPolicyV2 = {
  policyId: string;
  source: 'organization' | 'partner';
  effectiveClass: PeripheralPolicyClass;
  configuredClass: PeripheralPolicyClass;
  action: PeripheralPolicyAction;
  priority: number;
  exceptions: PeripheralExceptionRule[];
};

export type PeripheralPolicyEnvelopeV2 = {
  schemaVersion: 2;
  phase: 'clear_legacy' | 'enforce';
  identity: {
    deviceId: string;
    orgId: string;
    siteId: string;
    groupIds: string[];
  };
  revision: number;
  digest: string;
  generatedAt: string;
  reason: string;
  effectivePolicies: PeripheralPolicyV2[];
};

export interface PeripheralDeviceIdentity {
  deviceId: string;
  orgId: string;
  partnerId: string;
  siteId: string;
  groupIds: string[];
}

export interface PeripheralPolicyCandidate {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  deviceClass: PeripheralDeviceClass;
  action: PeripheralPolicyAction;
  targetType: PeripheralPolicyTargetType;
  priority: number;
  targetIds: PeripheralPolicyTargetIds | null;
  exceptions: PeripheralExceptionRule[] | null;
  isActive: boolean;
}

const targetRank: Record<PeripheralPolicyTargetType, number> = {
  device: 0,
  group: 1,
  site: 2,
  organization: 3,
};

const actionRank: Record<PeripheralPolicyAction, number> = {
  block: 0,
  read_only: 1,
  alert: 2,
  allow: 3,
};

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function policyTargetsDevice(
  policy: PeripheralPolicyCandidate,
  identity: PeripheralDeviceIdentity,
): boolean {
  if (!policy.isActive) return false;
  const ownerMatches = policy.orgId !== null
    ? policy.orgId === identity.orgId
    : policy.partnerId !== null && policy.partnerId === identity.partnerId;
  if (!ownerMatches) return false;

  const targets = policy.targetIds ?? {};
  switch (policy.targetType) {
    case 'organization':
      return true;
    case 'site':
      return targets.siteIds?.includes(identity.siteId) ?? false;
    case 'group':
      return targets.groupIds?.some((groupId) => identity.groupIds.includes(groupId)) ?? false;
    case 'device':
      return targets.deviceIds?.includes(identity.deviceId) ?? false;
  }
}

export function comparePeripheralCandidates(
  a: PeripheralPolicyCandidate,
  b: PeripheralPolicyCandidate,
): number {
  const target = targetRank[a.targetType] - targetRank[b.targetType];
  if (target !== 0) return target;

  const owner = Number(a.orgId === null) - Number(b.orgId === null);
  if (owner !== 0) return owner;

  // The only cross-class comparison made by the resolver is exact storage
  // versus its all_usb fallback. Other effective classes admit exact matches only.
  const classRankA = a.deviceClass === 'all_usb' ? 1 : 0;
  const classRankB = b.deviceClass === 'all_usb' ? 1 : 0;
  const configuredClass = classRankA - classRankB;
  if (configuredClass !== 0) return configuredClass;

  const priority = a.priority - b.priority;
  if (priority !== 0) return priority;

  const action = actionRank[a.action] - actionRank[b.action];
  if (action !== 0) return action;
  return compareText(a.id, b.id);
}

function candidatesForEffectiveClass(
  policies: readonly PeripheralPolicyCandidate[],
  effectiveClass: PeripheralPolicyClass,
): PeripheralPolicyCandidate[] {
  if (effectiveClass === 'storage') {
    return policies.filter((policy) => policy.deviceClass === 'storage' || policy.deviceClass === 'all_usb');
  }
  return policies.filter((policy) => policy.deviceClass === effectiveClass);
}

export function resolveEffectivePeripheralPolicySet(input: {
  identity: PeripheralDeviceIdentity;
  policies: readonly PeripheralPolicyCandidate[];
}): PeripheralPolicyV2[] {
  const applicable = input.policies.filter((policy) =>
    Number.isSafeInteger(policy.priority)
    && policy.priority >= 0
    && policy.priority <= 1000
    && policyTargetsDevice(policy, input.identity));
  const effectiveClasses: PeripheralPolicyClass[] = ['storage', 'all_usb', 'bluetooth', 'thunderbolt'];
  const winners: PeripheralPolicyV2[] = [];

  for (const effectiveClass of effectiveClasses) {
    const winner = candidatesForEffectiveClass(applicable, effectiveClass)
      .sort(comparePeripheralCandidates)[0];
    if (!winner) continue;
    winners.push({
      policyId: winner.id,
      source: winner.orgId === null ? 'partner' : 'organization',
      effectiveClass,
      configuredClass: winner.deviceClass,
      action: winner.action,
      priority: winner.priority,
      exceptions: winner.exceptions ?? [],
    });
  }

  return winners.sort((a, b) =>
    compareText(a.effectiveClass, b.effectiveClass) || compareText(a.policyId, b.policyId));
}

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue };

function recursivelySortKeys(value: unknown): CanonicalValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) return value.map(recursivelySortKeys);
  if (typeof value !== 'object') {
    throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
  }

  const result: { [key: string]: CanonicalValue } = {};
  for (const key of Object.keys(value).sort(compareText)) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) result[key] = recursivelySortKeys(child);
  }
  return result;
}

type DigestEnvelope = Omit<PeripheralPolicyEnvelopeV2, 'digest' | 'generatedAt' | 'reason'>;

export function canonicalPeripheralEnvelopeBytes(envelope: DigestEnvelope): Uint8Array {
  const digestFields = {
    schemaVersion: envelope.schemaVersion,
    phase: envelope.phase,
    identity: {
      deviceId: envelope.identity.deviceId,
      orgId: envelope.identity.orgId,
      siteId: envelope.identity.siteId,
      groupIds: [...envelope.identity.groupIds].sort(compareText),
    },
    revision: envelope.revision,
    effectivePolicies: envelope.effectivePolicies,
  };
  return new TextEncoder().encode(JSON.stringify(recursivelySortKeys(digestFields)));
}

export function digestPeripheralEnvelope(envelope: DigestEnvelope): `sha256:${string}` {
  const digest = createHash('sha256').update(canonicalPeripheralEnvelopeBytes(envelope)).digest('hex');
  return `sha256:${digest}`;
}

export async function loadAndResolveEffectivePeripheralPolicySet(
  deviceId: string,
): Promise<{ identity: PeripheralDeviceIdentity; effectivePolicies: PeripheralPolicyV2[] } | null> {
  return runOutsideDbContext(() => withSystemDbAccessContext(() =>
    loadAndResolveEffectivePeripheralPolicySetInCurrentDbContext(deviceId)));
}

export async function loadAndResolveEffectivePeripheralPolicySetInCurrentDbContext(
  deviceId: string,
): Promise<{ identity: PeripheralDeviceIdentity; effectivePolicies: PeripheralPolicyV2[] } | null> {
  const [device] = await db
    .select({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  if (!device) return null;

  const [organization] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, device.orgId))
    .limit(1);
  if (!organization) return null;

  const membershipRows = await db
    .select({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(and(
      eq(deviceGroupMemberships.deviceId, device.id),
      eq(deviceGroupMemberships.orgId, device.orgId),
    ));

  const policyRows = await db
    .select()
    .from(peripheralPolicies)
    .where(and(
      eq(peripheralPolicies.isActive, true),
      or(
        eq(peripheralPolicies.orgId, device.orgId),
        eq(peripheralPolicies.partnerId, organization.partnerId),
      ),
    ));

  const identity: PeripheralDeviceIdentity = {
    deviceId: device.id,
    orgId: device.orgId,
    partnerId: organization.partnerId,
    siteId: device.siteId,
    groupIds: membershipRows.map((row) => row.groupId).sort(compareText),
  };
  return {
    identity,
    effectivePolicies: resolveEffectivePeripheralPolicySet({ identity, policies: policyRows }),
  };
}
