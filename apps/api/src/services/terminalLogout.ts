import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { refreshTokenFamilies } from '../db/schema/refreshTokenFamilies';
import { users } from '../db/schema/users';
import {
  completeTerminalLogout,
  isTerminalLogoutPending,
  withTerminalLogoutTransition,
  type AuthBindingSource,
  type CompleteTerminalLogoutInput,
} from './authBrowserTransition';
import { revokeRefreshFamilyById } from './authLifecycle';
import {
  classifyRefreshTokenAuthority,
  type RefreshAuthority,
} from './refreshTokenFamily';
import { verifyToken } from './jwt';
import { publishFamilyRevocationSentinel, revokeRefreshTokenJti } from './tokenRevocation';

const TERMINAL_LOGOUT_TTL_SECONDS = 5 * 60;

export type TerminalAccessAuthority = Readonly<{
  userId: string;
  authEpoch: number;
  mfaEpoch: number;
  familyId: string | null;
}>;

export type TerminalLogoutInput = Readonly<{
  binding: AuthBindingSource;
  access: TerminalAccessAuthority;
  refreshToken: string | null;
}>;

export type TerminalLogoutUser = Readonly<{
  id: string;
  status: 'active' | string;
  authEpoch: number;
  mfaEpoch: number;
}>;

export type TerminalLogoutFamily = Readonly<{
  familyId: string;
  userId: string;
  revokedAt: Date | null;
  absoluteExpiresAt: Date;
  currentRefreshJtiDigest: string | null;
}>;

export type TerminalLogoutTransition = Readonly<{
  id: string;
  generation: number;
  state: 'active' | 'logout_pending' | 'retired';
  currentUserId: string | null;
  currentFamilyId: string | null;
  databaseNow: Date;
}>;

export interface TerminalLogoutTransaction {
  transition: TerminalLogoutTransition;
  /**
   * Locks the subjects' user rows. Logout makes no decision from them; the
   * lock only keeps the global transition -> users -> families order, because
   * classifyRefreshAuthority locks a user row after the families are locked.
   */
  lockUsers(userIds: readonly string[]): Promise<ReadonlyMap<string, TerminalLogoutUser>>;
  /** Locks exactly the named families, never every family a user owns. */
  lockFamilies(familyIds: readonly string[]): Promise<ReadonlyMap<string, TerminalLogoutFamily>>;
  classifyRefreshAuthority(token: string): Promise<RefreshAuthority>;
  /** Durably revokes one sign-in session (refresh family) inside the transaction. */
  revokeFamily(familyId: string): Promise<void>;
  retireWithSuccessor(): Promise<AuthBindingSource>;
  markLogoutPending(input: Readonly<{
    logoutId: string;
    nonceDigest: string;
    expiresAt: Date;
  }>): Promise<Readonly<{
    transitionId: string;
    logoutId: string;
    generation: number;
    nonceDigest: string;
  }>>;
}

type VerifiedToken = Readonly<{
  type?: unknown;
  sub?: unknown;
  fam?: unknown;
  jti?: unknown;
  aep?: unknown;
  mep?: unknown;
}>;

export interface TerminalLogoutDependencies {
  verifyRefreshToken(token: string): Promise<unknown>;
  withLockedTransition<T>(
    binding: AuthBindingSource,
    callback: (tx: TerminalLogoutTransaction) => Promise<T>,
  ): Promise<T>;
  cleanup(input: Readonly<{ familyIds: readonly string[]; refreshJti: string | null }>): Promise<void>;
  randomUuid(): string;
  randomNonce(): string;
}

type RefreshCandidate = Readonly<{
  userId: string;
  familyId: string;
  jti: string;
  authEpoch: number;
  mfaEpoch: number;
}>;

function refreshCandidate(payload: unknown): RefreshCandidate | null {
  if (!payload || typeof payload !== 'object') return null;
  const claims = payload as VerifiedToken;
  if (
    claims.type !== 'refresh'
    || typeof claims.sub !== 'string'
    || typeof claims.fam !== 'string'
    || typeof claims.jti !== 'string'
    || typeof claims.aep !== 'number'
    || typeof claims.mep !== 'number'
  ) return null;
  return {
    userId: claims.sub,
    familyId: claims.fam,
    jti: claims.jti,
    authEpoch: claims.aep,
    mfaEpoch: claims.mep,
  };
}

function sortedUnique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

/** The family id when it is locked, still live, and (if given) owned by `ownerUserId`. */
function revocableFamily(
  families: ReadonlyMap<string, TerminalLogoutFamily>,
  familyId: string | null | undefined,
  ownerUserId?: string,
): string | null {
  const family = familyId ? families.get(familyId) : undefined;
  if (!family || family.revokedAt !== null) return null;
  if (ownerUserId !== undefined && family.userId !== ownerUserId) return null;
  return family.familyId;
}

/**
 * Ends exactly the sign-in session(s) this browser presents, and nothing
 * else the user has open:
 *
 *   A — the bearer's `sid` (the family every access token of this sign-in
 *       carries), owned by the bearer user;
 *   B — the refresh cookie's `fam`, when the durable classifier confirms the
 *       signed token is that family's current or an earlier rotation;
 *   C — the family the binding row currently points at.
 *
 * Each is a durable `refresh_token_families.revoked_at`. authMiddleware and
 * /refresh both read that column, so every access and refresh token of the
 * session stops working even if Redis loses the post-commit markers. The
 * user's epochs and other families are deliberately untouched: other sign-in
 * sessions keep working. Revocation only removes authority, so a bearer whose
 * epochs went stale after admission still ends its own session.
 */
async function revokeTerminalSubjects(
  tx: TerminalLogoutTransaction,
  access: TerminalAccessAuthority,
  refreshToken: string | null,
  refresh: RefreshCandidate | null,
): Promise<readonly string[]> {
  if (tx.transition.state !== 'active') {
    throw new Error('Authentication binding is not active');
  }
  const userIds = sortedUnique([
    access.userId,
    refresh?.userId,
    tx.transition.currentUserId,
  ]);
  const familyIds = sortedUnique([
    access.familyId,
    refresh?.familyId,
    tx.transition.currentFamilyId,
  ]);
  await tx.lockUsers(userIds);
  const families = await tx.lockFamilies(familyIds);
  const refreshAuthority = refreshToken
    ? await tx.classifyRefreshAuthority(refreshToken)
    : { kind: 'invalid' as const };

  const refreshFamily = refresh && (
    (refreshAuthority.kind === 'current'
      && refreshAuthority.userId === refresh.userId
      && refreshAuthority.familyId === refresh.familyId)
    || (refreshAuthority.kind === 'legacy_or_stale_family'
      && refreshAuthority.familyId === refresh.familyId)
  )
    ? revocableFamily(families, refresh.familyId, refresh.userId)
    : null;

  const targets = sortedUnique([
    revocableFamily(families, access.familyId, access.userId),
    refreshFamily,
    // The binding row names its family itself (bound under this same lock).
    revocableFamily(families, tx.transition.currentFamilyId),
  ]);
  for (const familyId of targets) await tx.revokeFamily(familyId);
  return targets;
}

export function createTerminalLogoutService(dependencies: TerminalLogoutDependencies) {
  async function prepare(input: TerminalLogoutInput, mode: 'ordinary' | 'cf') {
    const verifiedRefresh = input.refreshToken
      ? await dependencies.verifyRefreshToken(input.refreshToken)
      : null;
    const refresh = refreshCandidate(verifiedRefresh);
    const nonce = mode === 'cf' ? dependencies.randomNonce() : null;
    const logoutId = mode === 'cf' ? dependencies.randomUuid() : null;

    const durable = await dependencies.withLockedTransition(input.binding, async (tx) => {
      const revokedFamilyIds = await revokeTerminalSubjects(
        tx,
        input.access,
        input.refreshToken,
        refresh,
      );
      if (mode === 'ordinary') {
        return { revokedFamilyIds, replacement: await tx.retireWithSuccessor() } as const;
      }
      const issuedAt = Math.floor(tx.transition.databaseNow.getTime() / 1000);
      const expiresAt = issuedAt + TERMINAL_LOGOUT_TTL_SECONDS;
      const nonceDigest = createHash('sha256').update(nonce!, 'utf8').digest('hex');
      const pending = await tx.markLogoutPending({
        logoutId: logoutId!,
        nonceDigest,
        expiresAt: new Date(expiresAt * 1000),
      });
      return { revokedFamilyIds, pending, issuedAt, expiresAt } as const;
    });

    let cleanupOk = true;
    try {
      await dependencies.cleanup({
        familyIds: durable.revokedFamilyIds,
        refreshJti: refresh?.jti ?? null,
      });
    } catch {
      cleanupOk = false;
    }
    return { ...durable, nonce, logoutId, cleanupOk };
  }

  return Object.freeze({
    async performOrdinaryTerminalLogout(input: TerminalLogoutInput): Promise<Readonly<{
      replacement: AuthBindingSource;
      cleanupOk: boolean;
    }>> {
      const result = await prepare(input, 'ordinary');
      if (!('replacement' in result)) throw new Error('Terminal logout mode mismatch');
      return Object.freeze({ replacement: result.replacement!, cleanupOk: result.cleanupOk });
    },
    async prepareCfTerminalLogout(input: TerminalLogoutInput): Promise<Readonly<{
      transitionId: string;
      logoutId: string;
      generation: number;
      nonce: string;
      issuedAt: number;
      expiresAt: number;
      cleanupOk: boolean;
    }>> {
      const result = await prepare(input, 'cf');
      if (!('pending' in result) || !result.nonce || !result.logoutId) {
        throw new Error('Terminal logout mode mismatch');
      }
      return Object.freeze({
        transitionId: result.pending!.transitionId,
        logoutId: result.pending!.logoutId,
        generation: result.pending!.generation,
        nonce: result.nonce,
        issuedAt: result.issuedAt!,
        expiresAt: result.expiresAt!,
        cleanupOk: result.cleanupOk,
      });
    },
  });
}

const productionDependencies: TerminalLogoutDependencies = {
  verifyRefreshToken: verifyToken,
  withLockedTransition: (binding, callback) =>
    withTerminalLogoutTransition(binding, async (mutation) => {
      const tx: TerminalLogoutTransaction = {
        transition: mutation.transition,
        lockUsers: async (userIds) => {
          const rows = userIds.length === 0 ? [] : await mutation.tx
            .select({
              id: users.id,
              status: users.status,
              authEpoch: users.authEpoch,
              mfaEpoch: users.mfaEpoch,
            })
            .from(users)
            .where(inArray(users.id, [...userIds]))
            .orderBy(users.id)
            .for('update');
          return new Map(rows.map((row) => [row.id, row]));
        },
        lockFamilies: async (familyIds) => {
          if (familyIds.length === 0) return new Map();
          const rows = await mutation.tx
            .select({
              familyId: refreshTokenFamilies.familyId,
              userId: refreshTokenFamilies.userId,
              revokedAt: refreshTokenFamilies.revokedAt,
              absoluteExpiresAt: refreshTokenFamilies.absoluteExpiresAt,
              currentRefreshJtiDigest: refreshTokenFamilies.currentRefreshJtiDigest,
            })
            .from(refreshTokenFamilies)
            .where(inArray(refreshTokenFamilies.familyId, [...familyIds]))
            .orderBy(refreshTokenFamilies.familyId)
            .for('update');
          return new Map(rows.map((row) => [row.familyId, row]));
        },
        classifyRefreshAuthority: (token) => classifyRefreshTokenAuthority(mutation.tx, token),
        revokeFamily: (familyId) =>
          revokeRefreshFamilyById(mutation.tx, familyId, 'terminal_logout'),
        retireWithSuccessor: mutation.retireWithSuccessor,
        markLogoutPending: async (input) => ({
          ...await mutation.markLogoutPending(input),
          nonceDigest: input.nonceDigest,
        }),
      };
      return callback(tx);
    }),
  // Redis markers only shorten the hot-path lookups; the committed family rows
  // are the authority, so a failure here never reopens the session.
  cleanup: async ({ familyIds, refreshJti }) => {
    const failures: unknown[] = [];
    for (const familyId of familyIds) {
      if (!await publishFamilyRevocationSentinel(familyId)) {
        failures.push(new Error('family sentinel not published'));
      }
    }
    if (refreshJti) {
      try {
        await revokeRefreshTokenJti(refreshJti);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Terminal logout Redis cleanup failed');
  },
  randomUuid: randomUUID,
  randomNonce: () => randomBytes(32).toString('hex'),
};

const defaultTerminalLogoutService = createTerminalLogoutService(productionDependencies);

export const performOrdinaryTerminalLogout =
  defaultTerminalLogoutService.performOrdinaryTerminalLogout;
export const prepareCfTerminalLogout = defaultTerminalLogoutService.prepareCfTerminalLogout;
export function completeCfTerminalLogout(input: CompleteTerminalLogoutInput) {
  return completeTerminalLogout(input);
}
export function isCfTerminalLogoutPending(
  input: Omit<CompleteTerminalLogoutInput, 'signingKeyId'>,
) {
  return isTerminalLogoutPending(input);
}
