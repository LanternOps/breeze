import { randomBytes, createHash } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { apiKeys, servicePrincipals } from '../db/schema';
import { createAuditLogAsync } from './auditService';

/**
 * SR2-15: service-principal lifecycle service.
 *
 * A service principal is an explicit, opt-in, org-owned non-human identity
 * (`service_principals`). It exists so automation owned by an off-boarded
 * human can be migrated onto a first-class identity instead of silently
 * surviving on a dead human's live permissions (the human-key path in
 * `apiKeyAuthorization.ts` denies once the creator loses membership — a
 * service principal is the deliberate, audited escape hatch when the
 * automation itself is meant to keep running).
 *
 * Every mutation here runs inside the caller's already-established request
 * DB context (routes/servicePrincipals.ts is mounted behind `authMiddleware`,
 * which opens `withDbAccessContext` for the whole dispatch) — these functions
 * do not open their own DB context.
 */

export type ServicePrincipal = typeof servicePrincipals.$inferSelect;
export type ServicePrincipalApiKey = typeof apiKeys.$inferSelect;

export class ServicePrincipalNotFoundError extends Error {
  constructor(principalId: string) {
    super(`Service principal not found: ${principalId}`);
    this.name = 'ServicePrincipalNotFoundError';
  }
}

export class ApiKeyNotFoundError extends Error {
  constructor(keyId: string) {
    super(`API key not found: ${keyId}`);
    this.name = 'ApiKeyNotFoundError';
  }
}

// Mirrors routes/apiKeys.ts's generateApiKey (identical brz_-prefix + SHA-256
// hash scheme). Duplicated locally rather than cross-imported from a route
// file — the same duplication already exists between routes/apiKeys.ts and
// middleware/apiKeyAuth.ts for hashApiKey, so this matches established
// convention for this exact helper rather than introducing a new shared
// module or a service→route import.
function generateApiKey(): { fullKey: string; keyPrefix: string; keyHash: string } {
  const randomPart = randomBytes(32).toString('base64url').slice(0, 32);
  const fullKey = `brz_${randomPart}`;
  const keyPrefix = fullKey.slice(0, 12);
  const keyHash = createHash('sha256').update(fullKey).digest('hex');
  return { fullKey, keyPrefix, keyHash };
}

export async function createServicePrincipal(input: {
  orgId: string;
  name: string;
  scopes: string[];
  createdBy: string;
}): Promise<ServicePrincipal> {
  const [row] = await db
    .insert(servicePrincipals)
    .values({
      orgId: input.orgId,
      name: input.name,
      scopes: input.scopes,
      status: 'active',
      createdBy: input.createdBy,
    })
    .returning();

  if (!row) {
    throw new Error('Failed to create service principal');
  }

  createAuditLogAsync({
    orgId: row.orgId,
    actorId: input.createdBy,
    action: 'service_principal.create',
    resourceType: 'service_principal',
    resourceId: row.id,
    resourceName: row.name,
    details: { scopes: row.scopes },
    result: 'success',
  });

  return row;
}

/**
 * Mint a NEW api_keys row bound to `principalId` (principalType='service')
 * and revoke any prior ACTIVE key for that principal. Returns the raw key
 * exactly once — same "shown only on mint/rotate" contract as
 * routes/apiKeys.ts. The revoke-then-mint ordering means there is never a
 * window where two keys are simultaneously active for one principal.
 */
export async function rotateServicePrincipalKey(
  principalId: string,
  actorId: string,
): Promise<{ apiKeyId: string; key: string; keyPrefix: string }> {
  const [principal] = await db
    .select()
    .from(servicePrincipals)
    .where(eq(servicePrincipals.id, principalId))
    .limit(1);

  if (!principal) {
    throw new ServicePrincipalNotFoundError(principalId);
  }

  await db
    .update(apiKeys)
    .set({ status: 'revoked', updatedAt: new Date() })
    .where(and(eq(apiKeys.principalId, principalId), eq(apiKeys.status, 'active')));

  const { fullKey, keyPrefix, keyHash } = generateApiKey();

  const [newKey] = await db
    .insert(apiKeys)
    .values({
      orgId: principal.orgId,
      name: `${principal.name} (service key)`,
      keyHash,
      keyPrefix,
      scopes: principal.scopes,
      createdBy: actorId,
      status: 'active',
      principalType: 'service',
      principalId: principal.id,
    })
    .returning();

  if (!newKey) {
    throw new Error('Failed to mint service principal key');
  }

  createAuditLogAsync({
    orgId: principal.orgId,
    actorId,
    action: 'service_principal.rotate_key',
    resourceType: 'service_principal',
    resourceId: principal.id,
    resourceName: principal.name,
    // NEVER log the raw key or its hash — prefix only.
    details: { newKeyId: newKey.id, newKeyPrefix: newKey.keyPrefix },
    result: 'success',
  });

  return { apiKeyId: newKey.id, key: fullKey, keyPrefix: newKey.keyPrefix };
}

/**
 * Disable a principal (status='disabled') and cascade-revoke every active
 * key bound to it. This is the disable-cascade gate that
 * `authorizeServicePrincipalKey` relies on: a disabled principal denies at
 * auth time regardless, but revoking the keys here means a re-enable (were
 * one ever added) never silently resurrects old credentials.
 */
export async function disableServicePrincipal(
  principalId: string,
  actorId: string,
): Promise<ServicePrincipal> {
  const [updated] = await db
    .update(servicePrincipals)
    .set({ status: 'disabled', updatedAt: new Date(), lastUpdatedBy: actorId })
    .where(eq(servicePrincipals.id, principalId))
    .returning();

  if (!updated) {
    throw new ServicePrincipalNotFoundError(principalId);
  }

  await db
    .update(apiKeys)
    .set({ status: 'revoked', updatedAt: new Date() })
    .where(and(eq(apiKeys.principalId, principalId), eq(apiKeys.status, 'active')));

  createAuditLogAsync({
    orgId: updated.orgId,
    actorId,
    action: 'service_principal.disable',
    resourceType: 'service_principal',
    resourceId: updated.id,
    resourceName: updated.name,
    result: 'success',
  });

  return updated;
}

/**
 * Re-point an EXISTING human `api_keys` row onto an explicit service
 * principal — flipping `principal_type` from 'human' to 'service' and
 * setting `principal_id`. This is the ONLY mutation in the codebase that
 * flips principal_type; it is deliberately never automatic (see the module
 * docstring) and is gated at the route layer on an org-admin permission —
 * never reachable from the auth path itself.
 *
 * The key's stored scopes are re-clamped to the INTERSECTION with the
 * principal's current scopes: migrating a key that was minted with broader
 * human-delegated scopes must not hand the principal authority it was never
 * explicitly granted. (`authorizeServicePrincipalKey` would reject the
 * un-intersected scopes on the very next request anyway — clamping here
 * avoids leaving the key transiently broken.)
 */
export async function migrateHumanKeyToServicePrincipal(
  keyId: string,
  principalId: string,
  actorId: string,
): Promise<ServicePrincipalApiKey> {
  const [principal] = await db
    .select()
    .from(servicePrincipals)
    .where(eq(servicePrincipals.id, principalId))
    .limit(1);

  if (!principal) {
    throw new ServicePrincipalNotFoundError(principalId);
  }

  const [existingKey] = await db.select().from(apiKeys).where(eq(apiKeys.id, keyId)).limit(1);

  if (!existingKey) {
    throw new ApiKeyNotFoundError(keyId);
  }

  if (existingKey.orgId !== principal.orgId) {
    throw new Error('Cannot migrate an API key to a service principal in a different organization');
  }

  const principalScopeSet = new Set(principal.scopes ?? []);
  const clampedScopes = (existingKey.scopes ?? []).filter((scope) => principalScopeSet.has(scope));

  const [migrated] = await db
    .update(apiKeys)
    .set({
      principalType: 'service',
      principalId: principal.id,
      scopes: clampedScopes,
      updatedAt: new Date(),
    })
    .where(eq(apiKeys.id, keyId))
    .returning();

  if (!migrated) {
    throw new Error('Failed to migrate API key to service principal');
  }

  createAuditLogAsync({
    orgId: migrated.orgId,
    actorId,
    action: 'service_principal.migrate_key',
    resourceType: 'api_key',
    resourceId: migrated.id,
    resourceName: migrated.name,
    details: {
      principalId: principal.id,
      previousPrincipalType: existingKey.principalType,
      clampedScopes,
    },
    result: 'success',
  });

  return migrated;
}
