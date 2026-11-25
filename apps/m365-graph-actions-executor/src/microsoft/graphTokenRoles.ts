import type { OpaqueAccessToken } from './tokenClient';

/**
 * Fallback grant source for Admin actions (#12085): the `roles` claim of the
 * app-only Microsoft Graph token this executor acquired itself.
 *
 * Used ONLY when Graph denies a read that needs Application.Read.All — a
 * permission the Admin actions set does not carry:
 * - the inventory read (`/servicePrincipals/{id}/appRoleAssignments`): the
 *   roles are the grant source (`graph_token_only`);
 * - the first resource lookup (`/servicePrincipals/{resourceId}`) after a
 *   readable inventory: the roles must equal the manifest names of the
 *   assigned role ids (resourceRoleCrossCheck.ts).
 *
 * Why decoding without verifying the signature is sound here:
 * - The token never comes from a caller. `tokenClient.acquireGraphAppToken`
 *   fetched it from the tenant-specific Microsoft token endpoint over TLS
 *   (`redirect: 'error'`), authenticated with our certificate assertion, a
 *   moment earlier in the same retest. Nothing between Microsoft and us can
 *   substitute it, so there is no forgery to defend against.
 * - Graph has already accepted the same token for the organization and
 *   own-service-principal reads in this probe.
 * - Microsoft documents that only the resource (Graph) validates a Graph
 *   access token; third parties are told not to. A local signature check
 *   would add failure modes, not trust.
 *
 * What it does NOT prove, and why the mode is reported separately: a Graph
 * token only lists Graph app roles. App roles on other resources (Exchange
 * Online, SharePoint, …) are invisible here, so extra grants there cannot be
 * detected. Callers surface this as `graph_token_only`.
 *
 * Microsoft documents access tokens as opaque to clients; their format can
 * change (for example to an encrypted token). Every decode or claim failure
 * throws, and the caller treats that as "reconciliation unavailable" — the
 * fail-closed outcome that keeps writes blocked.
 */

const GRAPH_AUDIENCES: ReadonlySet<string> = new Set([
  'https://graph.microsoft.com',
  'https://graph.microsoft.com/',
  '00000003-0000-0000-c000-000000000000',
]);
const MAX_TOKEN_LENGTH = 16 * 1024;
const MAX_ROLE_COUNT = 1_000;
// Graph application permission values: letters, digits, dot, hyphen, underscore.
const ROLE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export class GraphTokenClaimsError extends Error {
  readonly code = 'graph_token_claims_invalid' as const;
  constructor() {
    super('graph_token_claims_invalid');
    this.name = 'GraphTokenClaimsError';
  }
}

function invalid(): never {
  throw new GraphTokenClaimsError();
}

function decodePayload(token: string): Record<string, unknown> {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) invalid();
  const segments = token.split('.');
  // Exactly a JWS compact serialization; a five-segment JWE is not readable.
  if (segments.length !== 3) invalid();
  const payload = segments[1]!;
  if (!BASE64URL.test(payload)) invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    invalid();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
  return parsed as Record<string, unknown>;
}

/**
 * Returns the sorted, de-duplicated Graph application role values the token
 * carries, after checking it is an unexpired app-only Graph token for exactly
 * `tenantId` and `clientId`. Throws `GraphTokenClaimsError` otherwise; the
 * error carries no claim or token material.
 */
export function graphApplicationRolesFromToken(
  token: OpaqueAccessToken,
  expected: { tenantId: string; clientId: string; now: Date },
): string[] {
  const claims = decodePayload(token);

  if (typeof claims.aud !== 'string' || !GRAPH_AUDIENCES.has(claims.aud)) invalid();
  if (claims.tid !== expected.tenantId) invalid();

  // v1 Graph tokens carry `appid`, v2 tokens `azp`. At least one must be
  // present and every one present must name this executor's application.
  const clientClaims = [claims.appid, claims.azp].filter((value) => value !== undefined);
  if (clientClaims.length === 0 || clientClaims.some((value) => value !== expected.clientId)) invalid();

  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) invalid();
  if (claims.exp * 1000 <= expected.now.getTime()) invalid();

  // App-only, never delegated: `idtyp` is optional, but when present must be
  // `app`; a delegated token carries `scp`.
  if (claims.idtyp !== undefined && claims.idtyp !== 'app') invalid();
  if (claims.scp !== undefined) invalid();

  // Microsoft omits `roles` when the application holds no app roles.
  if (claims.roles === undefined) return [];
  if (!Array.isArray(claims.roles) || claims.roles.length > MAX_ROLE_COUNT) invalid();
  const roles = new Set<string>();
  for (const role of claims.roles) {
    if (typeof role !== 'string' || !ROLE_VALUE.test(role)) invalid();
    roles.add(role);
  }
  return [...roles].sort();
}
