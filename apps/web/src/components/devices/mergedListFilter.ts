// Class-aware filtering for the merged (agent + network) device list.
//
// `POST /filters/preview` resolves an advanced filter against the agent
// `devices` table only, so its id set can never contain a network row (whose
// id is a `discovered_assets.id`). Network rows are therefore evaluated here,
// client-side, against the same condition group — for the fields a discovered
// asset actually has. A condition on an agent-only field (patches, alerts,
// metrics, OS, software…) can never be true for a network row; instead of
// silently dropping the row we report the field so the page can tell the
// tech "N network devices hidden — X applies to agent devices only".
import type { FilterCondition, FilterConditionGroup } from '@breeze/shared';
import type { Device } from './DeviceList';

export type NetworkFilterVerdict = {
  matches: boolean;
  // Agent-only fields that stood between this row and a match. Empty when the
  // row matched, or when it failed on a field it does have (e.g. status).
  inapplicableFields: string[];
};

type Scalar = string | number | boolean | null | undefined;

const isNetwork = (d: Device) => (d.deviceClass ?? 'agent') === 'network';

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
      return { applicable: true, value: (d as { macAddress?: string | null }).macAddress ?? null };
    case 'hardware.manufacturer':
      return { applicable: true, value: d.manufacturer ?? null };
    case 'hardware.model':
      return { applicable: true, value: d.model ?? null };
    case 'daysSinceLastSeen': {
      const t = Date.parse(d.lastSeen);
      return { applicable: true, value: Number.isNaN(t) ? null : (Date.now() - t) / DAY_MS };
    }
    case 'lastSeenAt':
      return { applicable: true, value: d.lastSeen || null };
    default:
      return { applicable: false, value: undefined };
  }
}

const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : v == null || v === '' ? [] : [String(v)];

const lower = (v: unknown) => String(v ?? '').toLowerCase();

function compareScalar(operator: string, actual: Scalar | string[], expected: unknown): boolean {
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
  if (typeof actual === 'number') {
    const n = typeof expected === 'number' ? expected : Number(expected);
    switch (operator) {
      case 'equals':
        return actual === n;
      case 'notEquals':
        return actual !== n;
      case 'greaterThan':
        return actual > n;
      case 'greaterThanOrEqual':
        return actual >= n;
      case 'lessThan':
        return actual < n;
      case 'lessThanOrEqual':
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
  const { applicable, value } = networkFieldValue(c.field, d);
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
};

export function matchesSearchQuery(d: Device, query: string): boolean {
  if (query.length === 0) return true;
  return (
    d.hostname.toLowerCase().includes(query) ||
    (d.displayName?.toLowerCase().includes(query) ?? false) ||
    (d.lanIp?.includes(query) ?? false) ||
    (d.wanIp?.includes(query) ?? false)
  );
}

// The one predicate both the list and the page's counts/grid use, so the
// segment badges can never disagree with the rows underneath them.
export function matchesMergedListFilters(d: Device, ctx: MergedListFilterContext): boolean {
  if (!ctx.includeDecommissioned && d.status === 'decommissioned') return false;
  if (ctx.serverFilterIds !== null) {
    if (isNetwork(d) && ctx.advancedFilter !== undefined) {
      if (!evaluateNetworkAssetFilter(ctx.advancedFilter, d).matches) return false;
    } else if (!ctx.serverFilterIds.has(d.id)) {
      return false;
    }
  }
  return matchesSearchQuery(d, ctx.query.trim().toLowerCase());
}

// Network rows the active filter drops purely because it asks about agent-only
// fields — the ones the page owes the tech an explanation for.
export function summarizeHiddenNetworkDevices(
  devices: readonly Device[],
  advancedFilter: FilterConditionGroup | null | undefined,
): { count: number; fields: string[] } {
  if (!advancedFilter) return { count: 0, fields: [] };
  let count = 0;
  const fields = new Set<string>();
  for (const d of devices) {
    if (!isNetwork(d)) continue;
    const v = evaluateNetworkAssetFilter(advancedFilter, d);
    if (v.matches || v.inapplicableFields.length === 0) continue;
    count += 1;
    v.inapplicableFields.forEach((f) => fields.add(f));
  }
  return { count, fields: Array.from(fields) };
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
