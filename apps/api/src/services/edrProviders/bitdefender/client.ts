import { randomUUID } from 'node:crypto';
import {
  EdrProviderRequestError,
  type EdrErrorScope,
  type EdrRateLimiter,
  type GuardedFetch,
} from '../types';

export interface GravityZoneCredentials { apiKey: string }

export const GZ_HOST_ALLOWLIST = ['.gravityzone.bitdefender.com'] as const;
/** Hard stop on pagination (a vendor that ignores `page` must not pin a worker forever). */
export const GZ_MAX_PAGES = 200;
export const GZ_INVENTORY_PAGE_SIZE = 1000;
/** `getIncidentsList` accepts perPage 10..10000 (live probe 2026-10-08). */
export const GZ_INCIDENTS_PAGE_SIZE = 1000;
export const GZ_QUARANTINE_PAGE_SIZE = 100;

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;
/** Retry-After values above this are not slept on — the run backs off via the queue instead. */
const MAX_INLINE_RETRY_AFTER_MS = 65_000;
const DEFAULT_RETRY_AFTER_MS = 60_000;

export type GzOperationClass = 'default' | 'inventory' | 'companies' | 'incidents';
type GzVersion = '1.0' | '1.1' | '1.2';

export interface GzInventoryItem {
  id: string;
  name?: string;
  type?: number;
  companyId?: string;
  parentId?: string;
  details?: {
    fqdn?: string; ip?: string; macs?: string[]; isManaged?: boolean; machineType?: number;
    operatingSystemVersion?: string; isIsolated?: boolean; policy?: { id?: string; name?: string; applied?: boolean };
    productOutdated?: boolean; lastSuccessfulScan?: unknown; modules?: Record<string, unknown>;
  };
}

export interface GzEndpointDetails {
  id?: string; name?: string; operatingSystem?: string; state?: number | string; lastSeen?: string;
  agent?: { productVersion?: string; signatureOutdated?: boolean; productOutdated?: boolean; licensed?: boolean };
  malwareStatus?: { detection?: boolean; infected?: boolean };
}

export interface GzIncident {
  incidentId: string; incidentNumber?: number | string;
  company?: { id?: string; name?: string };
  status?: number | string; mainAction?: string; created?: string; lastUpdated?: string;
  lastIncidentChange?: string; severityScore?: number | null; priority?: number | string;
  attackTypes?: string[]; incidentLink?: string;
  details?: { detectionName?: string; computerId?: string; [k: string]: unknown };
}

export interface GzQuarantineItem {
  id: string; quarantinedOn?: string; actionStatus?: string | number; companyId?: string;
  endpointId?: string; endpointName?: string; threatName?: string;
  canBeRestored?: boolean; canBeRemoved?: boolean;
  details?: { filePath?: string; fileSha256?: string };
}

export interface GzApiKeyDetails { enabledApis?: string[]; createdAt?: string }

export interface GravityZoneClientOptions {
  accessUrl: string;
  creds: GravityZoneCredentials;
  fetch: GuardedFetch;
  limiter: EdrRateLimiter;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  logger?: Pick<Console, 'warn'>;
}

interface RpcEnvelope {
  result?: unknown;
  error?: { code?: number; message?: string; data?: { details?: unknown } } | null;
}

interface CallOptions {
  operationClass?: GzOperationClass;
  /** Scope for a generic -32001 "forbidden" on a non-key call. Default 'tenant'. */
  scope?: EdrErrorScope;
  /** True for calls that identify the key itself (getOwnCompany/getApiKeyDetails): -32001 means a dead key. */
  keyProbe?: boolean;
}

const API_NOT_ENABLED = /not allowed to access the selected API/i;
const LICENCE = /licen[cs]e/i;

function parseRetryAfterMs(headers: Headers): number | undefined {
  // Observed as "60" or "60, 60" (the vendor duplicates the header).
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const secs = Number.parseInt(raw.split(',')[0].trim(), 10);
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : undefined;
}

function parseJson(text: string): RpcEnvelope | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as RpcEnvelope) : null;
  } catch {
    return null;
  }
}

/**
 * GravityZone JSON-RPC 2.0 client. API-key auth (HTTP Basic, key as username), so there is
 * no token or session state. Classification is by HTTP status first, then JSON-RPC code.
 * Nothing here ever logs or embeds the API key.
 */
export class GravityZoneClient {
  private readonly accessUrl: string;
  private readonly authHeader: string;
  private readonly apiKey: string;
  private readonly fetchImpl: GuardedFetch;
  private readonly limiter: EdrRateLimiter;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly logger: Pick<Console, 'warn'>;
  private readonly reportedUnknownCodes = new Set<number>();

  constructor(o: GravityZoneClientOptions) {
    this.accessUrl = o.accessUrl.replace(/\/+$/, '');
    this.apiKey = o.creds.apiKey;
    this.authHeader = `Basic ${Buffer.from(`${o.creds.apiKey}:`).toString('base64')}`;
    this.fetchImpl = o.fetch;
    this.limiter = o.limiter;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = o.logger ?? console;
  }

  /** Strip the key from any vendor-supplied text before it can reach an error or log. */
  private scrub(text: string): string {
    return this.apiKey ? text.split(this.apiKey).join('[redacted]') : text;
  }

  private fail(
    message: string,
    o: { code: string; reauth?: boolean; scope: EdrErrorScope; retryAfterMs?: number },
  ): EdrProviderRequestError {
    return new EdrProviderRequestError(this.scrub(message), {
      code: o.code, reauth: o.reauth ?? false, scope: o.scope, retryAfterMs: o.retryAfterMs,
    });
  }

  async call<T>(
    service: string,
    version: GzVersion,
    method: string,
    params: Record<string, unknown>,
    o: CallOptions = {},
  ): Promise<T> {
    const url = `${this.accessUrl}/v${version}/jsonrpc/${service}`;
    const body = JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params });
    const label = `GravityZone ${service}.${method}`;
    let attempt = 0;
    let rateLimitRetried = false;

    for (;;) {
      await this.limiter.acquire(o.operationClass ?? 'default');
      let status = 0;
      let headers = new Headers();
      let text = '';
      let networkError: unknown = null;
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { Authorization: this.authHeader, 'Content-Type': 'application/json' },
          body,
          timeoutMs: this.timeoutMs,
        });
        status = res.status;
        headers = res.headers;
        text = await res.text();
      } catch (error) {
        networkError = error;
      }

      // Transient: network failure, 5xx, or an unparseable 2xx body.
      const transient = (reason: string, code: string): 'retry' => {
        attempt += 1;
        if (attempt >= MAX_ATTEMPTS) {
          throw this.fail(`${label} failed: ${reason}`, { code, scope: 'operation' });
        }
        return 'retry';
      };

      if (networkError) {
        // The cause is intentionally dropped: socket errors can embed request details.
        transient('network error', 'upstream_error');
        await this.sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
        continue;
      }

      // 1. HTTP status first (429 bodies are nginx HTML, never JSON).
      if (status === 401) {
        throw this.fail(`${label}: API key rejected (HTTP 401)`, { code: 'auth', reauth: true, scope: 'connection' });
      }
      if (status === 429) {
        const retryAfterMs = parseRetryAfterMs(headers);
        await this.handleRateLimit(label, retryAfterMs, rateLimitRetried);
        rateLimitRetried = true;
        continue;
      }
      if (status >= 500) {
        transient(`HTTP ${status}`, 'upstream_error');
        await this.sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
        continue;
      }

      const env = parseJson(text);

      if (status === 403) {
        const detail = env?.error?.data?.details;
        throw this.fail(
          `${label}: API not enabled on this key (HTTP 403)${typeof detail === 'string' ? `: ${detail}` : ''}`,
          { code: 'api_not_enabled', scope: 'operation' },
        );
      }
      if (!env) {
        if (status >= 200 && status < 300) {
          transient('response was not JSON', 'malformed_response');
          await this.sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
          continue;
        }
        throw this.fail(`${label} failed: HTTP ${status}`, { code: 'http_error', scope: 'operation' });
      }

      if (env.error) {
        if (env.error.code === -32003) {
          await this.handleRateLimit(label, parseRetryAfterMs(headers), rateLimitRetried);
          rateLimitRetried = true;
          continue;
        }
        throw this.classifyRpcError(label, method, env.error, o);
      }
      if (status < 200 || status >= 300) {
        throw this.fail(`${label} failed: HTTP ${status}`, { code: 'http_error', scope: 'operation' });
      }
      return env.result as T;
    }
  }

  /** Honour a rate limit exactly once; a second one (or a long wait) surfaces to the caller. */
  private async handleRateLimit(label: string, retryAfterMs: number | undefined, alreadyRetried: boolean): Promise<void> {
    const wait = retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
    if (alreadyRetried || wait > MAX_INLINE_RETRY_AFTER_MS) {
      throw this.fail(`${label}: rate limited`, {
        code: 'rate_limited', scope: 'connection', retryAfterMs: wait,
      });
    }
    await this.sleep(wait);
  }

  private classifyRpcError(
    label: string,
    method: string,
    err: NonNullable<RpcEnvelope['error']>,
    o: CallOptions,
  ): EdrProviderRequestError {
    const code = typeof err.code === 'number' ? err.code : 0;
    const details = typeof err.data?.details === 'string' ? err.data.details : '';
    const msg = typeof err.message === 'string' ? err.message : '';
    const text = `${msg}${details ? ` (${details})` : ''}`;
    const haystack = `${msg} ${details}`;
    const base = `${label} failed: ${text || `code ${code}`}`;

    // Detail text wins regardless of the JSON-RPC code (-32000 / -32001 both observed).
    if (API_NOT_ENABLED.test(haystack)) return this.fail(base, { code: 'api_not_enabled', scope: 'operation' });
    if ((code === -32000 || code === -32001) && LICENCE.test(haystack)) {
      return this.fail(base, { code: 'licence', scope: 'operation' });
    }
    switch (code) {
      case -32001:
        return o.keyProbe
          ? this.fail(base, { code: 'auth', reauth: true, scope: 'connection' })
          : this.fail(base, { code: 'forbidden', scope: o.scope ?? 'tenant' });
      case -32002:
        return this.fail(base, { code: 'not_found', scope: 'tenant' });
      case -32602:
        return this.fail(base, { code: 'invalid_params', scope: 'tenant' });
      case -32601:
        return this.fail(`${label}: method not found`, { code: 'method_not_found', scope: 'operation' });
      case -32000:
      case -32600:
      case -32700:
        return this.fail(base, { code: 'vendor_error', scope: 'operation' });
      default:
        if (!this.reportedUnknownCodes.has(code)) {
          this.reportedUnknownCodes.add(code);
          // Code only — never the payload.
          this.logger.warn(`[edr:bitdefender] unrecognised JSON-RPC error code ${code} from ${method}`);
        }
        return this.fail(base, { code: 'vendor_error', scope: 'operation' });
    }
  }

  // ---- typed helpers -------------------------------------------------------

  async getOwnCompany(): Promise<{ id: string; name: string; type: number }> {
    const r = await this.call<{ id: string; name: string; type: number }>(
      'companies', '1.0', 'getCompanyDetails', {}, { operationClass: 'companies', keyProbe: true },
    );
    if (!r || typeof r.id !== 'string') {
      throw this.fail('GravityZone getCompanyDetails returned no company id', { code: 'malformed_response', scope: 'operation' });
    }
    return r;
  }

  async getApiKeyDetails(): Promise<GzApiKeyDetails> {
    const r = await this.call<GzApiKeyDetails>('general', '1.0', 'getApiKeyDetails', {}, { keyProbe: true });
    return r ?? {};
  }

  async getCompaniesList(parentId: string, companyType?: 0 | 1): Promise<Array<{ id: string; name: string }>> {
    const params: Record<string, unknown> = { parentId };
    if (companyType !== undefined) params.filters = { companyType };
    const r = await this.call<unknown>('network', '1.0', 'getCompaniesList', params, { operationClass: 'companies' });
    if (!Array.isArray(r)) {
      throw this.fail('GravityZone getCompaniesList did not return a list', { code: 'malformed_response', scope: 'operation' });
    }
    return r as Array<{ id: string; name: string }>;
  }

  private inventoryParams(companyId: string, page: number, perPage: number): Record<string, unknown> {
    return {
      parentId: companyId,
      filters: { type: { computers: true, virtualMachines: true }, depth: { allItemsRecursively: true } },
      page,
      perPage,
    };
  }

  /** Every inventory item under `companyId`; any page failure throws (never a partial list). */
  async getInventoryAll(companyId: string): Promise<GzInventoryItem[]> {
    const out: GzInventoryItem[] = [];
    for (let page = 1; page <= GZ_MAX_PAGES; page++) {
      const r = await this.call<{ hasMoreRecords?: boolean; items?: GzInventoryItem[] }>(
        'network', '1.1', 'getNetworkInventoryItems',
        this.inventoryParams(companyId, page, GZ_INVENTORY_PAGE_SIZE), { operationClass: 'inventory' },
      );
      const items = Array.isArray(r?.items) ? r.items : [];
      out.push(...items);
      if (!r?.hasMoreRecords || items.length === 0) return out;
    }
    throw this.fail(`GravityZone inventory exceeded ${GZ_MAX_PAGES} pages`, { code: 'too_many_pages', scope: 'tenant' });
  }

  async getInventoryTotal(companyId: string): Promise<number> {
    const r = await this.call<{ total?: number }>(
      'network', '1.1', 'getNetworkInventoryItems', this.inventoryParams(companyId, 1, 1), { operationClass: 'inventory' },
    );
    return typeof r?.total === 'number' ? r.total : 0;
  }

  async getEndpointDetails(endpointId: string): Promise<GzEndpointDetails> {
    return this.call<GzEndpointDetails>('network', '1.0', 'getManagedEndpointDetails', { endpointId });
  }

  /**
   * Connection-wide (NO companyId filter): incidents are limited to 3 requests/60 s per key, so
   * the adapter fetches once per run and filters per tenant. Paginates by `pagesCount`
   * (this API has no `hasMoreRecords`). Any page failure throws.
   */
  async getIncidentsChangedBetween(from: Date, to: Date): Promise<GzIncident[]> {
    const out: GzIncident[] = [];
    for (let page = 1; page <= GZ_MAX_PAGES; page++) {
      const r = await this.call<{ pagesCount?: number; items?: GzIncident[] }>(
        'incidents', '1.2', 'getIncidentsList',
        {
          page,
          perPage: GZ_INCIDENTS_PAGE_SIZE,
          filters: { changeStartDate: from.toISOString(), changeEndDate: to.toISOString() },
          options: { sortBy: 'lastIncidentChange' },
        },
        { operationClass: 'incidents' },
      );
      const items = Array.isArray(r?.items) ? r.items : [];
      out.push(...items);
      if (items.length === 0 || page >= (r?.pagesCount ?? 0)) return out;
    }
    throw this.fail(`GravityZone incidents exceeded ${GZ_MAX_PAGES} pages`, { code: 'too_many_pages', scope: 'operation' });
  }

  /** Connection-wide quarantine list for a quarantine-date window. Any page failure throws. */
  async getQuarantineBetween(from: Date, to: Date): Promise<GzQuarantineItem[]> {
    const out: GzQuarantineItem[] = [];
    for (let page = 1; page <= GZ_MAX_PAGES; page++) {
      const r = await this.call<{ pagesCount?: number; hasMoreRecords?: boolean; items?: GzQuarantineItem[] }>(
        'quarantine/computers', '1.1', 'getQuarantineItemsList',
        {
          page,
          perPage: GZ_QUARANTINE_PAGE_SIZE,
          filters: { startDate: from.toISOString(), endDate: to.toISOString() },
        },
      );
      const items = Array.isArray(r?.items) ? r.items : [];
      out.push(...items);
      if (items.length === 0) return out;
      const more = typeof r?.pagesCount === 'number'
        ? page < r.pagesCount
        : r?.hasMoreRecords === true || items.length >= GZ_QUARANTINE_PAGE_SIZE;
      if (!more) return out;
    }
    throw this.fail(`GravityZone quarantine exceeded ${GZ_MAX_PAGES} pages`, { code: 'too_many_pages', scope: 'operation' });
  }
}
