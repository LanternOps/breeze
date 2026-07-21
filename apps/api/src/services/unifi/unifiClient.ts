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
  listDevices(hostId: string): Promise<UnifiDeviceDto[]>;
  getIspMetrics(siteId: string): Promise<UnifiIspMetrics | null>;
}

interface UnifiClientConfig { baseUrl: string; apiKey: string; fetchImpl?: typeof safeFetch; sleepImpl?: (ms: number) => Promise<void> }

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

// 5-minute granularity (24h retention) — the freshest ISP samples for "latest WAN".
const ISP_METRIC_TYPE = '5m';

export function createUnifiClient(cfg: UnifiClientConfig): UnifiClient {
  const fetchImpl = cfg.fetchImpl ?? safeFetch;
  const sleepImpl = cfg.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const base = cfg.baseUrl.replace(/\/+$/, '');

  async function get<T>(path: string): Promise<T> {
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
    const body = (await res.json().catch(() => null)) as { data?: unknown; message?: string; meta?: { rc?: string; msg?: string } } | null;
    if (!res.ok) {
      throw new UnifiApiError(body?.message ?? body?.meta?.msg ?? `UniFi API ${res.status}`, res.status, body?.meta?.msg);
    }
    if (body?.meta?.rc === 'error') {
      throw new UnifiApiError(body.meta.msg ?? 'UniFi API error', res.status, body.meta.msg);
    }
    // Distinguish an explicit `data: null` (a valid empty result, e.g. no ISP
    // metrics) from a missing envelope: `?? body` would wrongly return the whole
    // envelope on `data: null`, breaking list `.map()` and getIspMetrics's null path.
    return (body && 'data' in body ? body.data : body) as T;
  }

  return {
    async listHosts() {
      // Coerce a `data: null` / 204 empty result to [] so the .map() can't throw
      // an opaque 500 ("Cannot read properties of null").
      const rows = (await get<Array<Record<string, unknown>> | null>('/v1/hosts')) ?? [];
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
          // `type` ("console" | "network-server" | …) lets the UI keep only mappable
          // consoles; `model` (hardware name) replaces showing a raw host id.
          type: str(h.type) ?? str(rs.type),
          model: str(hw.name) ?? str(hw.shortname),
        };
      });
    },
    async listSites() {
      const rows = (await get<Array<Record<string, unknown>> | null>('/v1/sites')) ?? [];
      const mapped = rows
        .map((s) => {
          // /v1/sites identifies the site by `siteId` (no top-level id) and carries
          // its name under `meta.name`. The old String(s.id) parse is what wrote
          // unifi_site_id="undefined" and 404'd every downstream sync call.
          const id = str(s.siteId) ?? str(s.id) ?? '';
          const name = str(obj(s.meta).name) ?? str(s.name) ?? id;
          return { id, hostId: String(s.hostId ?? s.host_id ?? ''), name };
        })
        // Never persist a malformed site id — a missing siteId must drop the row,
        // not become the literal "undefined"/"null" string.
        .filter((s) => s.id.length > 0 && s.id !== 'undefined' && s.id !== 'null');
      // Dropping every row (while the API returned some) almost certainly means the
      // payload shape changed under us — surface it instead of silently reporting an
      // empty account, which reads to the user as "no sites".
      if (rows.length > 0 && mapped.length === 0) {
        console.warn(`[unifi] listSites: dropped all ${rows.length} site row(s) as malformed — /v1/sites shape may have changed`);
      }
      return mapped;
    },
    async listDevices(hostId: string) {
      // The cloud API exposes devices via /v1/devices grouped by host (there is no
      // /v1/hosts/{id}/devices — that path 404'd and returned non-JSON). Fetch the
      // grouped list and return only the requested host's devices.
      const groups = (await get<Array<Record<string, unknown>> | null>('/v1/devices')) ?? [];
      const group = groups.find((g) => String(g.hostId ?? '') === hostId);
      // A host *absent* from the grouped payload (offline/non-reporting console, or a
      // host-id keying mismatch) is NOT an empty host. Returning [] here would let the
      // sync stale-sweep unlink every still-good device on that mapping while reporting
      // success — throw so the caller routes it to the per-mapping error path instead.
      if (!group) {
        throw new UnifiApiError(`UniFi host ${hostId} not present in /v1/devices`, 404);
      }
      const rows = (group.devices as Array<Record<string, unknown>> | undefined) ?? [];
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
    },
    async getIspMetrics(siteId: string) {
      // /v1/isp-metrics/{type} returns samples for every site on the account; select
      // the requested site and take its latest WAN sample. (The old per-site path
      // /v1/sites/{id}/isp-metrics does not exist and 404'd.)
      const rows = (await get<Array<Record<string, unknown>> | null>(`/v1/isp-metrics/${ISP_METRIC_TYPE}`)) ?? [];
      const entry = rows.find((r) => String(r.siteId ?? '') === siteId);
      if (!entry) return null;
      const periods = (entry.periods as Array<Record<string, unknown>> | undefined) ?? [];
      const wan = obj(obj(periods[periods.length - 1]).data).wan;
      const w = obj(wan);
      return {
        latencyMs: num(w.avgLatency ?? w.latencyAvg ?? w.latency),
        packetLoss: num(w.packetLoss ?? w.loss),
        uptimePercent: num(w.uptime ?? w.uptimePercent),
        isp: str(w.ispName ?? w.isp ?? w.provider),
        // Persist the whole site entry — wan_metrics stores `.raw`, and the cloud
        // metric shape is a time series we don't want to flatten away.
        raw: entry,
      };
    },
  };
}
