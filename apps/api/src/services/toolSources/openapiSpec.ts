/**
 * OpenAPI document fetch, parse and local-only dereference — Tool Catalog W2
 * (#5215 / #5217), plan Task 5 (D10, D11, D12, D14).
 *
 * Hand-rolled on purpose (D14): no OpenAPI/JSON-Schema-ref library enters the
 * API image, and the one rule that matters most here — a `$ref` may only
 * point INSIDE the document (D11) — is not those libraries' default. A remote
 * `$ref` is a second, unpinned egress target; it fails the whole discovery.
 *
 * Every byte comes in through `safeFetch` (pinned DNS, private ranges refused
 * unless the self-hosted opt-in is on, redirects NOT followed — a 3xx is an
 * error, because a redirect is exactly how a document host could move us
 * somewhere else). The credential rides along only when the document lives
 * on the credential's own origin; otherwise it is fetched anonymously.
 *
 * The document is vendor-controlled data and is treated as hostile input:
 * size-capped before parse, YAML alias/merge/depth limits, a structural depth
 * cap, a cap on distinct `$ref` targets and on `$ref` chain depth, cycles
 * resolved to `{}`, and JSON-pointer resolution that never walks the
 * prototype chain or rewrites `__proto__`.
 */
import { JSON_SCHEMA, load as loadYaml } from 'js-yaml';
import { safeFetch } from '../urlSafety';
import type { SafeFetchInit } from '../urlSafety';
import { buildToolSourceAuthHeaders } from './authHeaders';
import type { ToolSourceAuthConfig } from './secrets';

export const MAX_SPEC_BYTES = 5_242_880; // 5 MB (spec §5.3)
/** Longest chain of `$ref` → `$ref` → … before giving up. */
export const MAX_DEREF_DEPTH = 20;
/** Distinct `$ref` targets resolved per document (occurrences are bounded by MAX_SPEC_BYTES). */
export const MAX_DEREF_RESOLUTIONS = 5_000;
/** Structural nesting depth (objects/arrays) of the document. */
export const MAX_STRUCTURAL_DEPTH = 256;
export const SPEC_FETCH_TIMEOUT_MS = 30_000;
const MAX_YAML_ALIASES = 1_000;
const MAX_YAML_MERGE_KEYS = 1_000;
/** Literal-value keys whose contents are data, never Reference Objects. */
const LITERAL_VALUE_KEYS = new Set(['example', 'default', 'enum', 'const']);
/**
 * Keys whose value is a MAP OF NAMES (property names, component names, path
 * templates, status codes, media types…). Inside such a map a key called
 * `default`, `enum` or `x-foo` is a name, not a literal-value keyword, so its
 * value must still be dereferenced (and its `$ref`s checked for remoteness).
 */
const NAMED_MAP_KEYS = new Set([
  'properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas',
  'schemas', 'parameters', 'responses', 'requestBodies', 'headers', 'securitySchemes',
  'links', 'callbacks', 'pathItems', 'examples', 'encoding', 'content', 'paths',
  'webhooks', 'variables',
]);

export type OpenApiDocument = Record<string, unknown>;

export type OpenApiSpecErrorCode =
  | 'transport'
  | 'too_large'
  | 'parse'
  | 'unsupported_version'
  | 'remote_ref'
  | 'deref_limit'
  | 'too_many_operations';

export class OpenApiSpecError extends Error {
  constructor(message: string, readonly code: OpenApiSpecErrorCode) {
    super(message);
    this.name = 'OpenApiSpecError';
  }
}

export interface FetchSpecOptions {
  specUrl: string;
  credentialOrigin: string;
  auth: ToolSourceAuthConfig;
  allowPrivateNetwork?: boolean;
  /** default: `safeFetch` — tests inject a scripted fake. */
  fetchImpl?: (url: string, init: SafeFetchInit) => Promise<Response>;
  timeoutMs?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Defines an own, enumerable data property — `__proto__` stays a key, never a prototype write. */
function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Fetches, parses (JSON or YAML), version-gates and fully dereferences.
 * Throws `OpenApiSpecError` for every document/transport failure, or the
 * shared builder's `ToolSourceAuthError` when an on-origin OAuth2 exchange
 * fails. Must not be called inside a DB transaction (`safeFetch` asserts it).
 */
export async function fetchOpenApiDocument(opts: FetchSpecOptions): Promise<OpenApiDocument> {
  const fetchImpl = opts.fetchImpl ?? safeFetch;
  const timeoutMs = opts.timeoutMs ?? SPEC_FETCH_TIMEOUT_MS;
  const authHeaders = await buildToolSourceAuthHeaders(opts.auth, opts.specUrl, opts.credentialOrigin, {
    onOriginMismatch: 'omit',
    fetchImpl,
  });

  let res: Response;
  try {
    res = await fetchImpl(opts.specUrl, {
      method: 'GET',
      headers: { Accept: 'application/json, application/yaml, text/yaml, text/plain;q=0.5', ...authHeaders },
      timeoutMs,
      headersTimeoutMs: timeoutMs,
      // Wall-clock bound; `timeoutMs` alone is socket inactivity, and a
      // trickling server could otherwise hold the discovery job for hours.
      signal: AbortSignal.timeout(timeoutMs),
      maxBytes: MAX_SPEC_BYTES,
      allowPrivateNetwork: opts.allowPrivateNetwork,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'ResponseTooLargeError') {
      throw new OpenApiSpecError(`spec_too_large: the document exceeds ${MAX_SPEC_BYTES} bytes`, 'too_large');
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new OpenApiSpecError(`spec_fetch_failed: ${message}`, 'transport');
  }

  if (res.status >= 300 && res.status < 400) {
    // Location is deliberately not echoed: it is vendor-controlled and the
    // point is that we did not go there.
    throw new OpenApiSpecError(
      `spec_fetch_failed: HTTP ${res.status} (redirects are not followed; point the spec URL at the final location)`,
      'transport',
    );
  }
  if (!res.ok) {
    throw new OpenApiSpecError(`spec_fetch_failed: HTTP ${res.status}`, 'transport');
  }

  let body: string;
  try {
    body = await res.text();
  } catch (err) {
    if (err instanceof Error && err.name === 'ResponseTooLargeError') {
      throw new OpenApiSpecError(`spec_too_large: the document exceeds ${MAX_SPEC_BYTES} bytes`, 'too_large');
    }
    throw new OpenApiSpecError(`spec_fetch_failed: ${err instanceof Error ? err.message : String(err)}`, 'transport');
  }
  // Depth: safeFetch already enforced maxBytes while buffering; this holds for
  // any injected transport too.
  if (Buffer.byteLength(body, 'utf8') > MAX_SPEC_BYTES) {
    throw new OpenApiSpecError(`spec_too_large: the document exceeds ${MAX_SPEC_BYTES} bytes`, 'too_large');
  }

  return dereferenceLocal(parseOpenApiDocument(body));
}

/**
 * Parse + version gate, no I/O. Content is sniffed — JSON first, then YAML —
 * never trusted from `Content-Type` (vendors serve YAML as text/plain and JSON
 * as octet-stream routinely). YAML uses the JSON schema (typed booleans and
 * numbers; no custom tags) with alias, merge-key and depth limits.
 */
export function parseOpenApiDocument(body: string): OpenApiDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    try {
      parsed = loadYaml(body, {
        schema: JSON_SCHEMA,
        maxAliases: MAX_YAML_ALIASES,
        maxTotalMergeKeys: MAX_YAML_MERGE_KEYS,
        maxDepth: MAX_STRUCTURAL_DEPTH,
      });
    } catch (err) {
      const detail = err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err);
      throw new OpenApiSpecError(`spec_parse_failed: not valid JSON or YAML (${detail.slice(0, 200)})`, 'parse');
    }
  }
  if (!isPlainObject(parsed)) {
    throw new OpenApiSpecError('spec_parse_failed: the document is not a JSON/YAML object', 'parse');
  }

  if (parsed.swagger !== undefined) {
    throw new OpenApiSpecError(
      `unsupported_openapi_version: swagger ${String(parsed.swagger).slice(0, 20)} (only OpenAPI 3.0.x and 3.1.x are supported)`,
      'unsupported_version',
    );
  }
  // An unquoted `openapi: 3.1` in YAML is a number.
  const rawVersion = typeof parsed.openapi === 'number' ? String(parsed.openapi) : parsed.openapi;
  if (typeof rawVersion !== 'string' || !/^3\.[01](\.\d+)?(-[0-9A-Za-z.-]+)?$/.test(rawVersion)) {
    throw new OpenApiSpecError(
      `unsupported_openapi_version: ${rawVersion === undefined ? '(missing)' : String(rawVersion).slice(0, 20)} (only OpenAPI 3.0.x and 3.1.x are supported)`,
      'unsupported_version',
    );
  }
  if (rawVersion !== parsed.openapi) defineOwn(parsed, 'openapi', rawVersion);
  return parsed;
}

/** Decodes one `#/a/b~1c` fragment into its reference tokens. */
function pointerTokens(ref: string): string[] {
  const fragment = ref.slice(1); // drop '#'
  if (fragment === '') return [];
  if (!fragment.startsWith('/')) {
    throw new OpenApiSpecError(`spec_parse_failed: unsupported $ref form ${ref.slice(0, 200)}`, 'parse');
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    throw new OpenApiSpecError(`spec_parse_failed: malformed $ref ${ref.slice(0, 200)}`, 'parse');
  }
  return decoded
    .slice(1)
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function resolvePointer(root: unknown, ref: string): unknown {
  let node: unknown = root;
  for (const token of pointerTokens(ref)) {
    if (Array.isArray(node)) {
      if (!/^(0|[1-9]\d*)$/.test(token) || Number(token) >= node.length) node = undefined;
      else node = node[Number(token)];
    } else if (isPlainObject(node) && Object.prototype.hasOwnProperty.call(node, token)) {
      node = node[token];
    } else {
      node = undefined;
    }
    if (node === undefined) {
      throw new OpenApiSpecError(`spec_parse_failed: $ref target not found: ${ref.slice(0, 200)}`, 'parse');
    }
  }
  return node;
}

/**
 * Returns a copy of `doc` with every local `$ref` inlined (sibling keys merged
 * over the target, as 3.1 allows). Shared subtrees — repeated `$ref`s and
 * YAML aliases — are dereferenced ONCE and shared by reference, so work is
 * linear in the document; consumers that serialise must bound their own
 * output (the projector does, D12).
 */
export function dereferenceLocal(doc: OpenApiDocument): OpenApiDocument {
  /** pointer → dereferenced target (memo); `inProgress` marks the resolution path for cycle detection. */
  const resolved = new Map<string, unknown>();
  const inProgress = new Set<string>();
  /**
   * original node → COMPLETED dereferenced node, so a shared/aliased subtree is
   * walked once — one memo per walk context (inside a named map or not), since
   * the literal-key rule differs between them.
   */
  const walkedPlain = new WeakMap<object, unknown>();
  const walkedNamed = new WeakMap<object, unknown>();
  /**
   * Original nodes on the current walk path. Meeting one again is a cycle —
   * through a `$ref` back into an ancestor, or a self-referencing YAML alias —
   * and is cut to an empty value, so the output is always an acyclic tree
   * (shared subtrees allowed) that a recursive consumer can never loop on.
   */
  const walking = new WeakSet<object>();
  let distinctResolutions = 0;

  const resolveRef = (ref: string, refDepth: number, structDepth: number): unknown => {
    if (!ref.startsWith('#')) {
      throw new OpenApiSpecError(`remote_ref_rejected: ${ref.slice(0, 500)}`, 'remote_ref');
    }
    if (inProgress.has(ref)) return {}; // cycle → empty schema, never recursion
    const memo = resolved.get(ref);
    if (memo !== undefined) return memo;
    if (refDepth > MAX_DEREF_DEPTH) {
      throw new OpenApiSpecError(`spec_too_complex: $ref chain deeper than ${MAX_DEREF_DEPTH}`, 'deref_limit');
    }
    distinctResolutions += 1;
    if (distinctResolutions > MAX_DEREF_RESOLUTIONS) {
      throw new OpenApiSpecError(`spec_too_complex: more than ${MAX_DEREF_RESOLUTIONS} distinct $ref targets`, 'deref_limit');
    }
    const target = resolvePointer(doc, ref);
    // A pointer into an ancestor of the node being walked is a cycle too; the
    // placeholder is returned WITHOUT memoising it against the pointer.
    if (typeof target === 'object' && target !== null && walking.has(target)) return {};
    inProgress.add(ref);
    try {
      const out = walk(target, refDepth + 1, structDepth);
      resolved.set(ref, out);
      return out;
    } finally {
      inProgress.delete(ref);
    }
  };

  const walk = (node: unknown, refDepth: number, structDepth: number, namedMap = false): unknown => {
    if (node === null || typeof node !== 'object') return node;
    if (structDepth > MAX_STRUCTURAL_DEPTH) {
      throw new OpenApiSpecError(`spec_too_complex: nesting deeper than ${MAX_STRUCTURAL_DEPTH}`, 'deref_limit');
    }
    const walked = namedMap ? walkedNamed : walkedPlain;
    const seen = walked.get(node);
    if (seen !== undefined) return seen;
    if (walking.has(node)) return Array.isArray(node) ? [] : {};

    walking.add(node);
    try {
      if (Array.isArray(node)) {
        const out: unknown[] = [];
        for (const item of node) out.push(walk(item, refDepth, structDepth + 1));
        walked.set(node, out);
        return out;
      }

      const obj = node as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(obj, '$ref') && typeof obj.$ref === 'string') {
        const target = resolveRef(obj.$ref, refDepth, structDepth);
        const siblings = Object.keys(obj).filter((k) => k !== '$ref');
        // Not memoised in `walked`: the result depends on which refs were in
        // progress (a cycle placeholder must not stick to this node).
        if (siblings.length === 0 || !isPlainObject(target)) return target;
        const merged: Record<string, unknown> = {};
        for (const key of Object.keys(target)) defineOwn(merged, key, target[key]);
        for (const key of siblings) defineOwn(merged, key, walkChild(key, obj[key], refDepth, structDepth, namedMap));
        return merged;
      }

      const out: Record<string, unknown> = {};
      for (const key of Object.keys(obj)) defineOwn(out, key, walkChild(key, obj[key], refDepth, structDepth, namedMap));
      walked.set(node, out);
      return out;
    } finally {
      walking.delete(node);
    }
  };

  const walkChild = (key: string, value: unknown, refDepth: number, structDepth: number, parentIsNamedMap: boolean): unknown => {
    // Literal values and vendor extensions are data: an `example` that happens
    // to contain a `$ref` key must neither be resolved nor fail the document.
    // Inside a map of names (`properties`, `components.schemas`, …) the key is
    // a NAME, so `properties.default` is a schema and is walked like any other.
    if (!parentIsNamedMap && (LITERAL_VALUE_KEYS.has(key) || key.startsWith('x-'))) return value;
    return walk(value, refDepth, structDepth + 1, !parentIsNamedMap && NAMED_MAP_KEYS.has(key));
  };

  const out = walk(doc, 0, 0);
  return out as OpenApiDocument;
}
