import { selfHostAllowsPrivateNetwork } from '../../config/env';
import { Semaphore } from '../../utils/semaphore';
import { checkSsrfSafe, type SsrfMode } from '../ssrfGuard';
import { ResponseTooLargeError, safeFetch, SsrfBlockedError } from '../urlSafety';

/**
 * The import's outbound HTTP client (#8313 W4; spec
 * docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md
 * §5.6), modeled on `psaFetch`:
 *
 * - the base URL passes `checkSsrfSafe` in `strict-https`, or `on-prem-http`
 *   only when the deployment affirmatively declares self-host
 *   (`selfHostAllowsPrivateNetwork()`); loopback, link-local, metadata and
 *   CGNAT stay blocked in both modes, and a cleartext target must resolve to
 *   a private address (`requirePrivateForCleartext`);
 * - `safeFetch` pins DNS, follows no redirect, refuses to run inside a held
 *   DB context, and bounds each call by a timeout and `maxBytes`;
 * - **no URL is ever taken from a response.** A request names path segments,
 *   each encoded, under the stored base URL; the built URL must keep the
 *   base's origin and path prefix. That is stronger than `pinCursorToBase`,
 *   which exists to follow body-supplied cursors.
 *
 * Idempotent GETs are retried here on a timeout, a network failure, a 5xx or
 * a 429, with backoff, honouring a short `Retry-After`. A longer one surfaces
 * as `SourceUnavailableError.retryAfterMs`, which the worker turns into a
 * deferral that spends no attempt (§5.8).
 */

/** A source answered with a status the client does not retry (4xx other than 429). */
export class SourceHttpError extends Error {
  constructor(public readonly status: number, message = `The source answered ${status}`) {
    super(message);
    this.name = 'SourceHttpError';
  }
}

/** The credential was refused (401): every later call would be refused too. */
export class SourceAuthError extends SourceHttpError {
  constructor(status = 401) {
    super(status, 'The source refused the credential');
    this.name = 'SourceAuthError';
  }
}

/** A JSON answer over the call's `maxBytes`: permanent for that request. */
export class SourceResponseTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`The source answer is larger than ${maxBytes} bytes`);
    this.name = 'SourceResponseTooLargeError';
  }
}

/**
 * The source answered, but not in the shape the module knows (a release the
 * module does not know, a malformed record). Not an outage, so it never
 * counts toward the run's consecutive source failures: confined to one
 * ticket (its row or its load) it fails that ticket permanently
 * (`source_shape_invalid`); on a list page or a connect it stops the run.
 */
export class SourceShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceShapeError';
  }
}

/**
 * The source could not be reached now: a timeout, a network failure, a 5xx or
 * a 429 after the retries, or an answer that is not the JSON it should be.
 * Transient. `retryAfterMs` is the source's own `Retry-After` when it asked
 * for one.
 */
export class SourceUnavailableError extends Error {
  constructor(message: string, public readonly retryAfterMs: number | null = null, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SourceUnavailableError';
  }
}

/** One request: path segments under the base URL, a query and headers. */
export type SourceRequest = {
  /** Each segment is URI-encoded; '.', '..' and empty segments are refused. */
  path: ReadonlyArray<string | number>;
  query?: Readonly<Record<string, string | number | boolean | undefined>>;
  headers?: Readonly<Record<string, string>>;
  /** Defaults: 16 MiB for JSON, 10 MiB for bytes. */
  maxBytes?: number;
};

export type SourceJsonResponse<T> = { status: number; headers: Headers; body: T };

export interface SourceClient {
  readonly baseUrl: string;
  json<T = unknown>(request: SourceRequest): Promise<SourceJsonResponse<T>>;
  bytes(request: SourceRequest): Promise<Uint8Array>;
}

export const SOURCE_JSON_MAX_BYTES = 16 * 1024 * 1024;
export const SOURCE_FILE_MAX_BYTES = 10 * 1024 * 1024;
const SOURCE_URL_MAX = 2048;

const RETRIABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

export type SourceClientOptions = {
  timeoutMs: number;
  /** Requests in flight at once. */
  concurrency: number;
  /** Retries of one request after the first try. Default 2. */
  retries?: number;
  /** Backoff before retry n (1-based). Default 1 s, 3 s, 9 s. */
  backoffMs?: (attempt: number) => number;
  /** The longest `Retry-After` waited inline; a longer one is handed to the worker. Default 10 s. */
  maxInlineRetryAfterMs?: number;
  /** Tests inject these. */
  fetchImpl?: typeof safeFetch;
  sleep?: (ms: number) => Promise<void>;
};

function sourceSsrfMode(): SsrfMode {
  return selfHostAllowsPrivateNetwork() ? 'on-prem-http' : 'strict-https';
}

/**
 * The stored form of a source's base URL, or the reason it is refused: SSRF
 * rules, no credentials, query or fragment in it, and no trailing slash.
 */
export function normalizeSourceBaseUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > SOURCE_URL_MAX) return { ok: false, reason: 'URL is empty or too long' };
  const ssrf = checkSsrfSafe(trimmed, { mode: sourceSsrfMode() });
  if (!ssrf.ok) return { ok: false, reason: ssrf.reason ?? 'URL is not safe' };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'URL is malformed' };
  }
  if (url.username || url.password) return { ok: false, reason: 'URL must not carry credentials' };
  if (url.search || url.hash) return { ok: false, reason: 'URL must not carry a query or a fragment' };
  const path = url.pathname.replace(/\/+$/, '');
  return { ok: true, url: `${url.origin}${path}` };
}

function encodeSegment(segment: string | number): string {
  const text = String(segment);
  if (text === '' || text === '.' || text === '..') throw new Error(`Invalid source path segment: ${JSON.stringify(text)}`);
  return encodeURIComponent(text);
}

/** The request URL: the base plus encoded segments and a query, checked to stay under the base. */
export function buildSourceUrl(baseUrl: string, request: Pick<SourceRequest, 'path' | 'query'>): string {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const url = new URL(`${base.origin}${basePath}/${request.path.map(encodeSegment).join('/')}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  if (url.origin !== base.origin || !url.pathname.startsWith(`${basePath}/`)) {
    throw new SsrfBlockedError('A source request left its base URL');
  }
  return url.toString();
}

/** `Retry-After` in ms: delta-seconds or an HTTP date; null when absent or unreadable. */
export function retryAfterMs(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** The source clock minus Breeze's, from a response `Date` header. */
export function clockSkewFromDateHeader(headers: Headers, now: number = Date.now()): number | null {
  const date = headers.get('date');
  if (!date) return null;
  const at = Date.parse(date);
  return Number.isFinite(at) ? at - now : null;
}

const defaultBackoff = (attempt: number) => 1000 * 3 ** (attempt - 1);
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createSourceClient(baseUrl: string, options: SourceClientOptions): SourceClient {
  const normalized = normalizeSourceBaseUrl(baseUrl);
  if (!normalized.ok) throw new SsrfBlockedError(`Source URL rejected: ${normalized.reason}`);
  const base = normalized.url;
  const fetchImpl = options.fetchImpl ?? safeFetch;
  const sleep = options.sleep ?? defaultSleep;
  const backoff = options.backoffMs ?? defaultBackoff;
  const retries = Math.max(0, options.retries ?? 2);
  const maxInlineRetryAfter = options.maxInlineRetryAfterMs ?? 10_000;
  const gate = new Semaphore(Math.max(1, options.concurrency));

  async function send(request: SourceRequest, defaultMaxBytes: number): Promise<Response> {
    const url = buildSourceUrl(base, request);
    const maxBytes = request.maxBytes ?? defaultMaxBytes;
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) {
        const hinted = lastError instanceof SourceUnavailableError ? lastError.retryAfterMs : null;
        await sleep(hinted ?? backoff(attempt));
      }
      let response: Response;
      try {
        response = await gate.run(() => fetchImpl(url, {
          method: 'GET',
          headers: { accept: 'application/json', ...(request.headers ?? {}) },
          timeoutMs: options.timeoutMs,
          maxBytes,
          allowPrivateNetwork: selfHostAllowsPrivateNetwork(),
          requirePrivateForCleartext: true,
        }));
      } catch (error) {
        if (error instanceof SsrfBlockedError) throw error;
        if (error instanceof ResponseTooLargeError) throw new SourceResponseTooLargeError(maxBytes);
        lastError = new SourceUnavailableError('The source could not be reached', null, { cause: error });
        continue;
      }
      if (response.ok) return response;
      if (response.status === 401) throw new SourceAuthError(401);
      if (!RETRIABLE_STATUSES.has(response.status)) throw new SourceHttpError(response.status);
      const hinted = retryAfterMs(response.headers.get('retry-after'));
      lastError = new SourceUnavailableError(`The source answered ${response.status}`, hinted);
      // A long Retry-After is the worker's to honour (a deferral), not ours.
      if (hinted !== null && hinted > maxInlineRetryAfter) throw lastError;
    }
    throw lastError ?? new SourceUnavailableError('The source could not be reached');
  }

  return {
    baseUrl: base,
    async json<T>(request: SourceRequest): Promise<SourceJsonResponse<T>> {
      const response = await send(request, SOURCE_JSON_MAX_BYTES);
      const text = await response.text();
      try {
        return { status: response.status, headers: response.headers, body: JSON.parse(text) as T };
      } catch (error) {
        // A proxy's error page in place of the API's JSON: transient.
        throw new SourceUnavailableError('The source answer is not JSON', null, { cause: error });
      }
    },
    async bytes(request: SourceRequest): Promise<Uint8Array> {
      const response = await send(request, SOURCE_FILE_MAX_BYTES);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
