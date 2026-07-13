import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { authBrowserTransitions } from '../db/schema/authBrowserTransitions';
import {
  advanceUserSecurityState,
  lockTerminalLogoutAuthority,
  revokeAllUserSessionFamilies,
  revokeUserSessionFamily,
  withAuthLifecycleSystemTransaction,
  type TerminalLogoutAuthorityLocks,
} from './authLifecycle';
import { resolveAuthBinding, type AuthBindingSource } from './authBrowserTransition';
import { verifyToken, type TokenPayload } from './jwt';
import {
  cacheRefreshTokenFamilyRevocation,
  classifyRefreshTokenAuthority,
  revokeAllUserTokens,
  revokeRefreshTokenJti,
  type RefreshAuthority,
} from './tokenRevocation';
import { runPostCommitCleanup } from './postCommitCleanup';

const TERMINAL_LOGOUT_REASON = 'cf-access-terminal-logout';
const TERMINAL_LOGOUT_TTL_MINUTES = 10;

export type TerminalAccessAuthority = Readonly<{
  userId: string;
  familyId: string;
  authEpoch: number;
  mfaEpoch: number;
}>;

export type PrepareTerminalLogoutInput = Readonly<{
  binding: AuthBindingSource;
  access: TerminalAccessAuthority;
  refreshToken?: string | null;
}>;

export type PreparedTerminalLogout = Readonly<{
  transitionId: string;
  logoutId: string;
  generation: number;
  nonce: string;
  expiresAt: Date;
  subjectIds: readonly string[];
  advancedUserCount: number;
  revokedFamilyCount: number;
  cleanupStatus: 'complete' | 'partial';
  cleanupFailures: readonly string[];
}>;

type LockedTransition = {
  id: string;
  generation: number;
  state: 'active' | 'logout_pending' | 'retired';
  currentUserId: string | null;
  currentFamilyId: string | null;
};

function isRefreshPayload(payload: TokenPayload | null): payload is TokenPayload & {
  type: 'refresh';
  sub: string;
  fam: string;
  jti: string;
} {
  return payload?.type === 'refresh'
    && typeof payload.sub === 'string' && payload.sub.length > 0
    && typeof payload.fam === 'string' && payload.fam.length > 0
    && typeof payload.jti === 'string' && payload.jti.length > 0;
}

function isLiveAccessAuthority(
  access: TerminalAccessAuthority,
  locks: TerminalLogoutAuthorityLocks,
): boolean {
  const user = locks.users.get(access.userId);
  const family = locks.families.get(access.familyId);
  return user?.status === 'active'
    && user.authEpoch === access.authEpoch
    && user.mfaEpoch === access.mfaEpoch
    && family?.userId === access.userId
    && family.revokedAt === null
    && family.absoluteExpiresAt instanceof Date
    && Number.isFinite(family.absoluteExpiresAt.getTime())
    && family.absoluteExpiresAt.getTime() > locks.databaseNow.getTime();
}

function ownerOfClassifiedFamily(
  authority: RefreshAuthority,
  locks: TerminalLogoutAuthorityLocks,
): string | null {
  if (authority.kind !== 'legacy_or_stale_family') return null;
  return locks.families.get(authority.familyId)?.userId ?? null;
}

/**
 * Linearize terminal logout against every issuer on one PostgreSQL transition
 * row. Redis work is deliberately post-commit and can only accelerate the
 * durable epoch/family state established here.
 */
export async function prepareTerminalLogout(
  input: PrepareTerminalLogoutInput,
): Promise<PreparedTerminalLogout> {
  const bindingDigest = resolveAuthBinding(input.binding).bindingDigest;
  const refreshPayload = input.refreshToken
    ? await verifyToken(input.refreshToken)
    : null;
  const signedRefresh = isRefreshPayload(refreshPayload) ? refreshPayload : null;
  const logoutId = randomUUID();
  const nonce = randomBytes(32).toString('hex');
  const nonceDigest = createHash('sha256').update(nonce, 'utf8').digest('hex');

  const durable = await withAuthLifecycleSystemTransaction(async (tx) => {
    const [transition] = await tx
      .select({
        id: authBrowserTransitions.id,
        generation: authBrowserTransitions.generation,
        state: authBrowserTransitions.state,
        currentUserId: authBrowserTransitions.currentUserId,
        currentFamilyId: authBrowserTransitions.currentFamilyId,
      })
      .from(authBrowserTransitions)
      .where(eq(authBrowserTransitions.bindingDigest, bindingDigest))
      .for('update')
      .limit(1) as LockedTransition[];
    if (!transition || transition.state !== 'active') {
      throw new Error('Authentication binding is not active for terminal logout');
    }

    const [pending] = await tx
      .update(authBrowserTransitions)
      .set({
        state: 'logout_pending',
        generation: sql`${authBrowserTransitions.generation} + 1`,
        activeOperationId: null,
        activeOperationExpiresAt: null,
        logoutId,
        completionNonceDigest: nonceDigest,
        updatedAt: sql`now()`,
        logoutExpiresAt: sql`now() + (${TERMINAL_LOGOUT_TTL_MINUTES} * interval '1 minute')`,
      })
      .where(and(
        eq(authBrowserTransitions.id, transition.id),
        eq(authBrowserTransitions.generation, transition.generation),
        eq(authBrowserTransitions.state, 'active'),
      ))
      .returning({
        id: authBrowserTransitions.id,
        generation: authBrowserTransitions.generation,
        logoutId: authBrowserTransitions.logoutId,
        logoutExpiresAt: authBrowserTransitions.logoutExpiresAt,
      });
    if (!pending?.logoutId || !(pending.logoutExpiresAt instanceof Date)) {
      throw new Error('Terminal logout transition update did not commit a pending record');
    }

    const locks = await lockTerminalLogoutAuthority(tx, {
      userIds: [
        input.access.userId,
        transition.currentUserId ?? '',
        signedRefresh?.sub ?? '',
      ],
      familyIds: [
        input.access.familyId,
        transition.currentFamilyId ?? '',
        signedRefresh?.fam ?? '',
      ],
    });

    let refreshAuthority: RefreshAuthority = { kind: 'invalid' };
    if (signedRefresh && input.refreshToken) {
      refreshAuthority = await classifyRefreshTokenAuthority(tx, input.refreshToken);
    }

    const subjectIds = new Set<string>();
    if (isLiveAccessAuthority(input.access, locks)) subjectIds.add(input.access.userId);
    if (refreshAuthority.kind === 'current') subjectIds.add(refreshAuthority.userId);
    const sortedSubjectIds = [...subjectIds].sort();

    let revokedFamilyCount = 0;
    for (const userId of sortedSubjectIds) {
      await advanceUserSecurityState(tx, userId, { auth: true });
      revokedFamilyCount += await revokeAllUserSessionFamilies(
        tx,
        userId,
        TERMINAL_LOGOUT_REASON,
      );
    }

    const exactFamilies = new Map<string, string>();
    const refreshFamilyOwner = ownerOfClassifiedFamily(refreshAuthority, locks);
    if (refreshAuthority.kind === 'legacy_or_stale_family' && refreshFamilyOwner) {
      exactFamilies.set(refreshAuthority.familyId, refreshFamilyOwner);
    }
    if (transition.currentFamilyId && transition.currentUserId) {
      exactFamilies.set(transition.currentFamilyId, transition.currentUserId);
    }
    for (const [familyId, userId] of [...exactFamilies].sort(([left], [right]) => left.localeCompare(right))) {
      revokedFamilyCount += await revokeUserSessionFamily(
        tx,
        userId,
        familyId,
        TERMINAL_LOGOUT_REASON,
      );
    }

    const familyIdsForCleanup = [...locks.families.values()]
      .filter((family) => sortedSubjectIds.includes(family.userId) || exactFamilies.has(family.familyId))
      .map((family) => family.familyId)
      .sort();

    return {
      transitionId: pending.id,
      logoutId: pending.logoutId,
      generation: pending.generation,
      expiresAt: pending.logoutExpiresAt,
      subjectIds: sortedSubjectIds,
      advancedUserCount: sortedSubjectIds.length,
      revokedFamilyCount,
      familyIdsForCleanup,
      refreshJti: refreshAuthority.kind === 'invalid' ? null : signedRefresh?.jti ?? null,
    };
  });

  const cleanup = await runPostCommitCleanup([
    ...durable.subjectIds.map((userId) => ({
      name: `user:${userId}`,
      run: () => revokeAllUserTokens(userId),
    })),
    ...durable.familyIdsForCleanup.map((familyId) => ({
      name: `family:${familyId}`,
      run: () => cacheRefreshTokenFamilyRevocation(familyId),
    })),
    ...(durable.refreshJti ? [{
      name: 'refresh-jti',
      run: () => revokeRefreshTokenJti(durable.refreshJti!),
    }] : []),
  ]);

  for (const failure of cleanup.failures) {
    console.error(`[cf-access-logout] Post-commit cleanup failed (${failure.name}):`, failure.error);
  }

  return {
    transitionId: durable.transitionId,
    logoutId: durable.logoutId,
    generation: durable.generation,
    nonce,
    expiresAt: durable.expiresAt,
    subjectIds: durable.subjectIds,
    advancedUserCount: durable.advancedUserCount,
    revokedFamilyCount: durable.revokedFamilyCount,
    cleanupStatus: cleanup.cleanupStatus,
    cleanupFailures: cleanup.cleanupFailures,
  };
}
