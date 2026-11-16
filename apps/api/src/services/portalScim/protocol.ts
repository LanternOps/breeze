/**
 * SCIM 2.0 (RFC 7643 / 7644) wire handling for Entra Users provisioning
 * (portal registration W9 #11386, plan D4, D5, D8). Pure: no DB, no I/O.
 *
 * SCIM manages a fixed set of attributes: `externalId` (the Entra objectId,
 * immutable), `userName`, `active`, `displayName`, `name.givenName`,
 * `name.familyName`. Everything else Entra may send — `emails`,
 * `phoneNumbers`, `title`, the enterprise extension, any other URN — is
 * accepted and ignored in every form, so an admin's extra mappings never break
 * provisioning. Every refusal is a {@link ScimError} the router renders as an
 * RFC 7644 §3.12 error body.
 */

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const SCIM_CONTENT_TYPE = 'application/scim+json';
export const SCIM_MAX_PAGE = 100;

export type ScimErrorType = 'invalidFilter' | 'invalidSyntax' | 'invalidValue' | 'mutability' | 'noTarget' | 'uniqueness';
export type ScimErrorStatus = 400 | 401 | 404 | 409 | 413 | 429 | 500;

export class ScimError extends Error {
  constructor(
    readonly status: ScimErrorStatus,
    message: string,
    readonly scimType?: ScimErrorType,
  ) {
    super(message);
    this.name = 'ScimError';
  }
}

const bad = (message: string, scimType: ScimErrorType = 'invalidValue') => new ScimError(400, message, scimType);

export function scimErrorBody(status: number, detail: string, scimType?: ScimErrorType) {
  return {
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  };
}

/** The SCIM attributes this service stores (plan D3, D5). */
export interface ScimUserAttrs {
  externalId: string;
  userName: string;
  active: boolean;
  displayName: string | null;
  givenName: string | null;
  familyName: string | null;
}

/** A PUT: like a create, but an omitted `active` leaves it unchanged (D8). */
export type ScimReplaceAttrs = Omit<ScimUserAttrs, 'active'> & { active?: boolean };

/** A PATCH, reduced to the attributes SCIM manages; absent keys are untouched. */
export type ScimUserPatch = Partial<ScimUserAttrs>;

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Deliberately loose (one @, a dotted domain, no spaces): the address is the
// directory's UPN; it only has to be usable as a login address.
const ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_USER_NAME = 320;
const MAX_NAME_PART = 256;
const CORE_PREFIX = `${SCIM_USER_SCHEMA.toLowerCase()}:`;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseExternalId(v: unknown): string {
  if (typeof v !== 'string' || !GUID_RE.test(v.trim())) {
    throw bad('externalId must be the Microsoft Entra objectId. In the enterprise app\'s attribute mappings, map objectId to externalId.');
  }
  return v.trim().toLowerCase();
}

function parseUserName(v: unknown): string {
  if (typeof v !== 'string') throw bad('userName is required.');
  const value = v.trim();
  if (value.length > MAX_USER_NAME || !ADDRESS_RE.test(value)) throw bad('userName must be an address such as the user principal name.');
  return value;
}

function parseActive(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const lower = v.trim().toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
  }
  throw bad('active must be true or false.');
}

function parseNamePart(v: unknown, attribute: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw bad(`${attribute} must be a string.`);
  const value = v.trim();
  if (value.length > MAX_NAME_PART) throw bad(`${attribute} is too long.`);
  return value.length > 0 ? value : null;
}

/** `urn:…:core:2.0:User:name.givenName` / `NAME.GIVENNAME` → `name.givenname`. */
function normalizePath(path: string): string {
  const lower = path.trim().toLowerCase();
  return lower.startsWith(CORE_PREFIX) ? lower.slice(CORE_PREFIX.length) : lower;
}

function parseFullBody(body: unknown): ScimReplaceAttrs {
  if (!isRecord(body)) throw bad('The request body must be a SCIM User.', 'invalidSyntax');
  const name = isRecord(body.name) ? body.name : {};
  return {
    externalId: parseExternalId(body.externalId),
    userName: parseUserName(body.userName),
    ...(body.active === undefined ? {} : { active: parseActive(body.active) }),
    displayName: parseNamePart(body.displayName, 'displayName'),
    givenName: parseNamePart(name.givenName, 'name.givenName'),
    familyName: parseNamePart(name.familyName, 'name.familyName'),
  };
}

/** POST /Users (D4). `active` defaults to true. */
export function parseCreateBody(body: unknown): ScimUserAttrs {
  const parsed = parseFullBody(body);
  return { ...parsed, active: parsed.active ?? true };
}

/** PUT /Users/:id (D8): omitted name parts clear; an omitted `active` is unchanged. */
export function parsePutBody(body: unknown): ScimReplaceAttrs {
  return parseFullBody(body);
}

/**
 * Apply one attribute of a PATCH to `out`. Unknown attributes (emails,
 * extensions, title, filtered paths, `name.formatted`, …) are ignored.
 */
function applyAttribute(out: ScimUserPatch, op: 'add' | 'replace' | 'remove', path: string, value: unknown): void {
  switch (normalizePath(path)) {
    case 'active':
      if (op === 'remove') throw bad('active cannot be removed.', 'mutability');
      out.active = parseActive(value);
      return;
    case 'username':
      if (op === 'remove') throw bad('userName cannot be removed.', 'mutability');
      out.userName = parseUserName(value);
      return;
    case 'externalid':
      if (op === 'remove') throw bad('externalId cannot be removed.', 'mutability');
      out.externalId = parseExternalId(value);
      return;
    case 'displayname':
      out.displayName = op === 'remove' ? null : parseNamePart(value, 'displayName');
      return;
    case 'name.givenname':
      out.givenName = op === 'remove' ? null : parseNamePart(value, 'name.givenName');
      return;
    case 'name.familyname':
      out.familyName = op === 'remove' ? null : parseNamePart(value, 'name.familyName');
      return;
    case 'name':
      if (op === 'remove') {
        out.givenName = null;
        out.familyName = null;
        return;
      }
      if (!isRecord(value)) throw bad('name must be an object.');
      for (const [key, part] of Object.entries(value)) applyAttribute(out, op, `name.${key}`, part);
      return;
    default:
      // Not managed by this service: accepted and ignored.
  }
}

/**
 * PATCH /Users/:id (D8): `add` / `replace` / `remove`, case-insensitive. The
 * whole operation list is validated before the caller writes anything (RFC
 * 7644 §3.5.2: a PATCH is atomic), so a bad op anywhere refuses the request.
 */
export function parsePatchBody(body: unknown): ScimUserPatch {
  if (!isRecord(body) || !Array.isArray(body.Operations)) {
    throw bad('A PATCH must carry an Operations array.', 'invalidSyntax');
  }
  const out: ScimUserPatch = {};
  for (const raw of body.Operations) {
    if (!isRecord(raw)) throw bad('Each operation must be an object.', 'invalidSyntax');
    const op = typeof raw.op === 'string' ? raw.op.trim().toLowerCase() : '';
    if (op !== 'add' && op !== 'replace' && op !== 'remove') throw bad(`Unsupported operation "${String(raw.op)}".`, 'invalidSyntax');
    const path = typeof raw.path === 'string' && raw.path.trim().length > 0 ? raw.path : null;
    if (path) {
      applyAttribute(out, op, path, raw.value);
      continue;
    }
    if (op === 'remove') throw bad('remove needs a path.', 'noTarget');
    if (!isRecord(raw.value)) throw bad('An operation without a path needs an object value.', 'invalidSyntax');
    for (const [key, value] of Object.entries(raw.value)) applyAttribute(out, op, key, value);
  }
  return out;
}

const FILTER_RE = /^\s*(?:urn:ietf:params:scim:schemas:core:2\.0:user:)?(username|externalid)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i;

/**
 * `GET /Users?filter=` (D8): `userName eq "…"` or `externalId eq "…"` only.
 * The value is not validated: Test Connection sends a random GUID through the
 * configured matching attribute and expects an empty list.
 */
export function parseScimFilter(filter: string): { attribute: 'userName' | 'externalId'; value: string } {
  const m = FILTER_RE.exec(filter);
  if (!m) throw bad('Only userName eq "…" and externalId eq "…" filters are supported.', 'invalidFilter');
  return {
    attribute: m[1]!.toLowerCase() === 'username' ? 'userName' : 'externalId',
    value: m[2]!.replace(/\\(.)/g, '$1'),
  };
}

/** Upper bound for startIndex so a hostile value can never overflow the SQL OFFSET. */
export const SCIM_MAX_START_INDEX = 1_000_000;

export function parseListParams(query: { startIndex?: string; count?: string }): { startIndex: number; count: number } {
  const start = Number.parseInt(query.startIndex ?? '', 10);
  const count = Number.parseInt(query.count ?? '', 10);
  return {
    startIndex: Number.isFinite(start) && start >= 1 ? Math.min(start, SCIM_MAX_START_INDEX) : 1,
    count: Number.isFinite(count) ? Math.min(Math.max(count, 0), SCIM_MAX_PAGE) : SCIM_MAX_PAGE,
  };
}

export interface ScimUserRecord {
  id: string;
  externalId: string;
  userName: string;
  active: boolean;
  displayName: string | null;
  givenName: string | null;
  familyName: string | null;
  created: Date;
}

export function toScimUser(r: ScimUserRecord) {
  const name = {
    ...(r.givenName ? { givenName: r.givenName } : {}),
    ...(r.familyName ? { familyName: r.familyName } : {}),
  };
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: r.id,
    externalId: r.externalId,
    userName: r.userName,
    active: r.active,
    ...(r.displayName ? { displayName: r.displayName } : {}),
    ...(Object.keys(name).length > 0 ? { name } : {}),
    meta: { resourceType: 'User', created: r.created.toISOString() },
  };
}

export function scimListResponse(resources: unknown[], totalResults: number, startIndex: number) {
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

/** The portal account's display name from the SCIM name parts (D5), or null to leave it. */
export function portalNameFrom(attrs: Pick<ScimUserAttrs, 'displayName' | 'givenName' | 'familyName'>): string | null {
  if (attrs.displayName) return attrs.displayName;
  const joined = [attrs.givenName, attrs.familyName].filter(Boolean).join(' ').trim();
  return joined.length > 0 ? joined : null;
}
