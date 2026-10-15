import {
  isTopologyConsumerDefaultPrefix,
  type PresenceReason,
  type PresenceState,
} from '@breeze/shared';

/**
 * Pure presence classifier (spec 2026-10-03 topology-site-location §4.1/§4.2).
 * No I/O: callers hand it the device's fresh attachments and the org fingerprint index.
 */

export type PresenceAttachment = {
  prefix: string;
  gateway: string;
  mac: string | null;
  confirmedAt: string;
  freshUntil: string;
  relationshipIds: string[];
  observerNodeId: string;
  interfaceName: string | null;
};

export type FingerprintRow = {
  siteId: string;
  prefix: string;
  gatewayAddress: string | null;
  status: 'anchored' | 'unconfirmed' | 'ambiguous';
  consumerDefault: boolean;
  observerDeviceIds: string[];
  gatewayMacs: { mac: string; observerDeviceIds: string[] }[];
  neighborCoverage: 'complete' | 'limited';
};

export type FingerprintIndex = {
  coverage: 'complete' | 'limited';
  /** prefix -> sorted unique ids of the sites declaring it */
  declarers: Map<string, string[]>;
  /** key `${siteId}|${prefix}` */
  rows: Map<string, FingerprintRow[]>;
};

export type AttachmentClass = {
  classification: 'home' | 'visiting' | 'unrecognized' | 'ambiguous' | 'unknown';
  siteId: string | null;
  reason: PresenceReason | null;
  declaringSiteIds: string[];
  macCorroborated: boolean;
};

export type DevicePresence = {
  state: PresenceState;
  reason: PresenceReason | null;
  matchedSiteId: string | null;
  declaringSiteIds: string[];
  attachment: PresenceAttachment | null;
  macCorroborated: boolean;
  evidence: (PresenceAttachment & AttachmentClass)[];
};

const EVIDENCE_CAP = 8;
const DECLARING_SITE_CAP = 8;
/** A MAC must be seen by this many observers other than the subject device to count as corroborated. */
const MIN_MAC_OBSERVERS = 2;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const rowKey = (siteId: string, prefix: string): string => `${siteId}|${prefix}`;

export function buildFingerprintIndex(rows: FingerprintRow[], coverage: 'complete' | 'limited'): FingerprintIndex {
  const declared = new Map<string, Set<string>>();
  const byKey = new Map<string, FingerprintRow[]>();
  for (const row of rows) {
    let sites = declared.get(row.prefix);
    if (!sites) declared.set(row.prefix, (sites = new Set()));
    sites.add(row.siteId);
    const key = rowKey(row.siteId, row.prefix);
    const list = byKey.get(key);
    if (list) list.push(row);
    else byKey.set(key, [row]);
  }
  const declarers = new Map<string, string[]>();
  for (const [prefix, sites] of declared) declarers.set(prefix, [...sites].sort(cmp));
  return { coverage, declarers, rows: byKey };
}

/**
 * MACs for gateway `gateway` on (site, prefix) corroborated by at least two observers other than
 * `excludeDeviceId` (leave-one-out: the device being classified never vouches for itself).
 * null means "no MAC evidence is available": the gateway has no row, or neighbour coverage is limited.
 */
export function corroboratedMacs(
  index: FingerprintIndex,
  siteId: string,
  prefix: string,
  gateway: string,
  excludeDeviceId: string,
): Set<string> | null {
  const rows = (index.rows.get(rowKey(siteId, prefix)) ?? []).filter((r) => r.gatewayAddress === gateway);
  if (!rows.length || rows.some((r) => r.neighborCoverage === 'limited')) return null;
  const out = new Set<string>();
  for (const r of rows) {
    for (const m of r.gatewayMacs) {
      const others = new Set(m.observerDeviceIds.filter((id) => id !== excludeDeviceId));
      if (others.size >= MIN_MAC_OBSERVERS) out.add(m.mac);
    }
  }
  return out;
}

export function classifyAttachment(
  a: PresenceAttachment,
  deviceId: string,
  assigned: string,
  index: FingerprintIndex,
): AttachmentClass {
  const declarers = index.declarers.get(a.prefix) ?? [];
  const base = { declaringSiteIds: declarers, macCorroborated: false };

  // 1. Nobody declares P.
  if (!declarers.length) return { ...base, classification: 'unrecognized', siteId: null, reason: 'not_declared' };

  // 2. Home: A declares P, g is one of A's gateways, and A's corroborated MACs do not contradict.
  if (declarers.includes(assigned)) {
    const own = (index.rows.get(rowKey(assigned, a.prefix)) ?? []).filter((r) => r.gatewayAddress === a.gateway);
    if (own.length) {
      const macs = corroboratedMacs(index, assigned, a.prefix, a.gateway, deviceId);
      const conflict = !!a.mac && !!macs && macs.size > 0 && !macs.has(a.mac);
      if (!conflict) {
        return { ...base, classification: 'home', siteId: assigned, reason: null, macCorroborated: !!a.mac && !!macs?.has(a.mac) };
      }
      // 4 (MAC conflict flavour)
      if (declarers.length === 1) {
        return { ...base, classification: 'unrecognized', siteId: assigned, reason: 'own_gateway_mac_conflict' };
      }
    } else if (declarers.length === 1) {
      // 4 (gateway mismatch flavour)
      return { ...base, classification: 'unrecognized', siteId: assigned, reason: 'own_gateway_mismatch' };
    }
  }

  // 3. Declared by two or more sites (and not home above).
  if (declarers.length >= 2) return { ...base, classification: 'ambiguous', siteId: null, reason: 'multiply_declared' };

  // 5. Declared by exactly one other site B.
  const b = declarers[0]!;
  if (index.coverage === 'limited') return { ...base, classification: 'unknown', siteId: null, reason: 'coverage_limited' };
  const rows = index.rows.get(rowKey(b, a.prefix)) ?? [];
  if (!rows.some((r) => r.gatewayAddress)) {
    return { ...base, classification: 'unrecognized', siteId: b, reason: 'declared_unconfirmed' };
  }
  if (!rows.some((r) => r.gatewayAddress === a.gateway)) {
    return { ...base, classification: 'unrecognized', siteId: b, reason: 'gateway_mismatch' };
  }
  const macs = corroboratedMacs(index, b, a.prefix, a.gateway, deviceId);
  // Order-independent: any row flagging it, or the shared list itself.
  const consumerDefault = rows.some((r) => r.consumerDefault) || isTopologyConsumerDefaultPrefix(a.prefix);
  if (consumerDefault) {
    return a.mac && macs?.has(a.mac)
      ? { ...base, classification: 'visiting', siteId: b, reason: null, macCorroborated: true }
      : { ...base, classification: 'unrecognized', siteId: b, reason: 'consumer_uncorroborated' };
  }
  if (a.mac && macs && macs.size > 0 && !macs.has(a.mac)) {
    return { ...base, classification: 'unrecognized', siteId: b, reason: 'gateway_mac_conflict' };
  }
  return { ...base, classification: 'visiting', siteId: b, reason: null, macCorroborated: !!a.mac && !!macs?.has(a.mac) };
}

type Classified = PresenceAttachment & AttachmentClass;

export function classifyDevicePresence(input: {
  deviceId: string;
  assignedSiteId: string;
  attachments: PresenceAttachment[];
  index: FingerprintIndex;
  now: Date;
}): DevicePresence {
  const nowMs = input.now.getTime();
  const fresh = input.attachments
    .filter((a) => Date.parse(a.freshUntil) > nowMs)
    .sort((x, y) => cmp(x.prefix, y.prefix) || cmp(x.gateway, y.gateway) || cmp(x.freshUntil, y.freshUntil) || cmp(x.mac ?? '', y.mac ?? ''));

  if (!fresh.length) {
    return {
      state: 'stale', reason: 'no_fresh_observation', matchedSiteId: null,
      declaringSiteIds: [], attachment: null, macCorroborated: false, evidence: [],
    };
  }

  const classified: Classified[] = fresh.map((a) => ({
    ...a,
    ...classifyAttachment(a, input.deviceId, input.assignedSiteId, input.index),
  }));
  const evidence = classified.slice(0, EVIDENCE_CAP);
  const first = (kind: AttachmentClass['classification']) => classified.find((c) => c.classification === kind) ?? null;
  const strip = (c: Classified): PresenceAttachment => ({
    prefix: c.prefix, gateway: c.gateway, mac: c.mac, confirmedAt: c.confirmedAt, freshUntil: c.freshUntil,
    relationshipIds: c.relationshipIds, observerNodeId: c.observerNodeId, interfaceName: c.interfaceName,
  });
  const result = (
    state: PresenceState,
    reason: PresenceReason | null,
    matchedSiteId: string | null,
    declaringSiteIds: string[],
    decider: Classified | null,
  ): DevicePresence => ({
    state, reason, matchedSiteId, declaringSiteIds: declaringSiteIds.slice(0, DECLARING_SITE_CAP),
    attachment: decider ? strip(decider) : null,
    macCorroborated: decider?.macCorroborated ?? false,
    evidence,
  });

  const home = first('home');
  if (home) return result('home', null, null, [], home);

  // S§4.2 override: with limited org coverage only home is trustworthy; everything else is "location unknown".
  if (input.index.coverage === 'limited') return result('unknown', 'coverage_limited', null, [], classified[0]!);

  const visiting = classified.filter((c) => c.classification === 'visiting');
  const ambiguous = classified.filter((c) => c.classification === 'ambiguous');
  const visitedSites = new Set(visiting.map((c) => c.siteId));

  if (visitedSites.size === 1 && !ambiguous.length) {
    return result('visiting', null, visiting[0]!.siteId, [], visiting[0]!);
  }
  if (visitedSites.size >= 2 || ambiguous.length) {
    const union = [...new Set([...ambiguous, ...visiting].flatMap((c) => c.declaringSiteIds))].sort(cmp);
    return result('ambiguous', 'multiply_declared', null, union, visiting[0] ?? ambiguous[0] ?? null);
  }

  if (classified.every((c) => c.classification === 'unknown')) {
    return result('unknown', 'coverage_limited', null, [], classified[0]!);
  }
  const decider = first('unrecognized') ?? classified[0]!;
  return result('unrecognized', decider.reason, null, decider.declaringSiteIds, decider);
}
