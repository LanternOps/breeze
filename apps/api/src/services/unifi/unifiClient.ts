import { safeFetch } from '../urlSafety';

export class UnifiApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'UnifiApiError';
    this.status = status;
    this.code = code;
  }
}

export interface UnifiHost { id: string; name: string; type: string | null; model: string | null }
export interface UnifiSite { id: string; hostId: string; name: string }
export interface UnifiDeviceDto {
  unifiDeviceId: string;
  mac: string | null;
  name: string | null;
  model: string | null;
  deviceType: string | null;
  ip: string | null;
  firmwareVersion: string | null;
  firmwareUpdatable: boolean | null;
  adoptionState: string | null;
  uptimeSeconds: number | null;
  raw: unknown;
}
export interface UnifiIspMetrics {
  latencyMs: number | null;
  packetLoss: number | null;
  uptimePercent: number | null;
  isp: string | null;
  raw: unknown;
}
export interface UnifiClient {
  listHosts(): Promise<UnifiHost[]>;
  listSites(): Promise<UnifiSite[]>;
  /** One paged /v1/sites read for the sync's device-attribution check. sites is
   * exactly what listSites returns. hostsWithDroppedRows identifies hosts with
   * dropped site rows whose true site count is unknown. rowsWithoutHostId counts
   * every row without a host ID (valid site ID or not), which could belong to any host. */
  listSitesForSync(): Promise<{
    sites: UnifiSite[];
    hostsWithDroppedRows: Set<string>;
    rowsWithoutHostId: number;
  }>;
  /** A host absent from the map is not an empty host: it may be offline/non-reporting,
   * or the account is not owner/super-admin on it. Callers must treat absence as an
   * error, never as zero devices. */
  listDevicesByHost(): Promise<Map<string, UnifiDeviceDto[]>>;
  /** Keys are ispMetricsKey(hostId, siteId) when a host ID is present, otherwise
   * the bare site ID. The first entry for each key wins. */
  listIspMetricsBySite(): Promise<Map<string, UnifiIspMetrics>>;
}

export function ispMetricsKey(hostId: string, siteId: string): string {
  return `${hostId}::${siteId}`;
}

interface UnifiClientConfig { baseUrl: string; apiKey: string; fetchImpl?: typeof safeFetch; sleepImpl?: (ms: number) => Promise<void> }

// Explicit because the default page is small (believed 25). 100 stays well under
// the documented maximum we have seen (200), but is not verified against a live
// key. The page cap fails loudly instead of truncating.
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

// The Site Manager (cloud) /v1/devices payload reports firmware as a status string
// ("upToDate" | "upgradable" | …), not the boolean the local API uses. Normalize
// to the boolean our schema stores, tolerating the local field names too.
function firmwareUpdatable(d: Record<string, unknown>): boolean | null {
  if (typeof d.firmwareUpdatable === 'boolean') return d.firmwareUpdatable;
  if (typeof d.upgradable === 'boolean') return d.upgradable;
  const status = str(d.firmwareStatus)?.toLowerCase();
  if (status === 'uptodate') return false;
  if (status === 'upgradable' || status === 'updatable') return true;
  // Unknown/indeterminate status ("checking", "pending", a new enum, …) must stay
  // null — coercing it to `true` would raise false "update available" alerts.
  return null;
}

function mapDevices(rows: Array<Record<string, unknown>>): UnifiDeviceDto[] {
  return rows.flatMap((d) => {
    // Cloud device `id` is the MAC. Skip a device with no usable identity rather
    // than coercing to the string "undefined"/"null" — that id is the upsert key,
    // so a sentinel would collide id-less devices into one phantom row.
    const id = str(d.id) ?? str(d.mac);
    if (!id) return [];
    return [{
      unifiDeviceId: id,
      mac: str(d.mac) ?? str(d.id),
      name: str(d.name),
      model: str(d.model),
      deviceType: str(d.type),
      // IP/uptime are absent from the cloud payload (local/agent telemetry only) —
      // read them anyway so a richer source feeding this mapper works.
      ip: str(d.ip ?? d.ipAddress),
      firmwareVersion: str(d.version ?? d.firmwareVersion),
      firmwareUpdatable: firmwareUpdatable(d),
      adoptionState: str(d.status ?? d.state ?? d.adoptionState),
      uptimeSeconds: num(d.uptime),
      raw: d,
    }];
  });
}

function parseSites(rows: Array<Record<string, unknown>>): Awaited<ReturnType<UnifiClient['listSitesForSync']>> {
  const hostsWithDroppedRows = new Set<string>();
  let rowsWithoutHostId = 0;
  const mapped = rows
    .map((s) => {
      // /v1/sites identifies the site by `siteId` (no top-level id) and carries
      // its name under `meta.name`. The old String(s.id) parse is what wrote
      // unifi_site_id="undefined" and 404'd every downstream sync call.
      const id = str(s.siteId) ?? str(s.id) ?? '';
      const name = str(obj(s.meta).name) ?? str(s.name) ?? id;
      const hostId = String(s.hostId ?? s.host_id ?? '');
      if (!hostId) rowsWithoutHostId += 1;
      return { id, hostId, name };
    })
    // Never persist a malformed site id — a missing siteId must drop the row,
    // not become the literal "undefined"/"null" string.
    .filter((s) => {
      const valid = s.id.length > 0 && s.id !== 'undefined' && s.id !== 'null';
      if (!valid && s.hostId) hostsWithDroppedRows.add(s.hostId);
      return valid;
    });
  // Dropping every row (while the API returned some) almost certainly means the
  // payload shape changed under us — surface it instead of silently reporting an
  // empty account, which reads to the user as "no sites".
  if (rows.length > 0 && mapped.length === 0) {
    console.warn(`[unifi] listSites: dropped all ${rows.length} site row(s) as malformed — /v1/sites shape may have changed`);
  }
  return { sites: mapped, hostsWithDroppedRows, rowsWithoutHostId };
}

// 5-minute granularity (24h retention) — the freshest ISP samples for "latest WAN".
const ISP_METRIC_TYPE = '5m';

export function createUnifiClient(cfg: UnifiClientConfig): UnifiClient {
  const fetchImpl = cfg.fetchImpl ?? safeFetch;
  const sleepImpl = cfg.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const base = cfg.baseUrl.replace(/\/+$/, '');

  async function request(path: string) {
    const fetchGet = () => fetchImpl(`${base}${path}`, {
      method: 'GET',
      headers: { 'X-API-KEY': cfg.apiKey, accept: 'application/json' },
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
    });
    let res = await fetchGet();
    for (let attempt = 0; res.status === 429 && attempt < MAX_RETRIES; attempt += 1) {
      const retryAfter = res.headers.get('retry-after');
      const retryDelayMs = retryAfter && /^\d+$/.test(retryAfter)
        ? Number.parseInt(retryAfter, 10) * 1000
        : DEFAULT_RETRY_DELAY_MS;
      await sleepImpl(Math.min(retryDelayMs, MAX_RETRY_DELAY_MS));
      res = await fetchGet();
    }
    const body = (await res.json().catch(() => null)) as { data?: unknown; nextToken?: unknown; message?: string; meta?: { rc?: string; msg?: string } } | null;
    if (!res.ok) {
      throw new UnifiApiError(body?.message ?? body?.meta?.msg ?? `UniFi API ${res.status}`, res.status, body?.meta?.msg);
    }
    if (body?.meta?.rc === 'error') {
      throw new UnifiApiError(body.meta.msg ?? 'UniFi API error', res.status, body.meta.msg);
    }
    return body;
  }

  async function getAll<T>(path: string, opts: { pageSize?: number } = {}): Promise<T[]> {
    const rows: T[] = [];
    const seenTokens = new Set<string>();
    let nextToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params = new URLSearchParams();
      if (opts.pageSize !== undefined) params.set('pageSize', String(opts.pageSize));
      if (nextToken) params.set('nextToken', nextToken);
      const query = params.toString();
      const body = await request(query ? `${path}?${query}` : path);
      if (body == null && page > 0) {
        throw new UnifiApiError(`UniFi ${path} returned an empty or unreadable page ${page + 1}; refusing to return a partial list`, 502);
      }
      // Distinguish an explicit `data: null` (a valid empty page, e.g. no ISP
      // metrics) from a missing envelope: `?? body` would wrongly treat the whole
      // envelope as the page on `data: null`.
      const data = body && typeof body === 'object' && !Array.isArray(body) && 'data' in body
        ? body.data : body;
      if (data != null) {
        if (!Array.isArray(data)) {
          throw new UnifiApiError(`UniFi ${path} returned a non-list payload`, 502);
        }
        rows.push(...data);
      }
      const token = body?.nextToken;
      if (token != null && typeof token !== 'string') {
        throw new UnifiApiError(`UniFi ${path} returned a non-string pagination token`, 502);
      }
      nextToken = str(token) ?? undefined;
      if (!nextToken) return rows;
      if (seenTokens.has(nextToken)) {
        throw new UnifiApiError(`UniFi ${path} repeated a pagination token`, 502);
      }
      seenTokens.add(nextToken);
    }
    throw new UnifiApiError(`UniFi ${path} returned more than ${MAX_PAGES} pages; refusing to return a partial list`, 502);
  }

  return {
    async listHosts() {
      // getAll returns [] for a `data: null` / 204 empty result, so the .map() can't
      // throw an opaque 500 ("Cannot read properties of null").
      const rows = await getAll<Record<string, unknown>>('/v1/hosts', { pageSize: PAGE_SIZE });
      return rows.map((h) => {
        const id = String(h.id);
        // The console's user-facing name lives under reportedState, not top-level —
        // reading h.name fell straight through to the host id ("cryptic host IDs").
        const rs = obj(h.reportedState);
        const hw = obj(rs.hardware);
        const name = str(rs.name) ?? str(rs.hostname) ?? str(hw.name) ?? str(h.name) ?? id;
        return {
          id,
          name,
          // `type` ("console" | "network-server" | …) is surfaced for display;
          // `model` (hardware name) replaces showing a raw host id.
          type: str(h.type) ?? str(rs.type),
          model: str(hw.name) ?? str(hw.shortname),
        };
      });
    },
    async listSites() {
      const rows = await getAll<Record<string, unknown>>('/v1/sites', { pageSize: PAGE_SIZE });
      return parseSites(rows).sites;
    },
    async listSitesForSync() {
      const rows = await getAll<Record<string, unknown>>('/v1/sites', { pageSize: PAGE_SIZE });
      return parseSites(rows);
    },
    async listDevicesByHost() {
      // The cloud API exposes devices only via /v1/devices grouped by host (there is
      // no /v1/hosts/{id}/devices — that path 404'd and returned non-JSON). One host
      // can span two groups when its devices straddle a page break, so concatenate.
      const groups = await getAll<Record<string, unknown>>('/v1/devices', { pageSize: PAGE_SIZE });
      const byHost = new Map<string, UnifiDeviceDto[]>();
      const invalidHosts = new Set<string>();
      let malformedGroups = 0;
      for (const group of groups) {
        const hostId = String(group.hostId ?? '');
        if (!hostId) {
          if (!Array.isArray(group.devices) || group.devices.length > 0) {
            throw new UnifiApiError('UniFi /v1/devices returned a device group with no host id; refusing to sync a partial device list', 502);
          }
          continue;
        }
        if (!Array.isArray(group.devices)) {
          invalidHosts.add(hostId);
          malformedGroups += 1;
          continue;
        }
        byHost.set(hostId, [...(byHost.get(hostId) ?? []), ...mapDevices(group.devices)]);
      }
      // Any missing device list makes the host incomplete, even if another group
      // was valid. Omit it so sync fails that mapping instead of sweeping stale devices.
      for (const hostId of invalidHosts) byHost.delete(hostId);
      if (malformedGroups > 0) {
        console.warn(`[unifi] listDevicesByHost: ${malformedGroups} host group(s) had no device list — /v1/devices shape may have changed`);
      }
      return byHost;
    },
    async listIspMetricsBySite() {
      // /v1/isp-metrics/{type} returns samples for every site on the account (the old
      // per-site path /v1/sites/{id}/isp-metrics does not exist and 404'd). It
      // documents no paging params, so the request stays bare; getAll still follows
      // a nextToken if one ever appears.
      const rows = await getAll<Record<string, unknown>>(`/v1/isp-metrics/${ISP_METRIC_TYPE}`);
      const bySite = new Map<string, UnifiIspMetrics>();
      for (const entry of rows) {
        const siteId = String(entry.siteId ?? '');
        if (!siteId) continue;
        const hostId = String(entry.hostId ?? '');
        const key = hostId ? ispMetricsKey(hostId, siteId) : siteId;
        // First entry per key wins, preserving the old Array.find behavior without
        // conflating sites on different hosts that happen to share a site ID.
        if (bySite.has(key)) continue;
        const periods = (entry.periods as Array<Record<string, unknown>> | undefined) ?? [];
        const wan = obj(obj(periods[periods.length - 1]).data).wan;
        const w = obj(wan);
        bySite.set(key, {
          latencyMs: num(w.avgLatency ?? w.latencyAvg ?? w.latency),
          packetLoss: num(w.packetLoss ?? w.loss),
          uptimePercent: num(w.uptime ?? w.uptimePercent),
          isp: str(w.ispName ?? w.isp ?? w.provider),
          // Persist the whole site entry — wan_metrics stores `.raw`, and the cloud
          // metric shape is a time series we don't want to flatten away.
          raw: entry,
        });
      }
      return bySite;
    },
  };
}
