/**
 * Shape checks shared by the portal OIDC stores (portal registration W4):
 * the flow state (./stateStore.ts) and the tenant proof-run links
 * (./proofRunStore.ts). One definition of "a GUID", "a sha256" and "a tenant
 * a proof can be pinned to", so the stores cannot drift apart.
 */

/** Microsoft's consumer (MSA) tenant: never an org's tenant, never a proof target. */
export const ENTRA_CONSUMER_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad';

/** The authority every user sign-in uses (structural guest refusal); only a proof run pins a tenant (D6). */
export const PORTAL_ENTRA_SIGN_IN_AUTHORITY = 'organizations';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A GUID in either case (Postgres uuids and our own ids). */
export function isGuid(value: unknown): value is string {
  return typeof value === 'string' && GUID.test(value);
}

/** A lowercase hex sha256 digest, as `createHash('sha256').digest('hex')` writes it. */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

/** A tenant a proof run can be pinned to: a LOWERCASE tenant GUID that is not the consumer tenant. */
export function isProvableEntraTenantId(value: unknown): value is string {
  return isGuid(value) && value === value.toLowerCase() && value !== ENTRA_CONSUMER_TENANT_ID;
}
