/**
 * Per-OID SNMP collection health (spec §6.2, decision D3).
 *
 * PURE. The caller supplies the template's OID list, the SNMP device row and
 * the newest metric row per (base_oid, instance); this module only classifies.
 *
 * THE RULE THAT MATTERS: missing rows cannot prove `noSuchObject`. A pre-W02
 * agent GETs a table column, gets back noSuchObject, `parseValue` yields nil,
 * and the row is stored as value_type 'null' with no error — that is F3, and it
 * is an AGENT limitation, not a device one. Reporting it as `unsupported` would
 * tell an operator their printer cannot report toner levels when in fact
 * nothing has ever asked it correctly. It is `unknown`, and the UI says "this
 * agent version cannot read table values; update the agent".
 */

export type CollectionOidState = 'collecting' | 'unsupported' | 'stale' | 'never_polled' | 'unknown';
export type CollectionStatus = 'ok' | 'failing' | 'no_template' | 'no_agent' | 'asset_moved' | 'never_polled' | 'paused';

/** Instances returned inline. The full set comes from GET /metrics (§6.3). */
export const COLLECTION_INSTANCE_CAP = 64;
const MIN_FRESHNESS_MS = 10 * 60_000;

export interface CollectionTemplateEntry {
  oid: string;
  name?: string;
  mode?: 'get' | 'walk';
  cadence?: 'fast' | 'slow';
  type?: string;
}

export interface CollectionMetricRow {
  oid: string;
  baseOid: string | null;
  instance: string | null;
  name: string;
  value: string | null;
  valueType: string | null;
  error: string | null;
  timestamp: Date | string;
}

export interface CollectionInput {
  templateId: string | null;
  templateOids: CollectionTemplateEntry[];
  snmpDevice: {
    isActive: boolean;
    lastStatus: string | null;
    lastPolled: Date | string | null;
    pollingInterval: number | null;
    consecutiveFailures: number;
  } | null;
  metrics: CollectionMetricRow[];
  now?: Date;
}

export interface CollectionOid {
  baseOid: string;
  name: string;
  mode: 'get' | 'walk';
  cadence: 'fast' | 'slow';
  state: CollectionOidState;
  observedAt: string | null;
  instances: Array<{ oid: string; instance: string; value: string | null; valueType: string; observedAt: string }>;
  error: string | null;
}

export interface Collection {
  templateId: string | null;
  lastPolledAt: string | null;
  pollingInterval: number | null;
  status: CollectionStatus;
  consecutiveFailures: number;
  oids: CollectionOid[];
}

/**
 * Acquisition mode when the template entry does not say (spec §7.1).
 *
 * The seed's scalars all end in `.0` and its columns never do. The entry's
 * `type` CANNOT decide this — `ifHCInOctets` is a counter64 AND a column.
 */
export function defaultOidMode(oid: string): 'get' | 'walk' {
  return oid.endsWith('.0') ? 'get' : 'walk';
}

export function defaultOidCadence(): 'fast' {
  return 'fast';
}

const DEVICE_STATUS_MAP: Record<string, CollectionStatus> = {
  online: 'ok',
  offline: 'failing',
  warning: 'failing',
  no_template: 'no_template',
  no_agent_in_site: 'no_agent',
  asset_missing: 'asset_moved',
  asset_no_site: 'asset_moved',
};

function toMillis(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function deriveCollection(input: CollectionInput): Collection {
  const now = (input.now ?? new Date()).getTime();
  const device = input.snmpDevice;
  const lastPolledMs = toMillis(device?.lastPolled ?? null);
  const pollingInterval = device?.pollingInterval ?? null;
  const freshnessMs = Math.max(2 * (pollingInterval ?? 300) * 1000, MIN_FRESHNESS_MS);
  const hasEverSucceeded = lastPolledMs !== null;

  const status: CollectionStatus = !device
    ? 'never_polled'
    : !device.isActive
      ? 'paused'
      : device.lastStatus && DEVICE_STATUS_MAP[device.lastStatus]
        ? DEVICE_STATUS_MAP[device.lastStatus]!
        : hasEverSucceeded ? 'ok' : 'never_polled';

  // Group the supplied rows by the base OID they belong to. A legacy row (no
  // base_oid) IS its own base — spec §6.2's "or whose `oid` equals it".
  const byBase = new Map<string, CollectionMetricRow[]>();
  for (const row of input.metrics) {
    const key = row.baseOid && row.baseOid.length > 0 ? row.baseOid : row.oid;
    const list = byBase.get(key) ?? [];
    list.push(row);
    byBase.set(key, list);
  }

  const oids: CollectionOid[] = input.templateOids.map((entry) => {
    const rows = (byBase.get(entry.oid) ?? []).slice().sort((a, b) => (toMillis(b.timestamp) ?? 0) - (toMillis(a.timestamp) ?? 0));
    const newest = rows[0] ?? null;
    const newestMs = newest ? toMillis(newest.timestamp) : null;
    const fresh = newestMs !== null && now - newestMs <= freshnessMs;

    let state: CollectionOidState;
    if (!newest) {
      // No rows for this OID. On a device that has never succeeded at all,
      // nothing has been asked yet; on one that polls fine, this OID stopped
      // answering.
      state = hasEverSucceeded ? 'stale' : 'never_polled';
    } else if (newest.error || newest.valueType === 'error') {
      state = 'unsupported';
    } else if (newest.value === null) {
      // A stored null with no error: a legacy agent's table GET. See the module
      // header — this is an agent limitation, never a device verdict.
      state = 'unknown';
    } else {
      state = fresh ? 'collecting' : 'stale';
    }

    return {
      baseOid: entry.oid,
      name: entry.name ?? entry.oid,
      mode: entry.mode ?? defaultOidMode(entry.oid),
      cadence: entry.cadence ?? defaultOidCadence(),
      state,
      observedAt: newestMs !== null ? new Date(newestMs).toISOString() : null,
      instances: rows
        .filter((row) => !row.error && row.valueType !== 'error')
        .slice(0, COLLECTION_INSTANCE_CAP)
        .map((row) => ({
          oid: row.oid,
          instance: row.instance ?? '',
          value: row.value,
          valueType: row.valueType ?? 'null',
          observedAt: new Date(toMillis(row.timestamp) ?? now).toISOString(),
        })),
      error: newest?.error ?? null,
    };
  });

  return {
    templateId: input.templateId,
    lastPolledAt: lastPolledMs !== null ? new Date(lastPolledMs).toISOString() : null,
    pollingInterval,
    status,
    consecutiveFailures: device?.consecutiveFailures ?? 0,
    oids,
  };
}
