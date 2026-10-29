import { safeFetch } from '../../urlSafety';
import { ProviderRequestError } from '../types';

export const DROPSUITE_PAGE_SIZE = 100;
export const DROPSUITE_MAX_PAGES = 200;
const MAX_RETRIES = 3;
const MAX_REQUESTS = 10_000;
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
  private requests = 0;

  constructor(options: DropsuiteClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '') + '/';
    this.resellerToken = options.resellerToken;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => safeFetch(url, init));
    this.sleepImpl = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async get(path: string, accessToken?: string, scope: CredentialScope = 'admin'): Promise<unknown> {
    const relativePath = path.replace(/^\/+/, '');
    const url = new URL(relativePath, this.baseUrl).toString();
    const headers: Record<string, string> = { 'X-Reseller-Token': this.resellerToken, Accept: 'application/json' };
    if (accessToken) headers['X-Access-Token'] = accessToken;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (++this.requests > MAX_REQUESTS) throw failure('request_budget', 'Dropsuite request budget exceeded');
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
        const message = `Dropsuite returned HTTP ${status}`;
        const unauthorized = status === 401 || status === 403;
        if (scope === 'customer' && (unauthorized || (status === 400 && /not authori[sz]ed/i.test(body)))) {
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
    for (let page = 1; page <= DROPSUITE_MAX_PAGES; page++) {
      const separator = path.includes('?') ? '&' : '?';
      const payload = await this.get(`${path}${separator}page=${page}&per_page=${DROPSUITE_PAGE_SIZE}`, accessToken, scope);
      const envelope = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown> : null;
      const rows = Array.isArray(payload) ? payload : envelope?.result_set ?? envelope?.data;
      if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
        throw failure('malformed_response', 'Dropsuite did not return a list');
      }
      if (!rows.length) return result;
      const first = rows[0] as Record<string, unknown>;
      const identity = JSON.stringify(first.id ?? first.drive_account_id ?? first);
      if (firstItems.has(identity)) return result;
      firstItems.add(identity);
      result.push(...rows as Record<string, unknown>[]);
      const pagination = envelope?.pagination as Record<string, unknown> | undefined;
      const reportedSize = Number(pagination?.per_page);
      const pageSize = Number.isFinite(reportedSize) && reportedSize > 0 ? reportedSize : DROPSUITE_PAGE_SIZE;
      const totalPages = Number(pagination?.total_pages);
      const currentPage = Number(pagination?.current_page ?? page);
      if (rows.length < pageSize || (Number.isFinite(totalPages) && currentPage >= totalPages)) return result;
    }
    throw failure('too_many_pages', 'Dropsuite exceeded 200 pages');
  }
}
