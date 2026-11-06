import { ResponseTooLargeError, safeFetch } from '../../urlSafety';
import { ProviderRequestError } from '../types';

export const AXCIENT_PAGE_SIZE = 100;
export const AXCIENT_MAX_PAGES = 200;
/**
 * Body ceiling per request. A 100-device page with jobs, vaults and volumes is
 * well under 1 MiB; this only stops a misbehaving or hostile endpoint from
 * buffering without bound in the API process.
 */
export const AXCIENT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_RETRIES = 3;

export const AXCIENT_UNAUTHORIZED_MESSAGE = 'Axcient rejected the API key.';
export const AXCIENT_SCOPE_MESSAGE =
  'This key is missing a product scope. Edit it in x360Portal → Settings → API Keys and enable x360Recover and Billing.';

/**
 * Admin calls (`/organization`, `/client`) fail the whole run. Device calls are
 * per customer: only this error may put one customer into `failedCustomerIds`.
 */
type RequestScope = 'admin' | 'customer';

/** The one failure that may omit a single customer's devices from a snapshot. */
export class AxcientCustomerRequestError extends ProviderRequestError {
  constructor(message: string, code: string) {
    super(message, { code, reauth: false });
    this.name = 'AxcientCustomerRequestError';
  }
}

export interface AxcientFetchResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}
export type AxcientFetchImpl = (url: string, init: {
  method: 'GET';
  headers: Record<string, string>;
  signal: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
}) => Promise<AxcientFetchResponse>;

export interface AxcientClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: AxcientFetchImpl;
  sleepImpl?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export interface AxcientOrganization { id: number; name: string; active: boolean }
export type AxcientRecord = Record<string, unknown>;

function failure(code: string, message: string): ProviderRequestError {
  return new ProviderRequestError(message, { code, reauth: false });
}

function isRecord(value: unknown): value is AxcientRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Static copy only: a vendor body is never echoed, so nothing it carries can leak. */
function describeFailure(status: number): string {
  if (status === 404) return `Axcient API URL not found (HTTP ${status})`;
  if (status === 429) return `Axcient is rate limiting requests; try again later (HTTP ${status})`;
  if (status >= 500) return `Axcient is unavailable; try again later (HTTP ${status})`;
  return `Axcient returned HTTP ${status}`;
}

/** A 403 is a credential problem only when Axcient says the key lacks a product scope. */
function isScopeRejection(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as unknown;
    return isRecord(parsed) && parsed.type === 'ForbiddenException';
  } catch {
    return false;
  }
}

function retryDelay(header: string | null | undefined, attempt: number): number {
  const seconds = header?.trim() ? Number(header) : Number.NaN;
  const millis = Number.isFinite(seconds) ? seconds * 1000 : header ? Date.parse(header) - Date.now() : Number.NaN;
  return Math.min(60_000, Math.max(0, Number.isFinite(millis) ? millis : 1000 * 2 ** attempt));
}

/**
 * Read-only x360Recover client. It issues GET only, never sends a body, and
 * goes through safeFetch, which pins public DNS and refuses redirects that
 * would carry the `X-Api-Key` header to another host.
 */
export class AxcientClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: AxcientFetchImpl;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private aborted = false;

  constructor(options: AxcientClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '') + '/';
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => safeFetch(url, init));
    this.sleepImpl = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Shared by both workers; in-flight calls may finish but no new request starts. */
  abort(): void { this.aborted = true; }

  async getOrganization(): Promise<AxcientOrganization> {
    const payload = await this.get('organization', 'admin');
    if (!isRecord(payload) || typeof payload.id !== 'number' || !Number.isFinite(payload.id)
        || typeof payload.name !== 'string') {
      throw failure('malformed_response', 'Axcient returned an unexpected organization');
    }
    return { id: payload.id, name: payload.name, active: payload.active === true };
  }

  listClients(): Promise<AxcientRecord[]> {
    return this.list('client', 'admin');
  }

  /**
   * Axcient answers a non-numeric path id with 401, which would read as a dead
   * key, so the id is checked before any request is built.
   */
  async listClientDevices(clientId: number): Promise<AxcientRecord[]> {
    if (!Number.isSafeInteger(clientId) || clientId <= 0) {
      throw failure('malformed_response', 'Axcient client id is not a positive integer');
    }
    return this.list(`client/${clientId}/device`, 'customer');
  }

  private async get(path: string, scope: RequestScope): Promise<unknown> {
    const url = new URL(path, this.baseUrl).toString();
    const headers = { 'X-Api-Key': this.apiKey, Accept: 'application/json' };
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (this.aborted) throw failure('aborted', 'Axcient enumeration aborted');
      let response: AxcientFetchResponse;
      let body: string;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET', headers, signal: AbortSignal.timeout(this.timeoutMs), timeoutMs: this.timeoutMs,
          maxBytes: AXCIENT_MAX_RESPONSE_BYTES,
        });
        body = await response.text();
      } catch (error) {
        // Deterministic, so never retried. One oversized customer is isolated
        // like any other per-customer failure.
        if (error instanceof ResponseTooLargeError) {
          const message = 'Axcient returned a response that is too large';
          if (scope === 'customer') throw new AxcientCustomerRequestError(message, 'response_too_large');
          throw failure('response_too_large', message);
        }
        // Network exceptions can echo URLs or headers. Never keep their message
        // or cause in an error that may be logged or persisted.
        // A device call that keeps failing isolates that customer, so one slow
        // customer cannot abort every other customer's sync on each poll.
        if (attempt === MAX_RETRIES) {
          if (scope === 'customer') throw new AxcientCustomerRequestError('Axcient request failed', 'network');
          throw failure('network', 'Axcient request failed');
        }
        await this.sleepImpl(retryDelay(null, attempt));
        continue;
      }
      if (!response.ok) {
        const status = response.status;
        const code = `http_${status}`;
        // 401 is always the key, whatever the scope: a dead key must stop the run.
        if (status === 401) throw new ProviderRequestError(AXCIENT_UNAUTHORIZED_MESSAGE, { code, reauth: true });
        if (status === 403) {
          if (isScopeRejection(body)) throw new ProviderRequestError(AXCIENT_SCOPE_MESSAGE, { code, reauth: true });
          throw failure(code, describeFailure(status));
        }
        if (status === 404 && scope === 'customer') throw new AxcientCustomerRequestError(describeFailure(status), code);
        if (status === 429 || status >= 500) {
          if (attempt < MAX_RETRIES) {
            await this.sleepImpl(retryDelay(status === 429 ? response.headers?.get('Retry-After') : null, attempt));
            continue;
          }
          if (scope === 'customer') throw new AxcientCustomerRequestError(describeFailure(status), code);
        }
        throw failure(code, describeFailure(status));
      }
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw failure('malformed_response', 'Axcient returned a non-JSON response');
      }
    }
    throw failure('network', 'Axcient request failed');
  }

  /**
   * Offset pagination over bare arrays with no total. Stops on a short or empty
   * page, and on a page that adds no new row: a server that ignores
   * `limit`/`offset` returns the same full array every time, and must not spin
   * to the page cap or duplicate rows.
   */
  private async list(path: string, scope: RequestScope): Promise<AxcientRecord[]> {
    const result: AxcientRecord[] = [];
    const seen = new Set<string>();
    for (let page = 0; page < AXCIENT_MAX_PAGES; page++) {
      const payload = await this.get(`${path}?limit=${AXCIENT_PAGE_SIZE}&offset=${page * AXCIENT_PAGE_SIZE}`, scope);
      if (!Array.isArray(payload) || payload.some((row) => !isRecord(row))) {
        throw failure('malformed_response', 'Axcient did not return a list');
      }
      let added = 0;
      for (const row of payload as AxcientRecord[]) {
        // Key on the whole row when there is no id, so id-less rows survive to
        // the adapter (which rejects them) instead of collapsing into one.
        const identity = JSON.stringify(row.id ?? row);
        if (seen.has(identity)) continue;
        seen.add(identity);
        result.push(row);
        added += 1;
      }
      if (payload.length < AXCIENT_PAGE_SIZE || added === 0) return result;
    }
    throw failure('too_many_pages', `Axcient exceeded ${AXCIENT_MAX_PAGES} pages`);
  }
}
