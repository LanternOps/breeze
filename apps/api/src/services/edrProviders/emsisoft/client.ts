import { z } from 'zod';
import {
  EdrProviderRequestError,
  type EdrErrorScope,
  type EdrRateLimiter,
  type GuardedFetch,
} from '../types';

/** Exact host (index correction 8): no leading dot, so `xapi.emsisoft.com` and `api.emsisoft.com.evil.test` are refused. */
export const EMSISOFT_HOST_ALLOWLIST = ['api.emsisoft.com'] as const;

const BASE_URL = 'https://api.emsisoft.com';

export const EMSI_PAGE_SIZE = 100;
/** Hard stops (5,000 / 10,000 / 2,000 items): a list past its cap throws `too_many_*`, it is never truncated. */
export const EMSI_MAX_PAGES = { workspaces: 50, devices: 100, incidents: 20 } as const;

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_AFTER_MS = 5_000;
const MAX_RETRY_AFTER_MS = 120_000;

/**
 * Which kind of path a request targets decides the error scope. `/account` is the
 * only call whose 401 proves a dead key: the API documents every 401 as
 * "insufficient permissions OR API-key not provided".
 */
export type EmsiPathKind = 'account' | 'workspaces' | 'workspace' | 'device';

// ---- DTOs (only the fields the adapter uses; unknown fields tolerated) ----

const str = z.string().nullish();
const strList = z.array(z.string()).nullish();

const accountSchema = z.object({
  email: str,
  partners: z.array(z.object({ guid: z.string(), id: str, roles: strList }).passthrough()).nullish(),
}).passthrough();

const workspaceSchema = z.object({
  guid: z.string(), name: str, devices: z.number().nullish(), isExpired: z.boolean().nullish(),
}).passthrough();

const deviceSchema = z.object({
  guid: z.string(), name: str, status: str, lastUpdate: str, lastScan: str, lastAlert: str,
  protectionPolicyGroup: str, protectionPolicyGroupGuid: str, lastUser: str,
}).passthrough();

const deviceDetailsSchema = z.object({
  name: str, domain: str, protectionStatus: str, os: str, version: str,
  updateStatus: z.object({ online: str }).passthrough().nullish(),
  networkAdapters: z.array(z.object({ iPv4Addresses: strList, iPv6Addresses: strList }).passthrough()).nullish(),
}).passthrough();

const incidentSchema = z.object({
  guid: z.string(), type: str, verdict: str, actionTaken: str, actionsTaken: strList, highestSeverity: str,
  lastDetectionAt: str, detectionComponent: str, involvedDevices: strList, involvedDeviceUsers: strList,
  sha1: str, md5: str, sha256: str, knownFileNames: strList, hostAddress: str, detailsPageLink: str,
}).passthrough();

const incidentDetailSchema = z.object({
  verdict: str, actionTaken: str, actionsTaken: strList, severity: str,
  detections: z.array(z.object({ dateTime: str }).passthrough()).nullish(),
}).passthrough();

export type EmsiAccount = z.infer<typeof accountSchema>;
export type EmsiWorkspace = z.infer<typeof workspaceSchema>;
export type EmsiDevice = z.infer<typeof deviceSchema>;
export type EmsiDeviceDetails = z.infer<typeof deviceDetailsSchema>;
export type EmsiIncident = z.infer<typeof incidentSchema>;
export type EmsiIncidentDetail = z.infer<typeof incidentDetailSchema>;

export interface EmsisoftClientOptions {
  creds: { apiKey: string };
  fetch: GuardedFetch;
  limiter: EdrRateLimiter;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Called with the observed rate-limit headers whenever the set changes (an empty set on the first response means "none"). */
  onRateHeaders?: (headers: Record<string, string>) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A sha1/sha256 hash, a guid, or a web host / IP: what the incident endpoints document as the incident id. */
const INCIDENT_REF = /^[0-9a-f]{40}$|^[0-9a-f]{64}$|^[0-9a-f-]{36}$|^[a-z0-9.:-]{1,253}$/i;
const INCIDENT_MISSING_CODES = /\b(IncidentNotFound|WorkspaceThreatIncorrectTarget)\b/;
const RATE_HEADER_NAME = /^(x-)?(rate-?limit|ratelimit)[-a-z]*$|^retry-after$/i;
const RATE_HEADER_VALUE = /^[0-9a-zA-Z.:, -]{1,64}$/;

const MISSING = Symbol('emsisoft-missing');

function parseRetryAfterMs(headers: Headers): number {
  const raw = headers.get('retry-after');
  if (!raw) return DEFAULT_RETRY_AFTER_MS;
  const trimmed = raw.trim();
  let ms: number;
  if (/^\d+$/.test(trimmed)) ms = Number.parseInt(trimmed, 10) * 1000;
  else {
    const at = Date.parse(trimmed);
    ms = Number.isNaN(at) ? DEFAULT_RETRY_AFTER_MS : Math.max(0, at - Date.now());
  }
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

function kindScope(kind: EmsiPathKind): EdrErrorScope {
  return kind === 'account' || kind === 'workspaces' ? 'connection' : kind === 'workspace' ? 'tenant' : 'operation';
}

/**
 * Emsisoft public API (cloud EMC) read client. One host, `Api-Key` header auth, `Skip`/`Take`
 * paging over `{ data, totalCount }`. READ-ONLY in PR-A: writes (scan, verdict) arrive with the
 * actions PR and follow the W03 no-retry write contract.
 *
 * The key is held in a private field and only ever placed in the `Api-Key` header. Error
 * messages carry the method, the HTTP status and the path TEMPLATE
 * (`/v1/workspaces/{ws}/devices`): never the query, a guid, a name, or a response body.
 */
export class EmsisoftClient {
  private readonly apiKey: string;
  private readonly fetchImpl: GuardedFetch;
  private readonly limiter: EdrRateLimiter;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly onRateHeaders?: (headers: Record<string, string>) => void;
  private accountOk = false;
  private lastRateHeadersKey: string | null = null;

  constructor(o: EmsisoftClientOptions) {
    this.apiKey = o.creds.apiKey;
    this.fetchImpl = o.fetch;
    this.limiter = o.limiter;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onRateHeaders = o.onRateHeaders;
  }

  private fail(
    message: string,
    o: { code: string; reauth?: boolean; scope: EdrErrorScope; retryAfterMs?: number },
  ): EdrProviderRequestError {
    const safe = this.apiKey ? message.split(this.apiKey).join('[redacted]') : message;
    return new EdrProviderRequestError(safe, {
      code: o.code, reauth: o.reauth ?? false, scope: o.scope, retryAfterMs: o.retryAfterMs,
    });
  }

  private observeRateHeaders(headers: Headers): void {
    if (!this.onRateHeaders) return;
    const seen: Record<string, string> = {};
    headers.forEach((value, name) => {
      if (RATE_HEADER_NAME.test(name) && RATE_HEADER_VALUE.test(value)) seen[name.toLowerCase()] = value;
    });
    const key = JSON.stringify(Object.entries(seen).sort(([a], [b]) => (a < b ? -1 : 1)));
    if (key === this.lastRateHeadersKey) return;
    this.lastRateHeadersKey = key;
    this.onRateHeaders(seen);
  }

  /**
   * One GET with the retry/classification rules. `template` is the path with placeholders
   * (used in messages); `path` is the real path. Returns the parsed JSON, or MISSING when
   * `missingAsNull` is set and the vendor says the object does not exist.
   */
  private async get(
    kind: EmsiPathKind,
    template: string,
    path: string,
    query?: URLSearchParams,
    o: { missingAsNull?: boolean } = {},
  ): Promise<unknown> {
    const label = `Emsisoft GET ${template}`;
    const url = `${BASE_URL}${path}${query ? `?${query.toString()}` : ''}`;
    const scope = kindScope(kind);
    let attempt = 0;

    for (;;) {
      attempt += 1;
      await this.limiter.acquire();
      let status = 0;
      let headers = new Headers();
      let text = '';
      let networkError = false;
      try {
        const res = await this.fetchImpl(url, {
          method: 'GET',
          headers: { 'Api-Key': this.apiKey, Accept: 'application/json' },
          timeoutMs: this.timeoutMs,
        });
        status = res.status;
        headers = res.headers;
        text = await res.text();
      } catch (error) {
        // A guardedFetch refusal (host_not_allowed, ...) is a typed, non-retryable verdict.
        if (error instanceof EdrProviderRequestError) throw error;
        networkError = true; // the cause is dropped on purpose: socket errors can embed request details
      }
      if (!networkError) this.observeRateHeaders(headers);

      // Transient: retry with backoff, or give up as vendor_error.
      const transient = async (reason: string): Promise<void> => {
        if (attempt >= MAX_ATTEMPTS) throw this.fail(`${label}: ${reason}`, { code: 'vendor_error', scope });
        await this.sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
      };

      if (networkError) { await transient('request failed'); continue; }

      if (status === 401 || status === 403) {
        if (kind === 'account') {
          throw this.fail(`${label}: HTTP ${status}`, { code: 'auth', reauth: true, scope: 'connection' });
        }
        if (kind === 'workspaces' && !this.accountOk) {
          // Tell a dead key from a missing permission: only /account can.
          await this.getAccount();
        }
        throw this.fail(`${label}: HTTP ${status}`, { code: 'forbidden', scope });
      }
      if (status === 404) {
        if (o.missingAsNull) return MISSING;
        throw this.fail(`${label}: HTTP 404`, { code: 'not_found', scope });
      }
      if (status === 400) {
        if (o.missingAsNull && INCIDENT_MISSING_CODES.test(text)) return MISSING;
        throw this.fail(`${label}: HTTP 400`, { code: 'invalid_params', scope: 'operation' });
      }
      if (status === 429) {
        const retryAfterMs = parseRetryAfterMs(headers);
        if (attempt >= MAX_ATTEMPTS) {
          throw this.fail(`${label}: HTTP 429`, { code: 'rate_limited', scope: 'connection', retryAfterMs });
        }
        await this.sleep(retryAfterMs);
        continue;
      }
      if (status >= 500 || status === 408) { await transient(`HTTP ${status}`); continue; }
      if (status < 200 || status >= 300) {
        throw this.fail(`${label}: HTTP ${status}`, { code: 'http_error', scope });
      }

      try {
        return JSON.parse(text) as unknown;
      } catch {
        await transient(`HTTP ${status} (not JSON)`);
      }
    }
  }

  private checkGuid(value: string, what: string): void {
    if (!UUID.test(value)) {
      throw this.fail(`Emsisoft: invalid ${what}`, { code: 'invalid_vendor_id', scope: 'operation' });
    }
  }

  private parseItem<T>(schema: z.ZodType<T>, value: unknown, template: string, kind: EmsiPathKind): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw this.fail(`Emsisoft GET ${template}: malformed response`, {
        code: 'malformed_response', scope: kind === 'account' || kind === 'workspaces' ? 'connection' : 'tenant',
      });
    }
    return parsed.data;
  }

  /** Skip/Take paging over `{ data, totalCount }`; all-or-nothing, deduped by guid, `too_many_*` past the cap. */
  private async listAll<T extends { guid: string }>(
    kind: EmsiPathKind,
    template: string,
    path: string,
    extra: Record<string, string>,
    schema: z.ZodType<T>,
    cap: { name: 'workspaces' | 'devices' | 'incidents' },
  ): Promise<T[]> {
    const byGuid = new Map<string, T>();
    const maxPages = EMSI_MAX_PAGES[cap.name];
    let skip = 0;
    for (let pageNo = 1; ; pageNo += 1) {
      const query = new URLSearchParams({ ...extra, Skip: String(skip), Take: String(EMSI_PAGE_SIZE) });
      const body = await this.get(kind, template, path, query);
      const shape = z.object({ data: z.array(z.unknown()), totalCount: z.number() }).safeParse(body);
      if (!shape.success) {
        throw this.fail(`Emsisoft GET ${template}: malformed response`, {
          code: 'malformed_response', scope: kind === 'workspaces' ? 'connection' : 'tenant',
        });
      }
      for (const raw of shape.data.data) {
        const item = this.parseItem(schema, raw, template, kind);
        if (!byGuid.has(item.guid)) byGuid.set(item.guid, item);
      }
      skip += shape.data.data.length;
      if (shape.data.data.length === 0 || skip >= shape.data.totalCount) break;
      if (pageNo >= maxPages) {
        throw this.fail(`Emsisoft GET ${template}: more than ${maxPages * EMSI_PAGE_SIZE} items`, {
          code: `too_many_${cap.name}`, scope: kind === 'workspaces' ? 'connection' : 'tenant',
        });
      }
    }
    return [...byGuid.values()];
  }

  async getAccount(): Promise<EmsiAccount> {
    const body = await this.get('account', '/v1/account', '/v1/account');
    const account = this.parseItem(accountSchema, body, '/v1/account', 'account');
    this.accountOk = true;
    return account;
  }

  listWorkspacesAll(): Promise<EmsiWorkspace[]> {
    return this.listAll('workspaces', '/v1/workspaces', '/v1/workspaces', {}, workspaceSchema, { name: 'workspaces' });
  }

  async listDevicesAll(wsGuid: string): Promise<EmsiDevice[]> {
    this.checkGuid(wsGuid, 'workspace id');
    return this.listAll('workspace', '/v1/workspaces/{ws}/devices', `/v1/workspaces/${wsGuid}/devices`, {}, deviceSchema, { name: 'devices' });
  }

  /** Connection-test probe: can this key read a workspace's devices at all? One tiny page, never the whole fleet. */
  async probeWorkspaceDevices(wsGuid: string): Promise<void> {
    this.checkGuid(wsGuid, 'workspace id');
    const body = await this.get(
      'workspace', '/v1/workspaces/{ws}/devices', `/v1/workspaces/${wsGuid}/devices`,
      new URLSearchParams({ Skip: '0', Take: '1' }),
    );
    if (!z.object({ data: z.array(z.unknown()), totalCount: z.number() }).safeParse(body).success) {
      throw this.fail('Emsisoft GET /v1/workspaces/{ws}/devices: malformed response', { code: 'malformed_response', scope: 'tenant' });
    }
  }

  async getDeviceDetails(dvGuid: string): Promise<EmsiDeviceDetails> {
    this.checkGuid(dvGuid, 'device id');
    const template = '/v1/devices/{dv}/details';
    const body = await this.get('device', template, `/v1/devices/${dvGuid}/details`);
    return this.parseItem(deviceDetailsSchema, body, template, 'device');
  }

  async listIncidentsAll(wsGuid: string, from: Date, to: Date): Promise<EmsiIncident[]> {
    this.checkGuid(wsGuid, 'workspace id');
    return this.listAll(
      'workspace', '/v1/workspaces/{ws}/incidents', `/v1/workspaces/${wsGuid}/incidents`,
      { DateFrom: from.toISOString(), DateTo: to.toISOString() }, incidentSchema, { name: 'incidents' },
    );
  }

  /**
   * Not found -> null: a 404, OR a 400 whose body names `IncidentNotFound` /
   * `WorkspaceThreatIncorrectTarget` (the OpenAPI documents no 404 for incidents, only these
   * 400 LogicError codes). Any other 400 is `invalid_params`.
   */
  async getIncident(wsGuid: string, incidentRef: string): Promise<EmsiIncidentDetail | null> {
    this.checkGuid(wsGuid, 'workspace id');
    if (!INCIDENT_REF.test(incidentRef)) {
      throw this.fail('Emsisoft: invalid incident reference', { code: 'invalid_vendor_id', scope: 'operation' });
    }
    const template = '/v1/workspaces/{ws}/incidents/{incident}';
    const body = await this.get(
      'workspace', template, `/v1/workspaces/${wsGuid}/incidents/${encodeURIComponent(incidentRef)}`, undefined,
      { missingAsNull: true },
    );
    if (body === MISSING) return null;
    return this.parseItem(incidentDetailSchema, body, template, 'workspace');
  }
}
