/**
 * OpenAPI operation → tool projection — Tool Catalog W2 (#5215 / #5217),
 * plan Task 6 (D4, D5, D7, D8, D9, D12, D16).
 *
 * Turns a dereferenced OpenAPI 3.0/3.1 document into the kind-agnostic
 * listing the W01 discovery reconcile loop already consumes (same shape as
 * `McpToolListing`), plus the operations it refused and why.
 *
 * Fail-closed rules, each visible as a `skipped` reason rather than silently
 * approximated: only get/head/post/put/patch/delete are projected; only the
 * default parameter serialisations; JSON request bodies only; operations whose
 * every security alternative needs a credential in a query string, a cookie,
 * OpenID Connect or mutual TLS are refused (Breeze only ever sends the
 * source's credential in a header); ≤ 100 parameters; ≤ 64 KB per generated
 * schema, measured by a BOUNDED serialiser so a schema with exponential
 * sharing is rejected without being expanded.
 *
 * Tiers are expressed as annotations so `proposeTier` stays the single tier
 * function: GET/HEAD carry `readOnlyHint: true` (→ 1), DELETE carries
 * `destructiveHint: true`, everything else carries neither (→ 3).
 *
 * `servers[]` NEVER routes (D4). The binding records the path template only;
 * the executor always prefixes `tool_sources.endpoint_url`. Off-origin
 * servers are reported as warnings and nothing more.
 *
 * Vendor text (summaries, descriptions) is data. It is stored and later shown
 * to the model behind the `[External: <source>]` prefix `sdkBridge.ts` adds.
 */
import { qualifiedToolName, QUALIFIED_TOOL_NAME_MAX, SOURCE_TOOL_NAME_RE } from '@breeze/shared';
import type { ToolSourceSkipReason } from '@breeze/shared';
import { OpenApiSpecError, type OpenApiDocument } from './openapiSpec';

export const PROJECTABLE_METHODS = ['get', 'head', 'post', 'put', 'patch', 'delete'] as const;
export type ProjectableMethod = (typeof PROJECTABLE_METHODS)[number];
const UNPROJECTED_HTTP_METHODS = ['options', 'trace'] as const;
export const MAX_OPERATIONS = 2_000;
export const MAX_SCHEMA_BYTES = 65_536;
export const MAX_PARAMETERS = 100;
export const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_SKIP_LABEL_CHARS = 256;
const MAX_SERVER_URL_CHARS = 2_048;
const MAX_SERVER_WARNINGS = 20;

export type SkipReason = ToolSourceSkipReason;

export type ParamLocation = 'path' | 'query' | 'header';

/** The routing contract stored on `tool_source_tools.annotations.operation`. */
export interface OperationBinding {
  method: ProjectableMethod;
  /** Template path exactly as written in the document, e.g. `/pets/{petId}`. */
  path: string;
  operationId: string | null;
  /** Where each input property goes. `property` is the input-schema key. */
  params: Array<{ name: string; in: ParamLocation; property: string; required: boolean }>;
  /** Present when the operation takes an application/json body. */
  body: { property: string; required: boolean } | null;
  /** Recorded for the servers[] cross-check only; never used for routing. */
  declaredServer: string | null;
}

export interface ProjectedOperation {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /** `{ readOnlyHint?, destructiveHint?, operation: OperationBinding }`. */
  annotations: Record<string, unknown>;
}

export interface ProjectedSkip {
  name: string;
  method: string;
  path: string;
  reason: SkipReason;
}

export interface ProjectionResult {
  operations: ProjectedOperation[];
  skipped: ProjectedSkip[];
  /** Projectable operations in the document (before skips). */
  operationCount: number;
  /** servers[] origins that do not match the pinned credential origin (D4). */
  serverOriginWarnings: string[];
}

export interface ProjectionContext {
  sourceSlug: string;
  credentialOrigin: string;
  /** Base for resolving relative `servers[].url` values. */
  specUrl?: string | null;
}

/** OAS 3 §4.8.12.1: header parameters with these names are ignored. */
const IGNORED_HEADER_PARAMS = new Set(['accept', 'content-type', 'authorization']);
/**
 * Headers a model-supplied value must never set: connection framing, host
 * routing, cookies and proxy credentials. An operation declaring one is
 * refused rather than half-called.
 */
const FORBIDDEN_HEADER_PARAMS = new Set([
  'host', 'cookie', 'set-cookie', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
  'upgrade', 'te', 'trailer', 'expect', 'proxy-authorization', 'proxy-authenticate', 'proxy-connection',
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip',
]);
const HEADER_TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function maxNameLength(slug: string): number {
  return QUALIFIED_TOOL_NAME_MAX - qualifiedToolName(slug, '').length;
}

function isAddressableName(name: string, slug: string): boolean {
  return SOURCE_TOOL_NAME_RE.test(name) && qualifiedToolName(slug, name).length <= QUALIFIED_TOOL_NAME_MAX;
}

/**
 * D16 naming: a sanitised `operationId` when it is addressable; otherwise
 * `<method>_<path>` synthesised and truncated to fit `<slug>__`; `null` when
 * nothing addressable remains.
 */
export function operationToolName(method: string, path: string, operationId: unknown, slug: string): string | null {
  if (typeof operationId === 'string') {
    const candidate = operationId.replace(/[./]/g, '_');
    if (isAddressableName(candidate, slug)) return candidate;
  }
  const limit = maxNameLength(slug);
  if (limit < 1) return null;
  const synthesised = `${method}_${path}`
    .replace(/\{([^}]*)\}/g, 'by_$1')
    .replace(/\//g, '_')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .slice(0, limit)
    .replace(/_+$/, '');
  return synthesised && isAddressableName(synthesised, slug) ? synthesised : null;
}

/** `stem`, then `stem_2`, `stem_3`, … — truncating the stem so the suffix still fits. */
function dedupeName(stem: string, taken: Set<string>, slug: string): string | null {
  if (!taken.has(stem)) return stem;
  const limit = maxNameLength(slug);
  for (let n = 2; n < 10_000; n++) {
    const suffix = `_${n}`;
    const candidate = `${stem.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
    if (!taken.has(candidate) && isAddressableName(candidate, slug)) return candidate;
  }
  return null;
}

/**
 * JSON serialisation that gives up (returns null) as soon as the output would
 * exceed `maxBytes`, so a deeply shared schema is never expanded in full.
 * Mirrors JSON.stringify for the plain data a parsed document contains.
 */
export function boundedJsonStringify(value: unknown, maxBytes: number): string | null {
  const parts: string[] = [];
  let size = 0;
  const push = (s: string): boolean => {
    size += Buffer.byteLength(s, 'utf8');
    if (size > maxBytes) return false;
    parts.push(s);
    return true;
  };
  const visit = (v: unknown, depth: number): boolean => {
    if (depth > 512) return false;
    if (v === null) return push('null');
    switch (typeof v) {
      case 'string':
        return push(JSON.stringify(v));
      case 'number':
        return push(Number.isFinite(v) ? String(v) : 'null');
      case 'boolean':
        return push(v ? 'true' : 'false');
      case 'object': {
        if (Array.isArray(v)) {
          if (!push('[')) return false;
          for (let i = 0; i < v.length; i++) {
            if (i > 0 && !push(',')) return false;
            const item = v[i];
            const ok = item === undefined || typeof item === 'function' || typeof item === 'symbol'
              ? push('null')
              : visit(item, depth + 1);
            if (!ok) return false;
          }
          return push(']');
        }
        if (!push('{')) return false;
        let first = true;
        for (const key of Object.keys(v as Record<string, unknown>)) {
          const item = (v as Record<string, unknown>)[key];
          if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
          if (!first && !push(',')) return false;
          first = false;
          if (!push(`${JSON.stringify(key)}:`)) return false;
          if (!visit(item, depth + 1)) return false;
        }
        return push('}');
      }
      default:
        return push('null');
    }
  };
  return visit(value, 0) ? parts.join('') : null;
}

/** OpenAPI 3.0 `nullable: true` → a JSON-Schema type union (3.1 already uses the union). */
function schemaReviver(this: unknown, _key: string, value: unknown): unknown {
  // Only the boolean keyword: an object under a property NAMED `nullable`
  // (`properties: { nullable: {…} }`) is a schema, not the keyword, and stays.
  if (isPlainObject(value) && typeof value.nullable === 'boolean') {
    const nullable = value.nullable === true;
    delete value.nullable;
    if (nullable) {
      if (typeof value.type === 'string') value.type = [value.type, 'null'];
      else if (Array.isArray(value.type) && !value.type.includes('null')) value.type = [...value.type, 'null'];
    }
  }
  return value;
}

/** A bounded, plain (no shared references), JSON-Schema-normalised copy — or null when over `maxBytes`. */
function boundedSchemaCopy(value: unknown, maxBytes: number): Record<string, unknown> | null {
  const text = boundedJsonStringify(value, maxBytes);
  if (text === null) return null;
  const parsed = JSON.parse(text, schemaReviver) as unknown;
  return isPlainObject(parsed) ? parsed : null;
}

function isJsonMediaType(mediaType: string): boolean {
  const base = mediaType.split(';')[0]!.trim().toLowerCase();
  return base === 'application/json' || (base.startsWith('application/') && base.endsWith('+json'));
}

function jsonMedia(content: unknown): { found: boolean; schema: unknown; hasContent: boolean } {
  if (!isPlainObject(content)) return { found: false, schema: undefined, hasContent: false };
  const keys = Object.keys(content);
  const key = keys.find(isJsonMediaType);
  if (key === undefined) return { found: false, schema: undefined, hasContent: keys.length > 0 };
  const media = content[key];
  return { found: true, schema: isPlainObject(media) ? media.schema : undefined, hasContent: true };
}

function stringOr(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** A path template the executor can append to `endpoint_url` without leaving it. */
function isRoutablePath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//')) return false;
  if (/[?#\\\s]/.test(path)) return false;
  return !path.split('/').some((segment) => segment === '.' || segment === '..' || /^%2e(%2e)?$/i.test(segment));
}

function securityAlternativeSupported(
  requirement: unknown,
  schemes: Record<string, unknown>,
): boolean {
  if (!isPlainObject(requirement)) return false;
  return Object.keys(requirement).every((schemeName) => {
    const scheme = Object.prototype.hasOwnProperty.call(schemes, schemeName) ? schemes[schemeName] : undefined;
    if (!isPlainObject(scheme)) return true; // undeclared → nothing we would refuse to send
    if (scheme.type === 'openIdConnect' || scheme.type === 'mutualTLS') return false;
    if (scheme.type === 'apiKey' && (scheme.in === 'query' || scheme.in === 'cookie')) return false;
    return true;
  });
}

interface RawParam {
  name: string;
  in: string;
  required: boolean;
  description: string | null;
  schema: unknown;
  style: unknown;
  explode: unknown;
  hasContent: boolean;
}

function readParam(value: unknown): RawParam | null {
  if (!isPlainObject(value) || typeof value.name !== 'string' || value.name === '' || typeof value.in !== 'string') return null;
  return {
    name: value.name,
    in: value.in,
    required: value.required === true,
    description: stringOr(value.description),
    schema: value.schema,
    style: value.style,
    explode: value.explode,
    hasContent: value.content !== undefined,
  };
}

function paramKey(p: { name: string; in: string }): string {
  return `${p.in}:${p.in === 'header' ? p.name.toLowerCase() : p.name}`;
}

/** D9: only the default serialisation for each location is supported. */
function paramStyleSupported(p: RawParam): boolean {
  if (p.hasContent) return false;
  switch (p.in) {
    case 'path':
      return (p.style === undefined || p.style === 'simple') && (p.explode === undefined || p.explode === false);
    case 'query':
      return (p.style === undefined || p.style === 'form') && (p.explode === undefined || p.explode === true);
    case 'header':
      return (
        (p.style === undefined || p.style === 'simple')
        && (p.explode === undefined || p.explode === false)
        && HEADER_TOKEN_RE.test(p.name)
        && !FORBIDDEN_HEADER_PARAMS.has(p.name.toLowerCase())
      );
    default:
      return false; // cookie, and anything that is not an OpenAPI location
  }
}

function propertyNameFor(raw: string, taken: Set<string>): string {
  let base = raw.replace(/[^A-Za-z0-9_]/g, '_');
  if (base === '') base = 'p';
  if (/^[0-9]/.test(base) || base === '__proto__') base = `p_${base}`;
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base}_${n}`;
  taken.add(candidate);
  return candidate;
}

function collectServerUrls(container: unknown): string[] {
  if (!isPlainObject(container) || !Array.isArray(container.servers)) return [];
  const urls: string[] = [];
  for (const server of container.servers) {
    if (!isPlainObject(server) || typeof server.url !== 'string') continue;
    let url = server.url;
    const variables = isPlainObject(server.variables) ? server.variables : {};
    url = url.replace(/\{([^}]+)\}/g, (whole, name: string) => {
      const variable = Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : undefined;
      return isPlainObject(variable) && typeof variable.default === 'string' ? variable.default : whole;
    });
    urls.push(url);
  }
  return urls;
}

function firstServerUrl(...containers: unknown[]): string | null {
  for (const container of containers) {
    if (!isPlainObject(container) || !Array.isArray(container.servers)) continue;
    const first = container.servers[0];
    if (isPlainObject(first) && typeof first.url === 'string') return first.url.slice(0, MAX_SERVER_URL_CHARS);
  }
  return null;
}

function originOf(url: string, base: string | null | undefined): string | null {
  try {
    const parsed = base ? new URL(url, base) : new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Projects every operation of `doc` (already dereferenced). Throws
 * `OpenApiSpecError('too_many_operations')` BEFORE projecting anything when
 * the document has more than `MAX_OPERATIONS` projectable operations — a
 * truncated catalog is worse than none, because the missing half is invisible.
 */
export function projectOpenApiDocument(doc: OpenApiDocument, ctx: ProjectionContext): ProjectionResult {
  const paths = isPlainObject(doc.paths) ? doc.paths : {};
  const pathEntries = Object.keys(paths)
    .map((path) => [path, paths[path]] as const)
    .filter((entry): entry is readonly [string, Record<string, unknown>] => isPlainObject(entry[1]));

  let operationCount = 0;
  for (const [, item] of pathEntries) {
    for (const method of PROJECTABLE_METHODS) if (isPlainObject(item[method])) operationCount += 1;
  }
  if (operationCount > MAX_OPERATIONS) {
    throw new OpenApiSpecError(`too_many_operations: ${operationCount} (limit ${MAX_OPERATIONS})`, 'too_many_operations');
  }
  // A document with nothing to project is almost always the wrong URL (a docs
  // landing page that parsed, a webhooks-only spec). Fail loudly rather than
  // report an empty, "active" source — re-discovery would otherwise also
  // soft-remove every existing tool with no visible reason.
  const hasUnprojectedMethods = pathEntries.some(([, item]) =>
    UNPROJECTED_HTTP_METHODS.some((m) => isPlainObject(item[m])));
  if (operationCount === 0 && !hasUnprojectedMethods) {
    throw new OpenApiSpecError('spec_has_no_operations: the document declares no callable operations under paths', 'parse');
  }

  const components = isPlainObject(doc.components) ? doc.components : {};
  const securitySchemes = isPlainObject(components.securitySchemes) ? components.securitySchemes : {};
  const docSecurity = Array.isArray(doc.security) ? doc.security : [];

  const operations: ProjectedOperation[] = [];
  const skipped: ProjectedSkip[] = [];
  const takenNames = new Set<string>();
  const warningOrigins: string[] = [];
  const noteServers = (container: unknown) => {
    for (const url of collectServerUrls(container)) {
      const origin = originOf(url, ctx.specUrl ?? ctx.credentialOrigin);
      if (origin && origin !== ctx.credentialOrigin && !warningOrigins.includes(origin) && warningOrigins.length < MAX_SERVER_WARNINGS) {
        warningOrigins.push(origin);
      }
    }
  };
  noteServers(doc);

  for (const [path, item] of pathEntries) {
    noteServers(item);
    const pathParams = Array.isArray(item.parameters) ? item.parameters : [];

    for (const method of [...PROJECTABLE_METHODS, ...UNPROJECTED_HTTP_METHODS]) {
      const op = item[method];
      if (!isPlainObject(op)) continue;
      noteServers(op);
      const operationId = typeof op.operationId === 'string' ? op.operationId : null;
      const skip = (reason: SkipReason) => {
        skipped.push({
          name: (operationId ?? `${method.toUpperCase()} ${path}`).slice(0, MAX_SKIP_LABEL_CHARS),
          method: method.toUpperCase(),
          path: path.slice(0, MAX_SERVER_URL_CHARS),
          reason,
        });
      };

      if (!(PROJECTABLE_METHODS as readonly string[]).includes(method)) {
        skip('unsupported_method');
        continue;
      }
      if (!isRoutablePath(path)) {
        skip('unsupported_path');
        continue;
      }

      // D7 — every security alternative needs a non-header credential ⇒ refuse.
      const security = Array.isArray(op.security) ? op.security : docSecurity;
      if (security.length > 0 && !security.some((req) => securityAlternativeSupported(req, securitySchemes))) {
        skip('unsupported_security_location');
        continue;
      }

      // Parameters: path-item first, operation overrides by (location, name).
      const merged = new Map<string, RawParam>();
      let malformed = false;
      for (const rawParam of [...pathParams, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const p = readParam(rawParam);
        if (!p) {
          malformed = true;
          break;
        }
        merged.set(paramKey(p), p);
      }
      if (malformed) {
        skip('unsupported_param_style');
        continue;
      }
      if (merged.size > MAX_PARAMETERS) {
        skip('too_many_parameters');
        continue;
      }
      const params = [...merged.values()].filter(
        (p) => !(p.in === 'header' && IGNORED_HEADER_PARAMS.has(p.name.toLowerCase())),
      );
      if (!params.every(paramStyleSupported)) {
        skip('unsupported_param_style');
        continue;
      }

      // Path template ↔ declared path parameters.
      const templateNames = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
      const effective = params.filter((p) => p.in !== 'path' || templateNames.includes(p.name));
      for (const name of templateNames) {
        if (!effective.some((p) => p.in === 'path' && p.name === name)) {
          effective.push({
            name, in: 'path', required: true, description: null, schema: { type: 'string' },
            style: undefined, explode: undefined, hasContent: false,
          });
        }
      }

      // D9 — application/json (or +json) request bodies only.
      let bodySchema: unknown;
      let bodyRequired = false;
      let bodyDescription: string | null = null;
      let hasBody = false;
      if (isPlainObject(op.requestBody)) {
        const media = jsonMedia(op.requestBody.content);
        if (!media.found && media.hasContent) {
          skip('unsupported_request_body');
          continue;
        }
        if (media.found) {
          hasBody = true;
          bodySchema = isPlainObject(media.schema) ? media.schema : {};
          bodyRequired = op.requestBody.required === true;
          bodyDescription = stringOr(op.requestBody.description);
        }
      }

      const takenProps = new Set<string>();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      const binding: OperationBinding = {
        method: method as ProjectableMethod, // unprojected verbs were skipped above
        path,
        operationId,
        params: [],
        body: null,
        declaredServer: firstServerUrl(op, item, doc),
      };
      for (const p of effective) {
        const property = propertyNameFor(p.name, takenProps);
        const isRequired = p.in === 'path' ? true : p.required;
        const schema: Record<string, unknown> = {};
        if (isPlainObject(p.schema)) for (const key of Object.keys(p.schema)) defineOwn(schema, key, p.schema[key]);
        if (p.description) defineOwn(schema, 'description', p.description);
        defineOwn(properties, property, schema);
        if (isRequired) required.push(property);
        binding.params.push({ name: p.name, in: p.in as ParamLocation, property, required: isRequired });
      }
      if (hasBody) {
        const property = propertyNameFor('body', takenProps);
        const schema: Record<string, unknown> = {};
        if (isPlainObject(bodySchema)) for (const key of Object.keys(bodySchema)) defineOwn(schema, key, bodySchema[key]);
        if (bodyDescription && schema.description === undefined) defineOwn(schema, 'description', bodyDescription);
        defineOwn(properties, property, schema);
        if (bodyRequired) required.push(property);
        binding.body = { property, required: bodyRequired };
      }

      const inputSchema = boundedSchemaCopy(
        { type: 'object', properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false },
        MAX_SCHEMA_BYTES,
      );
      if (!inputSchema) {
        skip('schema_too_large');
        continue;
      }

      const stem = operationToolName(method, path, operationId, ctx.sourceSlug);
      const name = stem === null ? null : dedupeName(stem, takenNames, ctx.sourceSlug);
      if (name === null) {
        skip('name_not_addressable');
        continue;
      }
      takenNames.add(name);

      let outputSchema: Record<string, unknown> | undefined;
      if (isPlainObject(op.responses)) {
        for (const status of Object.keys(op.responses)) {
          if (!/^2(\d\d|XX)$/i.test(status)) continue;
          const response = op.responses[status];
          if (!isPlainObject(response)) continue;
          const media = jsonMedia(response.content);
          if (!media.found || !isPlainObject(media.schema)) continue;
          outputSchema = boundedSchemaCopy(media.schema, MAX_SCHEMA_BYTES) ?? undefined;
          break;
        }
      }

      const text = stringOr(op.summary) ?? stringOr(op.description) ?? stringOr(item.summary) ?? stringOr(item.description);
      const description = (text ?? `${method.toUpperCase()} ${path}`).slice(0, MAX_DESCRIPTION_CHARS);

      const annotations: Record<string, unknown> = {};
      if (method === 'get' || method === 'head') annotations.readOnlyHint = true;
      if (method === 'delete') annotations.destructiveHint = true;
      annotations.operation = binding;

      operations.push({ name, description, inputSchema, ...(outputSchema ? { outputSchema } : {}), annotations });
    }
  }

  return { operations, skipped, operationCount, serverOriginWarnings: warningOrigins };
}

const PARAM_LOCATIONS: readonly string[] = ['path', 'query', 'header'];

/**
 * Reads a binding back out of stored jsonb. `null` unless every field has the
 * exact shape the executor relies on — a hand-edited or pre-W2 row must never
 * produce a call with guessed routing.
 */
export function asOperationBinding(annotations: unknown): OperationBinding | null {
  if (!isPlainObject(annotations) || !isPlainObject(annotations.operation)) return null;
  const op = annotations.operation;
  if (typeof op.method !== 'string' || !(PROJECTABLE_METHODS as readonly string[]).includes(op.method)) return null;
  if (typeof op.path !== 'string' || !isRoutablePath(op.path)) return null;
  if (op.operationId !== null && typeof op.operationId !== 'string') return null;
  if (!Array.isArray(op.params)) return null;
  for (const p of op.params) {
    if (
      !isPlainObject(p)
      || typeof p.name !== 'string'
      || typeof p.in !== 'string'
      || !PARAM_LOCATIONS.includes(p.in)
      || typeof p.property !== 'string'
      || typeof p.required !== 'boolean'
    ) {
      return null;
    }
  }
  if (op.body !== null) {
    if (!isPlainObject(op.body) || typeof op.body.property !== 'string' || typeof op.body.required !== 'boolean') return null;
  }
  if (op.declaredServer !== null && op.declaredServer !== undefined && typeof op.declaredServer !== 'string') return null;
  return {
    method: op.method as ProjectableMethod,
    path: op.path,
    operationId: (op.operationId as string | null) ?? null,
    params: (op.params as Array<Record<string, unknown>>).map((p) => ({
      name: p.name as string,
      in: p.in as ParamLocation,
      property: p.property as string,
      required: p.required as boolean,
    })),
    body: op.body === null ? null : { property: (op.body as Record<string, unknown>).property as string, required: (op.body as Record<string, unknown>).required as boolean },
    declaredServer: (op.declaredServer as string | null | undefined) ?? null,
  };
}
