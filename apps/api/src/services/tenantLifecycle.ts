import { and, eq, gt, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { apiKeys, devices, enrollmentKeys, organizationUsers, organizations, partnerUsers } from '../db/schema';
import { revokeAllOrgOauthArtifacts, revokeAllPartnerOauthArtifacts } from '../oauth/grantRevocation';
import { AGENT_TOKEN_SUSPEND_REASON } from './agentTokenSuspension';
import { clearPermissionCache } from './permissions';
import { invalidateAgentTenantCache } from './tenantStatus';
import { revokeAllUserTokens } from './tokenRevocation';

export interface TenantRevocationResult {
  apiKeysRevoked: number;
  userSessionsRevoked: number;
  oauthGrantsRevoked: number;
  oauthRefreshTokensRevoked: number;
  agentTokensSuspended: number;
  enrollmentKeysInvalidated: number;
}

export interface TenantRestorationResult {
  agentTokensRestored: number;
}

// Reason tag written to devices.agentTokenSuspendedReason when a tenant is
// suspended/deleted. The reactivation path clears ONLY suspensions carrying
// this tag, so a cross-tenant-probe suspension (AGENT_TOKEN_SUSPEND_REASON
// .crossTenantProbe, set by recordCrossTenantDrop in agentWs.ts) is never
// silently lifted by restoring a tenant.
const TENANT_SUSPENDED_TOKEN_REASON = AGENT_TOKEN_SUSPEND_REASON.tenantSuspended;

/**
 * Expire enrollment keys for the orgs so a still-valid key can't (re-)mint a
 * fleet. Safe ordering relative to the cache drop because the enroll path
 * checks getActiveOrgTenant directly (uncached, see enrollment.ts), so it
 * never admits via a stale positive cache during this window; only keys not
 * already expired are touched.
 */
async function expireEnrollmentKeysForOrgIds(orgIds: string[], now: Date): Promise<number> {
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
  return invalidatedKeys.length;
}

/**
 * Finding #3(b): flipping status / suspending tokens only fails the NEXT auth
 * gate — an already-established agent WS keeps its captured authorization
 * until it happens to reconnect. Sever live sockets for devices in the
 * affected orgs so containment is immediate, not eventual.
 *
 * agentWs is imported dynamically (not statically): `routes/agentWs` pulls in
 * a large graph of services, and a static service→route edge here risks an
 * import cycle. Dynamic import at call time is the established de-cycling
 * pattern in this repo (agentWs itself dynamically imports its result
 * handlers). Best-effort: socket teardown must NEVER fail the credential
 * revocation, which is the load-bearing containment step.
 */
export async function disconnectLiveAgentSocketsForOrgIds(orgIds: string[], reason: string): Promise<void> {
  if (orgIds.length === 0) return;
  try {
    const { disconnectAgent, getConnectedAgentIds } = await import('../routes/agentWs');
    const connected = getConnectedAgentIds();
    if (connected.length > 0) {
      const connectedSet = new Set(connected);
      const deviceRows = await db
        .select({ agentId: devices.agentId })
        .from(devices)
        .where(and(inArray(devices.orgId, orgIds), isNotNull(devices.agentId)));
      for (const row of deviceRows) {
        if (row.agentId && connectedSet.has(row.agentId)) {
          disconnectAgent(row.agentId, 4001, reason);
        }
      }
    }
  } catch (err) {
    console.error('[tenantLifecycle] Failed to sever live agent sockets after credential cutoff:', err);
  }
}

/**
 * Sever the live agent fleet for a set of orgs: suspend agent tokens (so the
 * agent REST + WS auth gates fail closed immediately — ahead of the cached
 * tenant cascade) and expire enrollment keys (so a still-valid key can't
 * re-mint a fleet). This is the credential-cutoff half of suspend-for-abuse.
 *
 * We deliberately do NOT queue `self_uninstall` here: a status change may be
 * reversible (e.g. a billing suspension), and self_uninstall is both
 * irreversible and — once the auth gate has locked the agent out — undeliverable.
 * Deliverable remote uninstall goes through the `offboarding` drain state
 * (services/tenantOffboarding.ts, #2774), which keeps the agent gate open in
 * a narrowed mode and calls this only after the fleet drains or the window
 * closes. Exported for exactly that deferred-sever path.
 * Only devices that are not already suspended are touched, so this never
 * clobbers an existing probe-suspension's reason.
 */
export async function severAgentCredentialsForOrgIds(
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

  const enrollmentKeysInvalidated = await expireEnrollmentKeysForOrgIds(orgIds, now);

  await disconnectLiveAgentSocketsForOrgIds(orgIds, 'Tenant suspended');

  return {
    agentTokensSuspended: suspended.length,
    enrollmentKeysInvalidated,
  };
}

/**
 * Drain-mode counterpart of severAgentCredentialsForOrgIds (#2774): close the
 * fleet's ATTACK surface without closing its DELIVERY surface. Expires
 * enrollment keys (no new devices during a drain), drops the tenant cache (so
 * the agent gate re-reads the new `offboarding` status and starts narrowing
 * within the 60s cache TTL), and severs live WS sockets (the WS channel
 * carries desktop/terminal/tunnel pushes that bypass device_commands — a
 * draining tenant must not keep an interactive control channel). Agent tokens
 * are deliberately left untouched: they are the delivery path for the queued
 * self_uninstall.
 *
 * #2785: "left untouched" is not enough when the drain is entered from
 * `suspended`/`churned`, where an earlier sever already set
 * devices.agentTokenSuspendedAt. agentAuthMiddleware checks that column BEFORE
 * it consults the tenant state (agentAuth.ts: suspension 401 precedes the
 * getAgentTenantState drain narrowing), so those devices 401 on every poll for
 * the whole drain window and the queued self_uninstall is undeliverable by
 * construction — the exact failure #2774 exists to remove. So the drain also
 * LIFTS the suspensions it is superseding, reusing
 * restoreAgentCredentialsForOrgIds for its narrowness: scoped to these orgIds
 * and to reason=TENANT_SUSPENDED_TOKEN_REASON, so a cross-tenant-probe
 * suspension (or any other reason tag) survives the transition untouched.
 */
export async function prepareAgentDrainForOrgIds(
  orgIds: string[]
): Promise<{ enrollmentKeysInvalidated: number; agentTokensRestored: number }> {
  if (orgIds.length === 0) {
    return { enrollmentKeysInvalidated: 0, agentTokensRestored: 0 };
  }

  await invalidateAgentTenantCache(orgIds);
  const enrollmentKeysInvalidated = await expireEnrollmentKeysForOrgIds(orgIds, new Date());
  await disconnectLiveAgentSocketsForOrgIds(orgIds, 'Tenant offboarding');
  // Lift the superseded tenant-suspensions AFTER the socket sever, not before:
  // clearing the flag re-opens this fleet's auth gate, and a device that
  // reconnected between the restore and the sever sweep's device read would keep
  // a full WS control channel until the reaper's next re-sweep. Callers
  // (begin*Offboarding) await this whole function before queueDrainUninstalls,
  // so the unsuspend still lands before any self_uninstall is queued.
  const { agentTokensRestored } = await restoreAgentCredentialsForOrgIds(orgIds);
  if (agentTokensRestored > 0) {
    // Operationally load-bearing: this is the only signal that a drain was
    // entered from an already-severed state, i.e. the stranded-fleet case.
    console.warn(
      `[tenantLifecycle] drain entry lifted ${agentTokensRestored} superseded tenant-suspension(s) so the queued self_uninstall is deliverable`
    );
  }
  // Invalidate a SECOND time, after the teardown. In sever mode the cache is
  // only an optimization (agentTokenSuspendedAt is the real-time cutoff), but
  // in drain mode tokens stay alive, so this cache IS the gate: a read that
  // started before the status commit can land its positive `active` entry
  // after the first invalidation and keep the tenant fully capable — long
  // enough to win a WS upgrade — for the 60s TTL. Dropping it again once the
  // sockets are down closes the common ordering; the drain reaper's periodic
  // socket re-sweep bounds whatever still slips through.
  await invalidateAgentTenantCache(orgIds);

  return { enrollmentKeysInvalidated, agentTokensRestored };
}

/**
 * Reverse the reversible half of severAgentCredentialsForOrgIds: clear the
 * agent-token suspensions WE applied (reason-tagged), leaving cross-tenant
 * probe suspensions intact. Expired enrollment keys are NOT un-expired —
 * operators regenerate keys; silently reviving an arbitrarily old key would be
 * wrong.
 *
 * Two callers, both narrow by construction: reactivation
 * (restore{Organization,Partner}TenantAccess) and drain entry
 * (prepareAgentDrainForOrgIds, #2785). Both pass an explicit org-id list, and
 * the reason-tag equality is the second half of the guard — keep BOTH
 * predicates on any future edit, or a drain/reactivation would silently lift a
 * security-driven suspension.
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

async function revokeUsers(userIds: string[]): Promise<number> {
  const uniqueUserIds = [...new Set(userIds)];
  for (const userId of uniqueUserIds) {
    await revokeAllUserTokens(userId);
    await clearPermissionCache(userId);
  }
  return uniqueUserIds.length;
}

/**
 * `agentChannel` (#2774): 'sever' (default) suspends agent tokens immediately
 * — the abuse/suspension/deletion behavior. 'drain' keeps agent tokens alive
 * (narrowed by the `offboarding` tenant state) so a queued self_uninstall is
 * deliverable; enrollment keys still expire and live WS sockets still drop in
 * both modes.
 */
export interface TenantRevocationOptions {
  agentChannel?: 'sever' | 'drain';
}

export async function revokeOrganizationTenantAccess(
  orgId: string,
  options: TenantRevocationOptions = {}
): Promise<TenantRevocationResult> {
  const agentChannel = options.agentChannel ?? 'sever';
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const orgUsers = await db
        .select({ userId: organizationUsers.userId })
        .from(organizationUsers)
        .where(eq(organizationUsers.orgId, orgId));

      const [apiKeysRevoked, userSessionsRevoked, oauth, agentSeverance] = await Promise.all([
        revokeApiKeysForOrgIds([orgId]),
        revokeUsers(orgUsers.map((row) => row.userId)),
        revokeAllOrgOauthArtifacts(orgId),
        agentChannel === 'sever'
          ? severAgentCredentialsForOrgIds([orgId])
          : prepareAgentDrainForOrgIds([orgId]).then((drain) => ({
            agentTokensSuspended: 0,
            enrollmentKeysInvalidated: drain.enrollmentKeysInvalidated,
          })),
      ]);

      return {
        apiKeysRevoked,
        userSessionsRevoked,
        oauthGrantsRevoked: oauth.grantsRevoked,
        oauthRefreshTokensRevoked: oauth.refreshTokensRevoked,
        agentTokensSuspended: agentSeverance.agentTokensSuspended,
        enrollmentKeysInvalidated: agentSeverance.enrollmentKeysInvalidated,
      };
    })
  );
}

export async function revokePartnerTenantAccess(
  partnerId: string,
  options: TenantRevocationOptions = {}
): Promise<TenantRevocationResult> {
  const agentChannel = options.agentChannel ?? 'sever';
  return runOutsideDbContext(() =>
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

      const [apiKeysRevoked, userSessionsRevoked, oauth, agentSeverance] = await Promise.all([
        revokeApiKeysForOrgIds(orgIds),
        revokeUsers([
          ...partnerMemberships.map((row) => row.userId),
          ...orgMemberships.map((row) => row.userId),
        ]),
        revokeAllPartnerOauthArtifacts(partnerId),
        agentChannel === 'sever'
          ? severAgentCredentialsForOrgIds(orgIds)
          : prepareAgentDrainForOrgIds(orgIds).then((drain) => ({
            agentTokensSuspended: 0,
            enrollmentKeysInvalidated: drain.enrollmentKeysInvalidated,
          })),
      ]);

      return {
        apiKeysRevoked,
        userSessionsRevoked,
        oauthGrantsRevoked: oauth.grantsRevoked,
        oauthRefreshTokensRevoked: oauth.refreshTokensRevoked,
        agentTokensSuspended: agentSeverance.agentTokensSuspended,
        enrollmentKeysInvalidated: agentSeverance.enrollmentKeysInvalidated,
      };
    })
  );
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
