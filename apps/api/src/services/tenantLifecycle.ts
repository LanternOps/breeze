import { and, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext, type Database } from '../db';
import { apiKeys, devices, enrollmentKeys, organizationUsers, organizations, partnerUsers } from '../db/schema';
import { revokeAllOrgOauthArtifacts, revokeAllPartnerOauthArtifacts } from '../oauth/grantRevocation';
import { AGENT_TOKEN_SUSPEND_REASON } from './agentTokenSuspension';
import { clearPermissionCache } from './permissions';
import { invalidateAgentTenantCache } from './tenantStatus';
import { revokeAllUserTokens } from './tokenRevocation';
import {
  advanceUserSecurityState,
  revokeAllUserSessionFamilies,
  type AuthLifecycleTransaction,
} from './authLifecycle';
import { runPostCommitCleanup } from './postCommitCleanup';
import {
  invalidateLockedPartnerUsersInTransaction,
  lockPartnerLifecycleRows,
  type LockedPartnerLifecycleRows,
} from './partnerLifecycleLock';

export interface TenantRevocationResult {
  apiKeysRevoked: number;
  userSessionsRevoked: number;
  oauthGrantsRevoked: number;
  oauthRefreshTokensRevoked: number;
  agentTokensSuspended: number;
  enrollmentKeysInvalidated: number;
  cleanupStatus: 'complete' | 'partial';
  cleanupFailures: string[];
}

export interface TenantRestorationResult {
  agentTokensRestored: number;
}

export interface OrganizationLifecycleSnapshot {
  userIds: string[];
}

export interface PartnerLifecycleSnapshot extends OrganizationLifecycleSnapshot {
  orgIds: string[];
}

// Reason tag written to devices.agentTokenSuspendedReason when a tenant is
// suspended/deleted. The reactivation path clears ONLY suspensions carrying
// this tag, so a cross-tenant-probe suspension (AGENT_TOKEN_SUSPEND_REASON
// .crossTenantProbe, set by recordCrossTenantDrop in agentWs.ts) is never
// silently lifted by restoring a tenant.
const TENANT_SUSPENDED_TOKEN_REASON = AGENT_TOKEN_SUSPEND_REASON.tenantSuspended;

/**
 * Sever the live agent fleet for a set of orgs: suspend agent tokens (so the
 * agent REST + WS auth gates fail closed immediately — ahead of the cached
 * tenant cascade) and expire enrollment keys (so a still-valid key can't
 * re-mint a fleet). This is the credential-cutoff half of suspend-for-abuse.
 *
 * We deliberately do NOT queue `self_uninstall` here: a status change may be
 * reversible (e.g. a billing suspension), and self_uninstall is both
 * irreversible and — once the auth gate has locked the agent out — undeliverable.
 * Only devices that are not already suspended are touched, so this never
 * clobbers an existing probe-suspension's reason.
 */
async function severAgentCredentialsForOrgIds(
  orgIds: string[]
): Promise<{ agentTokensSuspended: number; enrollmentKeysInvalidated: number }> {
  if (orgIds.length === 0) {
    return { agentTokensSuspended: 0, enrollmentKeysInvalidated: 0 };
  }

  // Drop any cached positive tenant-status result first, so a concurrent agent
  // request that hasn't yet seen the device-level suspension flag re-checks the
  // (already-written) inactive DB status instead of a stale `OK`.
  await invalidateAgentTenantCache(orgIds);

  const now = new Date();

  const suspended = await db
    .update(devices)
    .set({ agentTokenSuspendedAt: now, agentTokenSuspendedReason: TENANT_SUSPENDED_TOKEN_REASON })
    .where(and(inArray(devices.orgId, orgIds), isNull(devices.agentTokenSuspendedAt)))
    .returning({ id: devices.id });

  // Expire enrollment keys after the cache drop + token suspension. Safe
  // ordering because the enroll path checks getActiveOrgTenant directly
  // (uncached, see enrollment.ts), so it never admits via a stale positive
  // cache during this window; only keys not already expired are touched.
  const invalidatedKeys = await db
    .update(enrollmentKeys)
    .set({ expiresAt: now })
    .where(
      and(
        inArray(enrollmentKeys.orgId, orgIds),
        or(isNull(enrollmentKeys.expiresAt), gt(enrollmentKeys.expiresAt, now))
      )
    )
    .returning({ id: enrollmentKeys.id });

  return {
    agentTokensSuspended: suspended.length,
    enrollmentKeysInvalidated: invalidatedKeys.length,
  };
}

/**
 * Reverse the reversible half of severAgentCredentialsForOrgIds: clear the
 * agent-token suspensions WE applied (reason-tagged), leaving cross-tenant
 * probe suspensions intact. Expired enrollment keys are NOT un-expired —
 * operators regenerate keys; silently reviving an arbitrarily old key would be
 * wrong.
 */
async function restoreAgentCredentialsForOrgIds(orgIds: string[]): Promise<TenantRestorationResult> {
  if (orgIds.length === 0) return { agentTokensRestored: 0 };

  const restored = await db
    .update(devices)
    .set({ agentTokenSuspendedAt: null, agentTokenSuspendedReason: null })
    .where(
      and(
        inArray(devices.orgId, orgIds),
        eq(devices.agentTokenSuspendedReason, TENANT_SUSPENDED_TOKEN_REASON)
      )
    )
    .returning({ id: devices.id });

  return { agentTokensRestored: restored.length };
}

async function revokeApiKeysForOrgIds(orgIds: string[]): Promise<number> {
  if (orgIds.length === 0) return 0;
  const rows = await db
    .update(apiKeys)
    .set({ status: 'revoked', updatedAt: new Date() })
    .where(inArray(apiKeys.orgId, orgIds))
    .returning({ id: apiKeys.id });
  return rows.length;
}

async function revokeUsers(userIds: string[]): Promise<{
  count: number;
  cleanupStatus: 'complete' | 'partial';
  cleanupFailures: string[];
}> {
  const uniqueUserIds = [...new Set(userIds)];
  const cleanup = await runPostCommitCleanup(uniqueUserIds.flatMap((userId) => [
    { name: `user-tokens:${userId}`, run: () => revokeAllUserTokens(userId) },
    { name: `permission-cache:${userId}`, run: () => clearPermissionCache(userId) },
  ]));
  return {
    count: uniqueUserIds.length,
    cleanupStatus: cleanup.cleanupStatus,
    cleanupFailures: cleanup.cleanupFailures,
  };
}

export type TenantLifecycleTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

async function revokeUsersDurably(
  tx: TenantLifecycleTransaction,
  userIds: string[],
  reason: string,
): Promise<string[]> {
  const uniqueUserIds = [...new Set(userIds)];
  const authTx = tx as unknown as AuthLifecycleTransaction;
  for (const userId of uniqueUserIds) {
    await advanceUserSecurityState(authTx, userId);
    await revokeAllUserSessionFamilies(authTx, userId, reason);
  }
  return uniqueUserIds;
}

export async function invalidateOrganizationUsersInTransaction(
  tx: TenantLifecycleTransaction,
  orgId: string,
  reason: string,
): Promise<string[]> {
  const memberships = await tx
    .select({ userId: organizationUsers.userId })
    .from(organizationUsers)
    .where(eq(organizationUsers.orgId, orgId));
  return revokeUsersDurably(tx, memberships.map((row) => row.userId), reason);
}

export async function invalidatePartnerUsersInTransaction(
  tx: TenantLifecycleTransaction,
  partnerId: string,
  reason: string,
  prelocked?: LockedPartnerLifecycleRows,
): Promise<{ orgIds: string[]; userIds: string[] }> {
  const locked = prelocked ?? await lockPartnerLifecycleRows(
    tx as unknown as AuthLifecycleTransaction,
    partnerId,
  );
  const userIds = await invalidateLockedPartnerUsersInTransaction(
    tx as unknown as AuthLifecycleTransaction,
    locked,
    reason,
  );
  return { orgIds: locked.orgIds, userIds };
}

export async function revokeOrganizationTenantAccess(
  orgId: string,
  snapshot?: OrganizationLifecycleSnapshot,
): Promise<TenantRevocationResult> {
  const userIds = snapshot?.userIds ?? await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const orgUsers = await db
        .select({ userId: organizationUsers.userId })
        .from(organizationUsers)
        .where(eq(organizationUsers.orgId, orgId));
      return [...new Set(orgUsers.map((row) => row.userId))];
    })
  );
  let apiKeysRevoked = 0;
  let agentSeverance = { agentTokensSuspended: 0, enrollmentKeysInvalidated: 0 };
  let oauth = { grantsRevoked: 0, refreshTokensRevoked: 0 };
  const credentialCleanup = await runPostCommitCleanup([{
    name: 'tenant-credentials',
    run: async () => {
      [apiKeysRevoked, agentSeverance] = await runOutsideDbContext(() =>
        withSystemDbAccessContext(() => Promise.all([
          revokeApiKeysForOrgIds([orgId]),
          severAgentCredentialsForOrgIds([orgId]),
        ])),
      );
    },
  }]);
  const [userCleanup, oauthCleanup] = await Promise.all([
    revokeUsers(userIds),
    runPostCommitCleanup([{
      name: 'oauth',
      run: async () => { oauth = await revokeAllOrgOauthArtifacts(orgId); },
    }]),
  ]);
  const cleanupFailures = [
    ...credentialCleanup.cleanupFailures,
    ...userCleanup.cleanupFailures,
    ...oauthCleanup.cleanupFailures,
  ];
  return {
    apiKeysRevoked,
    userSessionsRevoked: userCleanup.count,
    oauthGrantsRevoked: oauth.grantsRevoked,
    oauthRefreshTokensRevoked: oauth.refreshTokensRevoked,
    agentTokensSuspended: agentSeverance.agentTokensSuspended,
    enrollmentKeysInvalidated: agentSeverance.enrollmentKeysInvalidated,
    cleanupStatus: cleanupFailures.length === 0 ? 'complete' : 'partial',
    cleanupFailures,
  };
}

export async function revokePartnerTenantAccess(
  partnerId: string,
  snapshot?: PartnerLifecycleSnapshot,
): Promise<TenantRevocationResult> {
  const { orgIds, userIds } = snapshot ?? await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const orgRows = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.partnerId, partnerId));
      const orgIds = orgRows.map((row) => row.id);

      const partnerMemberships = await db
        .select({ userId: partnerUsers.userId })
        .from(partnerUsers)
        .where(eq(partnerUsers.partnerId, partnerId));

      const orgMemberships = orgIds.length === 0
        ? []
        : await db
          .select({ userId: organizationUsers.userId })
          .from(organizationUsers)
          .where(inArray(organizationUsers.orgId, orgIds));

      const userIds = [...new Set([
          ...partnerMemberships.map((row) => row.userId),
          ...orgMemberships.map((row) => row.userId),
        ])];
      return { orgIds, userIds };
    })
  );
  let apiKeysRevoked = 0;
  let agentSeverance = { agentTokensSuspended: 0, enrollmentKeysInvalidated: 0 };
  let oauth = { grantsRevoked: 0, refreshTokensRevoked: 0 };
  const credentialCleanup = await runPostCommitCleanup([{
    name: 'tenant-credentials',
    run: async () => {
      [apiKeysRevoked, agentSeverance] = await runOutsideDbContext(() =>
        withSystemDbAccessContext(() => Promise.all([
          revokeApiKeysForOrgIds(orgIds),
          severAgentCredentialsForOrgIds(orgIds),
        ])),
      );
    },
  }]);
  const [userCleanup, oauthCleanup] = await Promise.all([
    revokeUsers(userIds),
    runPostCommitCleanup([{
      name: 'oauth',
      run: async () => { oauth = await revokeAllPartnerOauthArtifacts(partnerId); },
    }]),
  ]);
  const cleanupFailures = [
    ...credentialCleanup.cleanupFailures,
    ...userCleanup.cleanupFailures,
    ...oauthCleanup.cleanupFailures,
  ];
  return {
    apiKeysRevoked,
    userSessionsRevoked: userCleanup.count,
    oauthGrantsRevoked: oauth.grantsRevoked,
    oauthRefreshTokensRevoked: oauth.refreshTokensRevoked,
    agentTokensSuspended: agentSeverance.agentTokensSuspended,
    enrollmentKeysInvalidated: agentSeverance.enrollmentKeysInvalidated,
    cleanupStatus: cleanupFailures.length === 0 ? 'complete' : 'partial',
    cleanupFailures,
  };
}

/**
 * Reactivation counterpart to revokeOrganizationTenantAccess. Restores agent
 * tokens this module suspended (reason-tagged) when an org returns to an
 * active/trial status. User JWTs and API keys are intentionally NOT restored:
 * JWTs are re-issued on next login, and revoked API keys must be re-created by
 * an operator — neither is auto-restored, matching the one-way revoke
 * semantics for first-party credentials.
 */
export async function restoreOrganizationTenantAccess(orgId: string): Promise<TenantRestorationResult> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() => restoreAgentCredentialsForOrgIds([orgId]))
  );
}

/**
 * Reactivation counterpart to revokePartnerTenantAccess: restore reason-tagged
 * agent-token suspensions across every org under the partner.
 */
export async function restorePartnerTenantAccess(partnerId: string): Promise<TenantRestorationResult> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const orgRows = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.partnerId, partnerId));
      return restoreAgentCredentialsForOrgIds(orgRows.map((row) => row.id));
    })
  );
}
