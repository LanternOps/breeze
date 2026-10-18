/**
 * OpenAPI operation HTTP client — Tool Catalog W2 (#5215 / #5217), plan
 * Task 7 (D4, D9, D15).
 *
 * Turns a validated tool input plus the stored `OperationBinding` into ONE
 * HTTP request against `tool_sources.endpoint_url` (never the document's
 * `servers[]`), through `safeFetch`: pinned DNS, private ranges refused unless
 * the self-hosted opt-in is on, no redirects (a 3xx is reported, never
 * followed — a redirect is exactly how a credential would leave its origin),
 * 1 MB response cap, 30 s wall-clock deadline.
 *
 * The credential comes from the shared builder in `'throw'` mode, so a base
 * URL that drifted off `credential_origin` refuses the call. A model-supplied
 * header can never shadow or duplicate the credential header, a path value of
 * `.`/`..` is refused (WHATWG URL would resolve it to a sibling endpoint),
 * and the final URL must still sit under the base path.
 *
 * Never rejects: every failure is `{ isError: true, text }` (D15), which is
 * the signal `executeTenantToolDetailed` and its audit row branch on. The
 * caller redacts the source's stored secrets and truncates; this module
 * additionally redacts the header values it actually sent (an OAuth2 access
 * token is derived, so the caller does not know it).
 */
import { safeFetch } from '../urlSafety';
import type { SafeFetchInit } from '../urlSafety';
import { buildToolSourceAuthHeaders, ToolSourceAuthError } from './authHeaders';
import { redactSecrets, type ToolSourceAuthConfig } from './secrets';
import type { OperationBinding } from './openapiProjection';

export const OPENAPI_TIMEOUT_MS = 30_000;
export const OPENAPI_MAX_RESPONSE_BYTES = 1_048_576;
export const OPENAPI_ERROR_BODY_CHARS = 2_048;

export interface OpenApiClientOptions {
  /** `tool_sources.endpoint_url` — the API base URL. Never `servers[]`. */
  baseUrl: string;
  credentialOrigin: string;
  auth: ToolSourceAuthConfig;
  /** default: `safeFetch` — tests inject a scripted fake. */
  fetchImpl?: (url: string, init: SafeFetchInit) => Promise<Response>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  allowPrivateNetwork?: boolean;
}

export interface OpenApiCallResult {
  isError: boolean;
  text: string;
}

/** A request that cannot be built from this input — reported to the model, never sent. */
export class OpenApiRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenApiRequestError';
  }
}

function ownValue(input: Record<string, unknown>, property: string): unknown {
  return Object.prototype.hasOwnProperty.call(input, property) ? input[property] : undefined;
}

function scalarText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return null;
}

function queryText(value: unknown): string {
  return scalarText(value) ?? JSON.stringify(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Builds the URL, body and parameter headers for one call. Pure; throws
 * `OpenApiRequestError` for input that cannot be sent safely.
 */
export function buildOperationRequest(
  baseUrl: string,
  binding: OperationBinding,
  input: Record<string, unknown>,
): { url: string; body: string | undefined; headers: Record<string, string> } {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');

  const path = binding.path.replace(/\{([^}]+)\}/g, (_whole, name: string) => {
    const param = binding.params.find((p) => p.in === 'path' && p.name === name);
    if (!param) throw new OpenApiRequestError(`the operation binding has no parameter for path variable ${name}`);
    const raw = ownValue(input, param.property);
    if (raw === undefined || raw === null) throw new OpenApiRequestError(`missing required path parameter: ${name}`);
    const text = scalarText(raw);
    if (text === null) throw new OpenApiRequestError(`path parameter ${name} must be a string, number or boolean`);
    if (text === '' || text === '.' || text === '..') {
      throw new OpenApiRequestError(`path parameter ${name} must not be empty, "." or ".."`);
    }
    return encodeURIComponent(text);
  });

  // origin + base path + operation path — userinfo on the base URL is dropped.
  const target = new URL(`${base.origin}${basePath}${path}`);
  if (target.origin !== base.origin || !(target.pathname === basePath || target.pathname.startsWith(`${basePath}/`))) {
    throw new OpenApiRequestError('the operation path resolves outside the API base URL');
  }
  for (const [key, value] of base.searchParams) target.searchParams.append(key, value);

  const headers: Record<string, string> = {};
  for (const param of binding.params) {
    const value = ownValue(input, param.property);
    if (param.in === 'path' || value === undefined || value === null) continue;
    if (param.in === 'query') {
      if (Array.isArray(value)) {
        for (const item of value) if (item !== undefined && item !== null) target.searchParams.append(param.name, queryText(item));
      } else if (isPlainObject(value)) {
        // style=form, explode=true object: each property is its own key.
        for (const key of Object.keys(value)) {
          const item = value[key];
          if (item !== undefined && item !== null) target.searchParams.append(key, queryText(item));
        }
      } else {
        target.searchParams.append(param.name, queryText(value));
      }
    } else {
      // style=simple header: arrays comma-joined, objects as k,v pairs.
      const text = Array.isArray(value)
        ? value.map(queryText).join(',')
        : isPlainObject(value)
          ? Object.keys(value).flatMap((k) => [k, queryText(value[k])]).join(',')
          : queryText(value);
      if (/[\r\n\0]/.test(text)) throw new OpenApiRequestError(`header parameter ${param.name} contains a line break or NUL`);
      headers[param.name] = text;
    }
  }

  let body: string | undefined;
  if (binding.body && binding.method !== 'get' && binding.method !== 'head') {
    const value = ownValue(input, binding.body.property);
    if (value === undefined) {
      if (binding.body.required) throw new OpenApiRequestError('missing required request body');
    } else {
      body = JSON.stringify(value);
    }
  }

  return { url: target.toString(), body, headers };
}

/** Values of the credential headers actually sent, for redaction (incl. a derived OAuth2 token). */
function sentSecretValues(authHeaders: Record<string, string>): string[] {
  const values: string[] = [];
  for (const value of Object.values(authHeaders)) {
    values.push(value);
    const scheme = /^(Bearer|Basic)\s+(.+)$/i.exec(value);
    if (scheme) values.push(scheme[2]!);
  }
  // Longest first so a token is not partially replaced by one of its substrings.
  return values.filter((v) => v.length >= 4).sort((a, b) => b.length - a.length);
}

export class OpenApiClient {
  private readonly opts: OpenApiClientOptions;
  private readonly fetchImpl: (url: string, init: SafeFetchInit) => Promise<Response>;

  constructor(opts: OpenApiClientOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? safeFetch;
  }

  async callOperation(binding: OperationBinding, input: Record<string, unknown>): Promise<OpenApiCallResult> {
    const timeoutMs = this.opts.timeoutMs ?? OPENAPI_TIMEOUT_MS;
    const maxBytes = this.opts.maxResponseBytes ?? OPENAPI_MAX_RESPONSE_BYTES;
    let secrets: string[] = [];
    try {
      const request = buildOperationRequest(this.opts.baseUrl, binding, input);
      const authHeaders = await buildToolSourceAuthHeaders(this.opts.auth, request.url, this.opts.credentialOrigin, {
        fetchImpl: this.fetchImpl,
      });
      secrets = sentSecretValues(authHeaders);

      // A parameter header may never shadow (or, by differing case, duplicate)
      // the credential header or the two headers this client owns.
      const reserved = new Set([...Object.keys(authHeaders), 'Accept', 'Content-Type', 'Authorization'].map((h) => h.toLowerCase()));
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (request.body !== undefined) headers['Content-Type'] = 'application/json';
      for (const [name, value] of Object.entries(request.headers)) {
        if (!reserved.has(name.toLowerCase())) headers[name] = value;
      }
      Object.assign(headers, authHeaders);

      const res = await this.fetchImpl(request.url, {
        method: binding.method.toUpperCase(),
        headers,
        ...(request.body !== undefined ? { body: request.body } : {}),
        timeoutMs,
        headersTimeoutMs: timeoutMs,
        // Wall-clock bound: `timeoutMs` alone is socket inactivity.
        signal: AbortSignal.timeout(timeoutMs),
        maxBytes,
        allowPrivateNetwork: this.opts.allowPrivateNetwork,
      });

      if (res.status >= 300 && res.status < 400) {
        return { isError: true, text: `HTTP ${res.status}: redirect not followed (operations are only sent to the API base URL)` };
      }
      const text = await res.text();
      // Depth: safeFetch enforces maxBytes while buffering; this holds for any transport.
      if (Buffer.byteLength(text, 'utf8') > maxBytes) {
        return { isError: true, text: `response exceeded the ${maxBytes}-byte limit` };
      }
      if (!res.ok) {
        // Redact BEFORE cutting, so a secret straddling the cut cannot leave a prefix.
        return { isError: true, text: `HTTP ${res.status}: ${redactSecrets(text, secrets).slice(0, OPENAPI_ERROR_BODY_CHARS)}` };
      }
      if (text === '') return { isError: false, text: `HTTP ${res.status} (no content)` };
      return { isError: false, text: redactSecrets(text, secrets) };
    } catch (err) {
      return { isError: true, text: redactSecrets(describeFailure(err, timeoutMs, maxBytes), secrets) };
    }
  }
}

function describeFailure(err: unknown, timeoutMs: number, maxBytes: number): string {
  if (err instanceof OpenApiRequestError || err instanceof ToolSourceAuthError) return err.message;
  if (err instanceof Error) {
    if (err.name === 'ResponseTooLargeError') return `response exceeded the ${maxBytes}-byte limit`;
    if (err.name === 'TimeoutError' || err.name === 'AbortError' || err.name === 'ResponseHeadersTimeoutError' || /timed out/i.test(err.message)) {
      return `request timed out after ${timeoutMs}ms`;
    }
    return `request failed: ${err.message}`;
  }
  return `request failed: ${String(err)}`;
}
