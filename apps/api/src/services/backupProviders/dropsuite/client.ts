import { safeFetch } from '../../urlSafety';
import { ProviderRequestError } from '../types';

export const DROPSUITE_PAGE_SIZE = 100;
export const DROPSUITE_MAX_PAGES = 200;
const MAX_RETRIES = 3;
const MAX_CUSTOMER_REQUESTS = 500;
const MAX_ADMIN_REQUESTS = 1000;
type CredentialScope = 'admin' | 'customer';

/** Only these failures may omit one customer's inventory from a snapshot. */
export class CustomerRequestError extends ProviderRequestError {
  constructor(message: string, code: string) {
    super(message, { code, reauth: false });
    this.name = 'CustomerRequestError';
  }
}

export interface DropsuiteFetchResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}
export type DropsuiteFetchImpl = (url: string, init: {
  method: 'GET';
  headers: Record<string, string>;
  signal: AbortSignal;
  timeoutMs: number;
}) => Promise<DropsuiteFetchResponse>;

export interface DropsuiteClientOptions {
  baseUrl: string;
  resellerToken: string;
  fetchImpl?: DropsuiteFetchImpl;
  sleepImpl?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

/**
 * Collect secrets before copying so a token echoed in an earlier sibling field
 * is also removed. The source object is never changed: customer tokens must
 * remain available in memory until that customer's requests finish.
 */
export function scrubTokens<T>(value: T, knownTokens: readonly string[] = []): T {
  const tokens = new Set(knownTokens.filter(Boolean));
  const collect = (entry: unknown, sensitive = false): void => {
    if (typeof entry === 'string') {
      if (sensitive && entry) tokens.add(entry);
    } else if (Array.isArray(entry)) {
      entry.forEach((item) => collect(item, sensitive));
    } else if (entry && typeof entry === 'object') {
      for (const [key, item] of Object.entries(entry)) collect(item, sensitive || /token|secret/i.test(key));
    }
  };
  collect(value);
  const orderedTokens = [...tokens].sort((a, b) => b.length - a.length);
  const replace = (text: string): string => {
    for (const token of orderedTokens) text = text.split(token).join('[redacted]');
    return text;
  };
  const copy = (entry: unknown): unknown => {
    if (typeof entry === 'string') return replace(entry);
    if (Array.isArray(entry)) return entry.map(copy);
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(Object.entries(entry).map(([key, item]) => [
        replace(key), /token|secret/i.test(key) ? '[redacted]' : copy(item),
      ]));
    }
    return entry;
  };
  return copy(value) as T;
}

function failure(code: string, message: string): ProviderRequestError {
  return new ProviderRequestError(message, { code, reauth: false });
}

/** `/status` carries only the reseller token; every other admin call adds the authentication token. */
function describeAdminFailure(status: number, statusProbe: boolean): string {
  if (status === 401 || status === 403) {
    return `Dropsuite rejected the ${statusProbe ? 'reseller' : 'authentication'} token (HTTP ${status})`;
  }
  if (status === 404) return `Dropsuite API URL not found; check the API URL from API Settings (HTTP ${status})`;
  if (status === 429) return `Dropsuite is rate limiting requests; try again later (HTTP ${status})`;
  if (status >= 500) return `Dropsuite is unavailable; try again later (HTTP ${status})`;
  return `Dropsuite returned HTTP ${status}`;
}

function retryDelay(header: string | null | undefined, attempt: number): number {
  const seconds = header?.trim() ? Number(header) : Number.NaN;
  const millis = Number.isFinite(seconds) ? seconds * 1000 : header ? Date.parse(header) - Date.now() : Number.NaN;
  return Math.min(60_000, Math.max(0, Number.isFinite(millis) ? millis : 1000 * 2 ** attempt));
}

/** GET only; safeFetch pins public DNS and forbids redirect credential leaks. */
export class DropsuiteClient {
  private readonly baseUrl: string;
  private readonly resellerToken: string;
  private readonly fetchImpl: DropsuiteFetchImpl;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private adminRequests = 0;
  private readonly customerRequests = new Map<string, number>();
  private aborted = false;

  constructor(options: DropsuiteClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '') + '/';
    this.resellerToken = options.resellerToken;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => safeFetch(url, init));
    this.sleepImpl = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Shared by both workers; in-flight calls may finish but no new request starts. */
  abort(): void { this.aborted = true; }

  async get(path: string, accessToken?: string, scope: CredentialScope = 'admin'): Promise<unknown> {
    const relativePath = path.replace(/^\/+/, '');
    const url = new URL(relativePath, this.baseUrl).toString();
    const headers: Record<string, string> = { 'X-Reseller-Token': this.resellerToken, Accept: 'application/json' };
    if (accessToken) headers['X-Access-Token'] = accessToken;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (this.aborted) throw failure('aborted', 'Dropsuite enumeration aborted');
      if (scope === 'customer') {
        const key = accessToken ?? '';
        const requests = (this.customerRequests.get(key) ?? 0) + 1;
        this.customerRequests.set(key, requests);
        if (requests > MAX_CUSTOMER_REQUESTS) throw new CustomerRequestError('Dropsuite customer request budget exceeded', 'request_budget');
      } else if (++this.adminRequests > MAX_ADMIN_REQUESTS) {
        throw failure('request_budget', 'Dropsuite admin request budget exceeded');
      }
      let response: DropsuiteFetchResponse;
      let body: string;
      try {
        response = await this.fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(this.timeoutMs), timeoutMs: this.timeoutMs });
        body = await response.text();
      } catch {
        // Network exceptions can echo URLs, headers or credentials. Never keep
        // their message or cause in an error that may be logged/persisted.
        if (attempt === MAX_RETRIES) throw failure('network', 'Dropsuite request failed');
        await this.sleepImpl(retryDelay(null, attempt));
        continue;
      }
      if (!response.ok) {
        const status = response.status;
        const code = `http_${status}`;
        const unauthorized = status === 401 || status === 403;
        // Admin-scope failures surface verbatim in the connection form and on
        // the connection card, so say which credential or setting to fix.
        const message = scope === 'customer'
          ? `Dropsuite returned HTTP ${status}`
          : describeAdminFailure(status, relativePath === 'status');
        if (scope === 'customer' && (unauthorized || status === 400 || status === 404)) {
          throw new CustomerRequestError(message, code);
        }
        if (unauthorized) throw new ProviderRequestError(message, { code, reauth: scope === 'admin' });
        if (status === 429 || status >= 500) {
          if (attempt < MAX_RETRIES) {
            await this.sleepImpl(retryDelay(status === 429 ? response.headers?.get('Retry-After') : null, attempt));
            continue;
          }
          if (status >= 500 && scope === 'customer') throw new CustomerRequestError(message, code);
        }
        throw failure(code, message);
      }
      if (relativePath === 'status' && response.status !== 200) {
        throw failure(`http_${response.status}`, `Dropsuite returned HTTP ${response.status}`);
      }
      // /status alone is documented as plain text. All inventory endpoints
      // must parse JSON, never turn an HTML proxy response into empty inventory.
      if (relativePath === 'status' && response.status === 200 && body.trim() === 'OK') return 'OK';
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw failure('malformed_response', 'Dropsuite returned a non-JSON response');
      }
    }
    throw failure('network', 'Dropsuite request failed');
  }

  async list(path: string, accessToken?: string, scope: CredentialScope = 'admin'): Promise<Record<string, unknown>[]> {
    const result: Record<string, unknown>[] = [];
    const firstItems = new Set<string>();
    const seen = new Set<string>();
    const identityKey = path.replace(/^\/+/, '').split('?')[0] === 'googledrives' ? 'drive_account_id' : 'id';
    const identity = (row: Record<string, unknown>): string => JSON.stringify(row[identityKey] ?? row);
    const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
    const isEnvelope = (value: unknown): value is Record<string, unknown> => isRecord(value) && (Array.isArray(value.result_set) || Array.isArray(value.data));
    const positive = (value: unknown): number | null => {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    for (let page = 1; page <= DROPSUITE_MAX_PAGES; page++) {
      const separator = path.includes('?') ? '&' : '?';
      const payload = await this.get(`${path}${separator}page=${page}&per_page=${DROPSUITE_PAGE_SIZE}`, accessToken, scope);
      const envelopes = Array.isArray(payload)
        ? payload.length && payload.every(isEnvelope) ? payload : null
        : isEnvelope(payload) ? [payload] : null;
      const groups = envelopes ? envelopes.map(envelope => envelope.result_set ?? envelope.data) : [payload];
      if (groups.some(rows => !Array.isArray(rows) || rows.some(row => !isRecord(row)))) {
        throw failure('malformed_response', 'Dropsuite did not return a list');
      }
      const pages = groups as Record<string, unknown>[][];
      const rows = pages.flat();
      // Each envelope can advance independently; an unchanged first envelope
      // must not hide new rows in the remaining envelopes.
      if (rows.length) {
        const first = JSON.stringify(pages.map(items => items[0] ? identity(items[0]) : null));
        if (firstItems.has(first)) return result;
        firstItems.add(first);
        for (const row of rows) {
          const id = identity(row);
          if (!seen.has(id)) { seen.add(id); result.push(row); }
        }
      }
      if (!envelopes) {
        // Bare arrays do not report the server's page size.
        if (!rows.length) return result;
        continue;
      }
      const more = envelopes.some((envelope, index) => {
        const pagination = isRecord(envelope.pagination) ? envelope.pagination : {};
        const totalPages = positive(pagination.total_pages);
        const currentPage = positive(pagination.current_page) ?? page;
        if (pagination.next_link != null || (totalPages !== null && currentPage < totalPages)) return true;
        if (totalPages !== null || 'next_link' in pagination) return false;
        const size = positive(pagination.per_page);
        return size !== null ? pages[index]!.length >= size : pages[index]!.length > 0;
      });
      if (!more) return result;
    }
    throw failure('too_many_pages', 'Dropsuite exceeded 200 pages');
  }
}
