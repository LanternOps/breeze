// Class-aware filtering for the merged (agent + network + manual) device list.
//
// `POST /filters/preview` resolves an advanced filter against the agent
// `devices` table only, so its id set can never contain a network or manual
// row (whose id is a `discovered_assets.id` / `manual_assets.id`). Those rows
// are therefore evaluated here, client-side, against the same condition group
// — for the fields the row's class actually has. A condition on a field the
// class doesn't answer (patches, alerts, metrics, OS, software… for network;
// all of that plus status/network.*/lastSeenAt for manual) can never be true
// for that row; instead of silently dropping the row we report the field so
// the page can tell the tech "N network devices hidden — X applies to agent
// devices only" (or "N manual assets hidden…").
import type { FilterCondition, FilterConditionGroup, FilterOperator } from '@breeze/shared';
import { activeVpnList } from '@/lib/vpnProviders';
import type { Device, DeviceClass } from './DeviceList';

export type NetworkFilterVerdict = {
  matches: boolean;
  // Fields the row's class cannot answer that stood between it and a match.
  // Empty when the row matched, or when it failed on a field it does have
  // (e.g. status for a network row).
  inapplicableFields: string[];
};

type Scalar = string | number | boolean | Date | null | undefined;

/** Non-agent classes — every arm of the merged list this module evaluates
 *  client-side instead of trusting the server's agent-only id set. */
export type NonAgentClass = Exclude<DeviceClass, 'agent'>;

const classOf = (d: Device): DeviceClass => d.deviceClass ?? 'agent';
const isManual = (d: Device) => classOf(d) === 'manual';
const nonAgentClassOf = (d: Device): NonAgentClass | null => {
  const c = classOf(d);
  return c === 'agent' ? null : c;
};

const DAY_MS = 86_400_000;

// Resolves a filter field to the network row's own value, or `undefined` when
// the field is an agent-only concept. Distinct from a present-but-null value
// (returned as `null`), which IS applicable — e.g. a missing IP.
function networkFieldValue(field: string, d: Device): { applicable: boolean; value: Scalar | string[] } {
  switch (field) {
    case 'status':
      return { applicable: true, value: d.status };
    case 'hostname':
      return { applicable: true, value: d.hostname };
    case 'displayName':
      return { applicable: true, value: d.displayName ?? null };
    case 'tags':
      return { applicable: true, value: d.tags ?? [] };
    // A discovered asset has no agent role; its asset type answers the same
    // question ("is this a server?"), so the Servers chip works for both.
    case 'deviceRole':
      return { applicable: true, value: d.assetType ?? 'unknown' };
    case 'orgId':
      return { applicable: true, value: d.orgId };
    case 'siteId':
      return { applicable: true, value: d.siteId };
    case 'network.ipAddress':
    case 'lastSeenIp':
      return { applicable: true, value: d.lanIp ?? null };
    case 'network.macAddress':
      return { applicable: true, value: d.macAddress ?? null };
    case 'hardware.manufacturer':
      return { applicable: true, value: d.manufacturer ?? null };
    case 'hardware.model':
      return { applicable: true, value: d.model ?? null };
    case 'daysSinceLastSeen': {
      const t = Date.parse(d.lastSeen);
      return { applicable: true, value: Number.isNaN(t) ? null : (Date.now() - t) / DAY_MS };
    }
    case 'lastSeenAt': {
      const t = Date.parse(d.lastSeen);
      return { applicable: true, value: Number.isNaN(t) ? null : new Date(t) };
    }
    default:
      return { applicable: false, value: undefined };
  }
}

// Resolves a filter field to a manual asset's own value, or `undefined` when
// the field is an agent/network concept a hand-entered row cannot answer.
// `status` is deliberately inapplicable here (unlike network, where it IS
// applicable): a manual asset has no reachability, so a `status` condition
// must blame the field rather than reject the row on a fabricated 'unknown'.
function manualFieldValue(field: string, d: Device): { applicable: boolean; value: Scalar | string[] } {
  switch (field) {
    case 'hostname':
      return { applicable: true, value: d.hostname };
    case 'displayName':
      return { applicable: true, value: d.displayName ?? null };
    case 'tags':
      return { applicable: true, value: d.tags ?? [] };
    // A manual asset has no agent role; its asset type answers the same
    // question, same as the network arm above.
    case 'deviceRole':
      return { applicable: true, value: d.assetType ?? 'unknown' };
    case 'orgId':
      return { applicable: true, value: d.orgId };
    case 'siteId':
      return { applicable: true, value: d.siteId };
    case 'hardware.manufacturer':
      return { applicable: true, value: d.manufacturer ?? null };
    case 'hardware.model':
      return { applicable: true, value: d.model ?? null };
    case 'hardware.serialNumber':
      return { applicable: true, value: d.serialNumber ?? null };
    // status, network.*, daysSinceLastSeen, lastSeenAt, os*, agentVersion and
    // every metric are agent/network concepts a hand-entered row cannot answer.
    default:
      return { applicable: false, value: undefined };
  }
}

const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : v == null || v === '' ? [] : [String(v)];

const lower = (v: unknown) => String(v ?? '').toLowerCase();

const UNIT_MS: Record<string, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 7 * 86_400_000,
  months: 30 * 86_400_000,
};

function compareDate(operator: FilterOperator, actual: Date, expected: unknown): boolean {
  const t = actual.getTime();
  const parse = (v: unknown) => {
    const n = v instanceof Date ? v.getTime() : Date.parse(String(v));
    return Number.isNaN(n) ? null : n;
  };
  switch (operator) {
    case 'equals':
    case 'notEquals': {
      const e = parse(expected);
      const same = e !== null && e === t;
      return operator === 'equals' ? same : !same;
    }
    case 'before': {
      const e = parse(expected);
      return e !== null && t < e;
    }
    case 'after': {
      const e = parse(expected);
      return e !== null && t > e;
    }
    case 'between': {
      const r = expected as { from?: unknown; to?: unknown } | null;
      const from = r ? parse(r.from) : null;
      const to = r ? parse(r.to) : null;
      return from !== null && to !== null && t >= from && t <= to;
    }
    case 'withinLast':
    case 'notWithinLast': {
      const r = expected as { amount?: number; unit?: string } | null;
      const ms = r && typeof r.amount === 'number' ? r.amount * (UNIT_MS[r.unit ?? ''] ?? NaN) : NaN;
      if (Number.isNaN(ms)) return false;
      const within = Date.now() - t <= ms;
      return operator === 'withinLast' ? within : !within;
    }
    default:
      return false;
  }
}

// `operator` is the shared FilterOperator union on purpose: a misspelled case
// label here is a type error, not a silent "no network row ever matches".
function compareScalar(operator: FilterOperator, actual: Scalar | string[], expected: unknown): boolean {
  if (Array.isArray(actual)) {
    const have = actual.map(lower);
    const want = asList(expected).map(lower);
    switch (operator) {
      case 'isEmpty':
        return have.length === 0;
      case 'isNotEmpty':
        return have.length > 0;
      case 'hasAny':
      case 'in':
      case 'contains':
        return want.some((w) => have.includes(w));
      case 'hasAll':
        return want.every((w) => have.includes(w));
      case 'notContains':
      case 'notIn':
        return !want.some((w) => have.includes(w));
      case 'equals':
        return want.length === have.length && want.every((w) => have.includes(w));
      case 'notEquals':
        return !(want.length === have.length && want.every((w) => have.includes(w)));
      default:
        return false;
    }
  }
  switch (operator) {
    case 'isNull':
    case 'isEmpty':
      return actual == null || actual === '';
    case 'isNotNull':
    case 'isNotEmpty':
      return actual != null && actual !== '';
  }
  if (actual == null) return false;
  if (actual instanceof Date) return compareDate(operator, actual, expected);
  if (typeof actual === 'number') {
    const n = typeof expected === 'number' ? expected : Number(expected);
    switch (operator) {
      case 'equals':
        return actual === n;
      case 'notEquals':
        return actual !== n;
      case 'greaterThan':
        return actual > n;
      case 'greaterThanOrEquals':
        return actual >= n;
      case 'lessThan':
        return actual < n;
      case 'lessThanOrEquals':
        return actual <= n;
      case 'between': {
        const r = expected as { from?: number; to?: number } | null;
        return !!r && typeof r.from === 'number' && typeof r.to === 'number' && actual >= r.from && actual <= r.to;
      }
      case 'in':
        return asList(expected).map(Number).includes(actual);
      case 'notIn':
        return !asList(expected).map(Number).includes(actual);
      default:
        return false;
    }
  }
  const a = lower(actual);
  switch (operator) {
    case 'equals':
      return a === lower(expected);
    case 'notEquals':
      return a !== lower(expected);
    case 'contains':
      return a.includes(lower(expected));
    case 'notContains':
      return !a.includes(lower(expected));
    case 'startsWith':
      return a.startsWith(lower(expected));
    case 'endsWith':
      return a.endsWith(lower(expected));
    case 'matches':
      try {
        return new RegExp(String(expected), 'i').test(String(actual));
      } catch {
        return false;
      }
    case 'in':
      return asList(expected).map(lower).includes(a);
    case 'notIn':
      return !asList(expected).map(lower).includes(a);
    case 'before':
    case 'after': {
      const t = Date.parse(String(actual));
      const e = Date.parse(String(expected));
      if (Number.isNaN(t) || Number.isNaN(e)) return false;
      return operator === 'before' ? t < e : t > e;
    }
    default:
      return false;
  }
}

function evaluateCondition(c: FilterCondition, d: Device): NetworkFilterVerdict {
  const { applicable, value } = isManual(d) ? manualFieldValue(c.field, d) : networkFieldValue(c.field, d);
  if (!applicable) return { matches: false, inapplicableFields: [c.field] };
  return { matches: compareScalar(c.operator, value, c.value), inapplicableFields: [] };
}

export function evaluateNetworkAssetFilter(group: FilterConditionGroup | null | undefined, d: Device): NetworkFilterVerdict {
  if (!group || group.conditions.length === 0) return { matches: true, inapplicableFields: [] };
  const verdicts = group.conditions.map((c) => ('conditions' in c ? evaluateNetworkAssetFilter(c, d) : evaluateCondition(c, d)));
  const fields = (vs: NetworkFilterVerdict[]) => Array.from(new Set(vs.flatMap((v) => v.inapplicableFields)));
  if (group.operator === 'OR') {
    if (verdicts.some((v) => v.matches)) return { matches: true, inapplicableFields: [] };
    return { matches: false, inapplicableFields: fields(verdicts) };
  }
  const failed = verdicts.filter((v) => !v.matches);
  if (failed.length === 0) return { matches: true, inapplicableFields: [] };
  // If an APPLICABLE condition already rejects the row (e.g. status), the row
  // is legitimately filtered out — don't blame the agent-only fields.
  if (failed.some((v) => v.inapplicableFields.length === 0)) return { matches: false, inapplicableFields: [] };
  return { matches: false, inapplicableFields: fields(failed) };
}

export type MergedListFilterContext = {
  // Server-resolved agent id set (`null` = no advanced filter active).
  serverFilterIds: ReadonlySet<string> | null;
  // The condition group behind `serverFilterIds`, evaluated client-side for
  // network rows. `undefined` (caller didn't pass one) falls back to the id
  // set for every class, i.e. the legacy behaviour.
  advancedFilter?: FilterConditionGroup | null;
  includeDecommissioned: boolean;
  // Already lower-cased/trimmed search text ('' = none).
  query: string;
  // VPN facet: 'all' | 'any' | a provider id. An agent-only concept — a
  // network row has no VPN client — so anything but 'all' hides network rows
  // and is reported by summarizeHiddenNetworkDevices under the 'vpn' key.
  vpn?: string;
};

export const VPN_FACET_FIELD = 'vpn';

function matchesVpnFacet(d: Device, vpn: string): boolean {
  if (vpn === 'all') return true;
  // VPN presence is an agent-only concept — neither a discovered network
  // device nor a hand-entered manual asset runs a VPN client.
  if (nonAgentClassOf(d) !== null) return false;
  const active = activeVpnList(d.activeVpns);
  return vpn === 'any' ? active.length > 0 : active.some((v) => v.provider === vpn);
}

export function matchesSearchQuery(d: Device, query: string): boolean {
  if (query.length === 0) return true;
  return (
    d.hostname.toLowerCase().includes(query) ||
    (d.displayName?.toLowerCase().includes(query) ?? false) ||
    (d.lanIp?.includes(query) ?? false) ||
    (d.wanIp?.includes(query) ?? false) ||
    (d.serialNumber?.toLowerCase().includes(query) ?? false) ||
    (d.assetTag?.toLowerCase().includes(query) ?? false)
  );
}

// The one predicate both the list and the page's counts/grid use, so the
// segment badges can never disagree with the rows underneath them.
export function matchesMergedListFilters(d: Device, ctx: MergedListFilterContext): boolean {
  if (!ctx.includeDecommissioned && d.status === 'decommissioned') return false;
  if (!matchesVpnFacet(d, ctx.vpn ?? 'all')) return false;
  if (ctx.serverFilterIds !== null) {
    if (nonAgentClassOf(d) !== null && ctx.advancedFilter !== undefined) {
      if (!evaluateNetworkAssetFilter(ctx.advancedFilter, d).matches) return false;
    } else if (!ctx.serverFilterIds.has(d.id)) {
      return false;
    }
  }
  return matchesSearchQuery(d, ctx.query.trim().toLowerCase());
}

// Non-agent rows (network or manual) the active filters drop purely because
// they ask about agent-only things (agent-only filter fields, or the VPN
// facet) — the ones the page owes the tech an explanation for. Rows already
// hidden for an ordinary reason (search, decommissioned, an applicable
// condition) are not counted, so the notice never promises rows that clearing
// the agent-only part wouldn't show. `classes` names which non-agent class(es)
// contributed to `count`, so the page can say "3 manual assets hidden" instead
// of defaulting every non-agent row to "network devices".
export function summarizeHiddenNonAgentDevices(
  devices: readonly Device[],
  ctx: MergedListFilterContext,
): { count: number; fields: string[]; classes: NonAgentClass[] } {
  const vpn = ctx.vpn ?? 'all';
  if (!ctx.advancedFilter && vpn === 'all') return { count: 0, fields: [], classes: [] };
  const query = ctx.query.trim().toLowerCase();
  let count = 0;
  const fields = new Set<string>();
  const classes = new Set<NonAgentClass>();
  for (const d of devices) {
    const cls = nonAgentClassOf(d);
    if (cls === null) continue;
    if (!ctx.includeDecommissioned && d.status === 'decommissioned') continue;
    if (!matchesSearchQuery(d, query)) continue;
    const v = evaluateNetworkAssetFilter(ctx.advancedFilter, d);
    if (!v.matches && v.inapplicableFields.length === 0) continue; // an ordinary rejection
    const blame = [...v.inapplicableFields];
    if (vpn !== 'all') blame.push(VPN_FACET_FIELD);
    if (blame.length === 0) continue;
    count += 1;
    classes.add(cls);
    blame.forEach((f) => fields.add(f));
  }
  return { count, fields: Array.from(fields), classes: Array.from(classes) };
}

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// Default ordering for the merged list, shared by the table and the grid:
// `displayName || hostname` with numeric collation, blanks last, `id` as a
// stable tiebreaker so client-side pagination is deterministic.
export function sortByDisplayName<T extends Pick<Device, 'id' | 'hostname' | 'displayName'>>(devices: readonly T[]): T[] {
  const name = (d: T) => (d.displayName || d.hostname || '').trim();
  return [...devices].sort((a, b) => {
    const an = name(a);
    const bn = name(b);
    const aBlank = an === '';
    const bBlank = bn === '';
    const cmp = aBlank || bBlank ? (aBlank === bBlank ? 0 : aBlank ? 1 : -1) : nameCollator.compare(an, bn);
    return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
  });
}
