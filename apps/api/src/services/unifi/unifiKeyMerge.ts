/**
 * Per-key Site Manager reads and the deterministic merge of several keys' views
 * (#11808, plan D4/D5). Pure: no database access, so it runs in the sync's
 * network phase and in the live `/hosts` read with no DB context held.
 *
 * Input order is precedence: callers pass keys in `created_at, id` order and the
 * first key's payload wins every duplicate.
 */
import {
  UnifiApiError,
  type UnifiClient,
  type UnifiDeviceDto,
  type UnifiHost,
  type UnifiIspMetrics,
} from './unifiClient';

export type SiteRead = Awaited<ReturnType<UnifiClient['listSitesForSync']>>;
export type KeyReadMode = 'hosts' | 'mapping' | 'sync';

export type KeyRead =
  | {
    keyId: string;
    label: string;
    ok: true;
    hosts: UnifiHost[];
    siteRead?: SiteRead;
    devicesByHost?: Map<string, UnifiDeviceDto[]>;
    metricsBySite?: Map<string, UnifiIspMetrics>;
    metricsError?: string;
  }
  | {
    keyId: string;
    label: string;
    ok: false;
    error: string;
    authFailure: boolean;
    /** The UniFi HTTP status when the failure was a UnifiApiError, else null. */
    httpStatus: number | null;
    /** The thrown value, kept in memory only so a live read can rethrow it. Never serialized. */
    cause: unknown;
    skipped?: true;
    /** Hosts read before the failure, if any. */
    hosts?: UnifiHost[];
    /** Sites read before the failure: that key's site evidence still counts (D4). */
    siteRead?: SiteRead;
  };
export type FailedKeyRead = Extract<KeyRead, { ok: false }>;

export interface MergedRead {
  hosts: UnifiHost[];
  siteRead?: SiteRead;
  devicesByHost?: Map<string, UnifiDeviceDto[]>;
  metricsBySite?: Map<string, UnifiIspMetrics>;
  metricsError?: string;
  /** host id -> ids of the keys whose /v1/hosts listed it, in precedence order. */
  hostKeyIds: Map<string, string[]>;
  /** `${hostId}::${siteId}` -> ids of the keys whose /v1/sites listed it. */
  siteKeyIds: Map<string, string[]>;
  /** D5(b): a working key that lists the host returned no device group for it, while another key did. */
  coverageGapHostIds: Set<string>;
  /** host id -> the working keys that list the host but returned no device group for it. */
  coverageGapKeyIds: Map<string, string[]>;
  /**
   * Strict site-count rule (Task 2.2): host id -> key id -> how many distinct
   * sites that key lists on the host. Covers every key with a site read that
   * lists the host in /v1/hosts or /v1/sites or returned a device group for it,
   * so a key that sees the host with zero sites counts as 0.
   */
  hostSiteCounts: Map<string, Map<string, number>>;
  /** D4: device ids reported under two different hosts. Neither written nor swept this run. */
  conflictingDeviceIds: Set<string>;
  failedKeys: FailedKeyRead[];
}

export const KEY_COLLECT_CONCURRENCY = 4;
/** Keys not started by then are skipped; stays under the worker's 300 s lock. */
export const KEY_COLLECT_BUDGET_MS = 200_000;
export const KEY_BUDGET_EXHAUSTED = 'sync time budget exhausted';
const DEFAULT_DECRYPT_ERROR = 'The stored API key could not be decrypted';

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failure(
  keyId: string,
  label: string,
  err: unknown,
  error: string,
  partial: { hosts?: UnifiHost[]; siteRead?: SiteRead } = {},
): FailedKeyRead {
  const httpStatus = err instanceof UnifiApiError ? err.status : null;
  return {
    keyId,
    label,
    ok: false,
    error,
    authFailure: httpStatus === 401 || httpStatus === 403,
    httpStatus,
    cause: err,
    ...partial,
  };
}

/**
 * One key's reads. Never throws: a failure comes back as `ok: false`.
 * - `hosts`: /v1/hosts only.
 * - `mapping`: /v1/hosts and /v1/sites (the mapping UI and the AI hosts view).
 * - `sync`: hosts, then sites, then devices, each required and stopping at the
 *   first failure; a metrics failure only sets `metricsError`. The error texts
 *   are the single-key engine's, unchanged.
 */
export async function readKey(keyId: string, label: string, client: UnifiClient, opts: { mode: KeyReadMode }): Promise<KeyRead> {
  if (opts.mode === 'mapping') {
    const [hostsResult, sitesResult] = await Promise.allSettled([client.listHosts(), client.listSites()]);
    const hosts = hostsResult.status === 'fulfilled' ? hostsResult.value : undefined;
    const siteRead: SiteRead | undefined = sitesResult.status === 'fulfilled'
      ? {
        sites: sitesResult.value,
        hostsWithDroppedRows: new Set<string>(),
        rowsWithoutHostId: sitesResult.value.filter((s) => !s.hostId).length,
      }
      : undefined;
    if (hostsResult.status === 'rejected') {
      return failure(keyId, label, hostsResult.reason, messageOf(hostsResult.reason), { siteRead });
    }
    if (sitesResult.status === 'rejected') {
      return failure(keyId, label, sitesResult.reason, messageOf(sitesResult.reason), { hosts });
    }
    return { keyId, label, ok: true, hosts: hosts!, siteRead };
  }

  let hosts: UnifiHost[];
  try {
    hosts = await client.listHosts();
  } catch (err) {
    return failure(keyId, label, err, messageOf(err));
  }
  if (opts.mode === 'hosts') return { keyId, label, ok: true, hosts };

  let siteRead: SiteRead;
  try {
    siteRead = await client.listSitesForSync();
  } catch (err) {
    return failure(keyId, label, err, `UniFi /v1/sites read failed: ${messageOf(err)}`, { hosts });
  }

  let devicesByHost: Map<string, UnifiDeviceDto[]>;
  try {
    devicesByHost = await client.listDevicesByHost();
  } catch (err) {
    return failure(keyId, label, err, `UniFi /v1/devices read failed: ${messageOf(err)}`, { hosts, siteRead });
  }

  try {
    const metricsBySite = await client.listIspMetricsBySite();
    return { keyId, label, ok: true, hosts, siteRead, devicesByHost, metricsBySite };
  } catch (err) {
    return {
      keyId, label, ok: true, hosts, siteRead, devicesByHost,
      metricsError: `UniFi ISP metrics read failed: ${messageOf(err)}`,
    };
  }
}

/**
 * Reads every key, at most `KEY_COLLECT_CONCURRENCY` at once, results in input
 * order. A key without a client (it did not decrypt) is a failed read and never
 * calls UniFi. A key not started before the budget runs out is `skipped`.
 */
export async function readKeys(
  keys: ReadonlyArray<{ id: string; label: string; client: UnifiClient | null; decryptError?: string }>,
  opts: { mode: KeyReadMode; now?: () => number; budgetMs?: number; concurrency?: number },
): Promise<KeyRead[]> {
  const now = opts.now ?? Date.now;
  const budgetMs = opts.budgetMs ?? KEY_COLLECT_BUDGET_MS;
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? KEY_COLLECT_CONCURRENCY, KEY_COLLECT_CONCURRENCY));
  const startedAt = now();
  const results: KeyRead[] = new Array(keys.length);
  let next = 0;

  async function lane(): Promise<void> {
    while (next < keys.length) {
      const index = next;
      next += 1;
      const key = keys[index]!;
      if (now() - startedAt >= budgetMs) {
        results[index] = { ...failure(key.id, key.label, undefined, KEY_BUDGET_EXHAUSTED), skipped: true };
        continue;
      }
      if (!key.client) {
        results[index] = failure(key.id, key.label, undefined, key.decryptError ?? DEFAULT_DECRYPT_ERROR);
        continue;
      }
      results[index] = await readKey(key.id, key.label, key.client, { mode: opts.mode });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, () => lane()));
  return results;
}

const siteKey = (hostId: string, siteId: string) => `${hostId}::${siteId}`;

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) {
    if (!list.includes(value)) list.push(value);
  } else {
    map.set(key, [value]);
  }
}

/**
 * Joins several keys' reads into the single view the mapping logic consumes
 * (plan D4, D5(b)). Input order is precedence.
 */
export function mergeKeyReads(reads: KeyRead[]): MergedRead {
  const hosts: UnifiHost[] = [];
  const hostKeyIds = new Map<string, string[]>();
  const siteKeyIds = new Map<string, string[]>();
  const failedKeys: FailedKeyRead[] = [];

  // Hosts: by id, first payload wins. A failed key's hosts (read before its
  // failure) count too, so the hosts-seen total matches the single-key engine.
  for (const read of reads) {
    if (!read.ok) failedKeys.push(read);
    for (const h of read.hosts ?? []) {
      if (!hostKeyIds.has(h.id)) hosts.push(h);
      push(hostKeyIds, h.id, read.keyId);
    }
  }

  // Sites: by (hostId, siteId), never by site id alone. A failed key's site read
  // counts: its listed sites are real evidence for the multi-site guard.
  let siteRead: SiteRead | undefined;
  for (const read of reads) {
    if (!read.siteRead) continue;
    siteRead ??= { sites: [], hostsWithDroppedRows: new Set<string>(), rowsWithoutHostId: 0 };
    for (const s of read.siteRead.sites) {
      const k = siteKey(s.hostId, s.id);
      if (!siteKeyIds.has(k)) siteRead.sites.push(s);
      push(siteKeyIds, k, read.keyId);
    }
    for (const h of read.siteRead.hostsWithDroppedRows) siteRead.hostsWithDroppedRows.add(h);
    siteRead.rowsWithoutHostId += read.siteRead.rowsWithoutHostId;
  }

  // Devices: per-host union by device id, first payload wins (working keys only).
  const deviceReads = reads.filter((r): r is Extract<KeyRead, { ok: true }> => r.ok && r.devicesByHost !== undefined);
  let devicesByHost: Map<string, UnifiDeviceDto[]> | undefined;
  const conflictingDeviceIds = new Set<string>();
  if (deviceReads.length > 0) {
    devicesByHost = new Map();
    // device id -> key id -> the hosts that key reported it under.
    const hostsByDeviceByKey = new Map<string, Map<string, Set<string>>>();
    for (const read of deviceReads) {
      for (const [hostId, list] of read.devicesByHost!) {
        const merged = devicesByHost.get(hostId) ?? [];
        for (const d of list) {
          const byKey = hostsByDeviceByKey.get(d.unifiDeviceId) ?? new Map<string, Set<string>>();
          const seenOn = byKey.get(read.keyId) ?? new Set<string>();
          seenOn.add(hostId);
          byKey.set(read.keyId, seenOn);
          hostsByDeviceByKey.set(d.unifiDeviceId, byKey);
          if (!merged.some((m) => m.unifiDeviceId === d.unifiDeviceId)) merged.push(d);
        }
        devicesByHost.set(hostId, merged);
      }
    }
    // Keys that disagree on which hosts a device is under (a console mid-move
    // between scopes): the per-connection upsert would move it into whichever
    // host's org is written last, so quarantine it. Keys that agree, including
    // one key alone reporting it under two hosts, are left as the single-key
    // engine always handled them.
    const hostSetKey = (hosts: Set<string>) => [...hosts].sort().join('\u0000');
    for (const [deviceId, byKey] of hostsByDeviceByKey) {
      if (new Set([...byKey.values()].map(hostSetKey)).size > 1) conflictingDeviceIds.add(deviceId);
    }
    if (conflictingDeviceIds.size > 0) {
      for (const [hostId, list] of devicesByHost) {
        devicesByHost.set(hostId, list.filter((d) => !conflictingDeviceIds.has(d.unifiDeviceId)));
      }
    }
  }

  // Which hosts each key "lists": its /v1/hosts and /v1/sites rows.
  const listedHostsOf = (read: KeyRead): Set<string> => {
    const listed = new Set<string>((read.hosts ?? []).map((h) => h.id));
    for (const s of read.siteRead?.sites ?? []) if (s.hostId) listed.add(s.hostId);
    return listed;
  };

  // D5(b): a working key lists the host but returned no device group for it,
  // while another key did. (No group from any key is the per-mapping
  // "not present in /v1/devices" error instead, as with one key.)
  const coverageGapHostIds = new Set<string>();
  const coverageGapKeyIds = new Map<string, string[]>();
  if (devicesByHost) {
    for (const read of deviceReads) {
      for (const hostId of listedHostsOf(read)) {
        if (devicesByHost.has(hostId) && !read.devicesByHost!.has(hostId)) {
          coverageGapHostIds.add(hostId);
          push(coverageGapKeyIds, hostId, read.keyId);
        }
      }
    }
  }

  // Strict site-count evidence: distinct sites per host per key.
  const hostSiteCounts = new Map<string, Map<string, number>>();
  for (const read of reads) {
    if (!read.siteRead) continue;
    const seenHosts = listedHostsOf(read);
    if (read.ok) for (const hostId of read.devicesByHost?.keys() ?? []) seenHosts.add(hostId);
    for (const hostId of seenHosts) {
      const distinct = new Set(read.siteRead.sites.filter((s) => s.hostId === hostId).map((s) => s.id));
      const counts = hostSiteCounts.get(hostId) ?? new Map<string, number>();
      counts.set(read.keyId, distinct.size);
      hostSiteCounts.set(hostId, counts);
    }
  }

  // ISP metrics: any working key's failure drops the whole map (wan_metrics stays
  // untouched everywhere). A bare-site-id entry from two keys is ambiguous: drop it.
  const okReads = reads.filter((r): r is Extract<KeyRead, { ok: true }> => r.ok);
  const metricsFailure = okReads.find((r) => r.metricsError !== undefined);
  let metricsBySite: Map<string, UnifiIspMetrics> | undefined;
  let metricsError: string | undefined;
  if (metricsFailure) {
    metricsError = reads.length > 1 ? `"${metricsFailure.label}": ${metricsFailure.metricsError}` : metricsFailure.metricsError;
  } else {
    const metricReads = okReads.filter((r) => r.metricsBySite !== undefined);
    if (metricReads.length > 0) {
      metricsBySite = new Map();
      const bareSuppliers = new Map<string, number>();
      for (const read of metricReads) {
        for (const [k, v] of read.metricsBySite!) {
          if (!k.includes('::')) bareSuppliers.set(k, (bareSuppliers.get(k) ?? 0) + 1);
          if (!metricsBySite.has(k)) metricsBySite.set(k, v);
        }
      }
      for (const [k, count] of bareSuppliers) if (count > 1) metricsBySite.delete(k);
    }
  }

  return {
    hosts,
    siteRead,
    devicesByHost,
    metricsBySite,
    metricsError,
    hostKeyIds,
    siteKeyIds,
    coverageGapHostIds,
    coverageGapKeyIds,
    hostSiteCounts,
    conflictingDeviceIds,
    failedKeys,
  };
}
