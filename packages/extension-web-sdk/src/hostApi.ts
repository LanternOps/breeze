/**
 * Host API v1 — the authenticated request capability the web host hands every
 * extension element.
 *
 * Breeze's API accepts a Bearer access token only (no cookie auth), and that
 * token lives in the host app's memory. An extension element that calls the
 * global `fetch` therefore sends no `Authorization` header and gets 401. The
 * host instead assigns a frozen {@link ExtensionHostApiV1} to the element's
 * {@link EXTENSION_HOST_API_PROPERTY} property (BEFORE `context`), and the
 * element routes its own API traffic through `hostApi.fetch`.
 *
 * The capability is deliberately narrow:
 * - the raw access token never reaches extension code — the host's transport
 *   attaches it, refreshes it on 401, and replays session-binding rotation;
 * - `fetch` only reaches the extension's own namespace
 *   (`/api/v1/ext/<name>/...`). Absolute and protocol-relative URLs, other
 *   extensions, core API routes, traversal and encoded path tricks are refused
 *   before the transport is called;
 * - only `method`, `headers`, `body` and `signal` cross the boundary. Caller
 *   `Authorization`/`Cookie` headers are dropped, and `credentials`/`mode` or
 *   host-only transport options cannot be passed through.
 */

/** Property name on the extension element the host assigns the host API to. */
export const EXTENSION_HOST_API_PROPERTY = 'hostApi' as const;

/** Root of every extension's API namespace. */
export const EXTENSION_API_ROOT = '/api/v1/ext/';

/** Mirrors the manifest `name` rule in `@breeze/extension-sdk`. */
const EXTENSION_NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** Headers an extension may not set: the host owns authentication. */
const STRIPPED_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

/** Upper bound on a request path, query included. */
const MAX_PATH_LENGTH = 8192;

export class ExtensionApiPathError extends Error {
  constructor(reason: string) {
    super(`extension API request refused: ${reason}`);
    this.name = 'ExtensionApiPathError';
  }
}

/** The request options an extension may pass to {@link ExtensionHostApiV1.fetch}. */
export interface ExtensionFetchInit {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  signal?: AbortSignal | null;
}

/**
 * The host's authenticated request function. It receives an already-validated
 * root-relative path inside the extension's namespace and a sanitized init.
 */
export type ExtensionHostTransport = (path: string, init: ExtensionFetchInit) => Promise<Response>;

export interface ExtensionHostApiV1 {
  readonly contractVersion: 1;
  /** The extension this capability is scoped to. */
  readonly extensionName: string;
  /** `/api/v1/ext/<extensionName>/` — the only prefix `fetch` accepts. */
  readonly apiBase: string;
  /**
   * Authenticated request to the extension's own API. `path` must be
   * root-relative and start with {@link apiBase}. Resolves with the raw
   * `Response` for any HTTP status; rejects with
   * {@link ExtensionApiPathError} for a refused path, or with the
   * transport's own error (network failure, abort, ended session).
   */
  fetch(path: string, init?: ExtensionFetchInit): Promise<Response>;
}

/** `/api/v1/ext/<name>/` for a valid manifest extension name. */
export function extensionApiBase(extensionName: string): string {
  if (typeof extensionName !== 'string' || !EXTENSION_NAME_RE.test(extensionName)) {
    throw new ExtensionApiPathError('invalid extension name');
  }
  return `${EXTENSION_API_ROOT}${extensionName}/`;
}

/** Any control character, whitespace, or DEL — the URL parser silently strips some of these. */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHAR_RE = /[\u0000- \u007f]/;

/**
 * Validate that `path` is a root-relative request inside the extension's own
 * API namespace and return it unchanged. Throws {@link ExtensionApiPathError}
 * otherwise. Percent-encoding is allowed in the query string only.
 */
export function assertExtensionApiPath(path: unknown, extensionName: string): string {
  const base = extensionApiBase(extensionName);
  if (typeof path !== 'string' || path.length === 0) {
    throw new ExtensionApiPathError('path must be a non-empty string');
  }
  if (path.length > MAX_PATH_LENGTH) throw new ExtensionApiPathError('path is too long');
  if (UNSAFE_CHAR_RE.test(path)) throw new ExtensionApiPathError('whitespace and control characters are not allowed');
  if (path.includes('\\')) throw new ExtensionApiPathError('backslashes are not allowed');
  if (path.includes('#')) throw new ExtensionApiPathError('fragments are not allowed');

  const queryIndex = path.indexOf('?');
  const pathname = queryIndex >= 0 ? path.slice(0, queryIndex) : path;

  if (!pathname.startsWith(base)) {
    throw new ExtensionApiPathError(`path must start with ${base}`);
  }
  if (pathname.includes('%')) {
    throw new ExtensionApiPathError('percent-encoding is not allowed in the path');
  }
  for (const segment of pathname.slice(base.length).split('/')) {
    if (segment === '.' || segment === '..') {
      throw new ExtensionApiPathError('dot segments are not allowed');
    }
  }
  if (pathname.slice(1).includes('//')) {
    throw new ExtensionApiPathError('empty path segments are not allowed');
  }

  // Belt and braces: what a URL parser resolves this to must be exactly the
  // path we checked, on the origin we resolved against.
  const probeOrigin = 'https://extension-host.invalid';
  const resolved = new URL(path, probeOrigin);
  if (resolved.origin !== probeOrigin || resolved.pathname !== pathname) {
    throw new ExtensionApiPathError('path does not resolve to itself');
  }
  return path;
}

function sanitizeInit(init: ExtensionFetchInit | undefined): ExtensionFetchInit {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new ExtensionApiPathError(`method ${JSON.stringify(init?.method)} is not allowed`);
  }
  const headers = new Headers(init?.headers);
  for (const name of STRIPPED_HEADERS) headers.delete(name);

  const sanitized: ExtensionFetchInit = { method, headers };
  if (init?.body !== undefined) sanitized.body = init.body;
  if (init?.signal !== undefined) sanitized.signal = init.signal;
  return sanitized;
}

export interface CreateExtensionHostApiV1Options {
  extensionName: string;
  transport: ExtensionHostTransport;
}

/** Build the frozen host API for one extension. Used by the web host and the testkit. */
export function createExtensionHostApiV1({
  extensionName,
  transport,
}: CreateExtensionHostApiV1Options): ExtensionHostApiV1 {
  const apiBase = extensionApiBase(extensionName);
  return Object.freeze({
    contractVersion: 1 as const,
    extensionName,
    apiBase,
    async fetch(path: string, init?: ExtensionFetchInit): Promise<Response> {
      const checked = assertExtensionApiPath(path, extensionName);
      return transport(checked, sanitizeInit(init));
    },
  });
}

/**
 * Element-side check of the value the host assigned to
 * {@link EXTENSION_HOST_API_PROPERTY}. Returns it unchanged, or throws if it is
 * missing or not a v1 host API.
 */
export function parseExtensionHostApiV1(input: unknown): ExtensionHostApiV1 {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('host API v1 is missing');
  }
  const candidate = input as Partial<ExtensionHostApiV1>;
  if (
    candidate.contractVersion !== 1
    || typeof candidate.extensionName !== 'string'
    || typeof candidate.apiBase !== 'string'
    || typeof candidate.fetch !== 'function'
  ) {
    throw new TypeError('value is not a host API v1');
  }
  return input as ExtensionHostApiV1;
}
