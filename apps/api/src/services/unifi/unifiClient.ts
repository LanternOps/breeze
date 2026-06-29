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

export interface UnifiHost { id: string; name: string }
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

interface UnifiClientConfig { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch }

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

export function createUnifiClient(cfg: UnifiClientConfig): UnifiClient {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const base = cfg.baseUrl.replace(/\/+$/, '');

  async function get<T>(path: string): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      method: 'GET',
      headers: { 'X-API-KEY': cfg.apiKey, accept: 'application/json' },
    });
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
      const rows = await get<Array<Record<string, unknown>>>('/v1/hosts');
      return rows.map((h) => ({ id: String(h.id), name: str(h.name) ?? String(h.id) }));
    },
    async listSites() {
      const rows = await get<Array<Record<string, unknown>>>('/v1/sites');
      return rows.map((s) => ({ id: String(s.id), hostId: String(s.hostId ?? s.host_id ?? ''), name: str(s.name) ?? String(s.id) }));
    },
    async listDevices(hostId: string) {
      const rows = await get<Array<Record<string, unknown>>>(`/v1/hosts/${encodeURIComponent(hostId)}/devices`);
      return rows.map((d) => ({
        unifiDeviceId: String(d.id),
        mac: str(d.mac),
        name: str(d.name),
        model: str(d.model),
        deviceType: str(d.type),
        ip: str(d.ipAddress ?? d.ip),
        firmwareVersion: str(d.firmwareVersion ?? d.version),
        firmwareUpdatable: bool(d.firmwareUpdatable ?? d.upgradable),
        adoptionState: str(d.state ?? d.adoptionState),
        uptimeSeconds: num(d.uptime),
        raw: d,
      }));
    },
    async getIspMetrics(siteId: string) {
      const data = await get<Record<string, unknown> | null>(`/v1/sites/${encodeURIComponent(siteId)}/isp-metrics`);
      if (!data) return null;
      return {
        latencyMs: num(data.latencyMs ?? data.latency),
        packetLoss: num(data.packetLoss ?? data.loss),
        uptimePercent: num(data.uptimePercent ?? data.uptime),
        isp: str(data.isp ?? data.provider),
        raw: data,
      };
    },
  };
}
