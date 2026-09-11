import type { AuthContext } from '../middleware/auth';
import { PERMISSIONS, getUserPermissions, hasPermission, type UserPermissions } from './permissions';
import type { ContractActor } from './contractTypes';

/**
 * The permissions a `ContractActor` may carry as evidence.
 *
 * `ContractActor.permissions` is documented FAIL-CLOSED BY CONSTRUCTION: a caller
 * that cannot prove a permission passes nothing and is denied. That contract only
 * holds if every producer populates the set from a REAL permission resolution —
 * a hard-coded set forges the evidence and silently converts the fail-closed
 * design into fail-open for whichever permission was forged.
 */
export const CONTRACT_ACTOR_PERMISSIONS = [
  PERMISSIONS.CONTRACTS_READ, PERMISSIONS.CONTRACTS_WRITE, PERMISSIONS.CONTRACTS_MANAGE,
] as const;

/** Project a resolved permission set onto the contract-actor evidence strings. */
export function contractActorPermissionEvidence(
  userPerms: UserPermissions | null | undefined,
): Set<string> {
  const granted = new Set<string>();
  if (!userPerms) return granted;
  for (const p of CONTRACT_ACTOR_PERMISSIONS) {
    if (hasPermission(userPerms, p.resource, p.action)) granted.add(`${p.resource}:${p.action}`);
  }
  return granted;
}

/**
 * Build a `ContractActor` for a NON-HTTP caller (AI/MCP tools), which has no
 * request-scoped `permissions` context to read.
 *
 * HTTP routes use `contractActorFrom()`, which reads the permissions the auth
 * middleware already resolved. AI tool handlers only receive an `AuthContext`,
 * so they must resolve the caller's permissions themselves rather than assume
 * them — see SEC-2026-09-05-145.
 */
export async function resolveContractActorFromAuth(auth: AuthContext): Promise<ContractActor> {
  const userPerms = auth.user.id
    ? await getUserPermissions(auth.user.id, {
        orgId: auth.orgId ?? undefined,
        partnerId: auth.partnerId ?? undefined,
      })
    : null;
  return {
    userId: auth.user.id,
    partnerId: auth.partnerId ?? null,
    accessibleOrgIds: auth.accessibleOrgIds,
    permissions: contractActorPermissionEvidence(userPerms),
  };
}
