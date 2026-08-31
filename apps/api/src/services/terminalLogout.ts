import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { inArray, or, sql } from 'drizzle-orm';
import { refreshTokenFamilies } from '../db/schema/refreshTokenFamilies';
import { users } from '../db/schema/users';
import {
  completeTerminalLogout,
  isTerminalLogoutPending,
  withTerminalLogoutTransition,
  type AuthBindingSource,
  type CompleteTerminalLogoutInput,
} from './authBrowserTransition';
import {
  advanceUserEpochs,
  revokeAllRefreshFamilies,
  revokeRefreshFamilyById,
} from './authLifecycle';
import {
  classifyRefreshTokenAuthority,
  type RefreshAuthority,
} from './refreshTokenFamily';
import { verifyToken } from './jwt';
import { revokeAllUserTokens, revokeRefreshTokenJti } from './tokenRevocation';

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
  lockUsers(userIds: readonly string[]): Promise<ReadonlyMap<string, TerminalLogoutUser>>;
  lockFamilies(
    userIds: readonly string[],
    familyIds: readonly string[],
  ): Promise<ReadonlyMap<string, TerminalLogoutFamily>>;
  classifyRefreshAuthority(token: string): Promise<RefreshAuthority>;
  globallyRevokeUser(userId: string): Promise<void>;
  exactlyRevokeFamily(familyId: string): Promise<void>;
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
  cleanup(input: Readonly<{ userIds: readonly string[]; refreshJti: string | null }>): Promise<void>;
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

function liveUser(
  users: ReadonlyMap<string, TerminalLogoutUser>,
  identity: Readonly<{ userId: string; authEpoch: number; mfaEpoch: number }>,
): TerminalLogoutUser | null {
  const user = users.get(identity.userId);
  return user
    && user.status === 'active'
    && user.authEpoch === identity.authEpoch
    && user.mfaEpoch === identity.mfaEpoch
    ? user
    : null;
}

function liveFamily(
  families: ReadonlyMap<string, TerminalLogoutFamily>,
  candidate: RefreshCandidate,
  databaseNow: Date,
): TerminalLogoutFamily | null {
  const family = families.get(candidate.familyId);
  return family
    && family.userId === candidate.userId
    && family.revokedAt === null
    && family.absoluteExpiresAt.getTime() > databaseNow.getTime()
    ? family
    : null;
}

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
  const users = await tx.lockUsers(userIds);
  const families = await tx.lockFamilies(userIds, familyIds);
  const refreshAuthority = refreshToken
    ? await tx.classifyRefreshAuthority(refreshToken)
    : { kind: 'invalid' as const };

  const globalUsers = new Set<string>();
  if (liveUser(users, access)) globalUsers.add(access.userId);

  let staleRefreshFamily: string | null = null;
  if (
    refresh
    && refreshAuthority.kind === 'current'
    && refreshAuthority.userId === refresh.userId
    && refreshAuthority.familyId === refresh.familyId
    && liveUser(users, refresh)
  ) {
    const family = liveFamily(families, refresh, tx.transition.databaseNow);
    if (family) globalUsers.add(refresh.userId);
  } else if (
    refresh
    && refreshAuthority.kind === 'legacy_or_stale_family'
    && refreshAuthority.familyId === refresh.familyId
    && liveFamily(families, refresh, tx.transition.databaseNow)
  ) {
    staleRefreshFamily = refresh.familyId;
  }

  const globalUserIds = [...globalUsers].sort();
  for (const userId of globalUserIds) await tx.globallyRevokeUser(userId);

  const exactFamilies = sortedUnique([staleRefreshFamily, tx.transition.currentFamilyId]);
  for (const familyId of exactFamilies) {
    const family = families.get(familyId);
    if (family && !globalUsers.has(family.userId)) await tx.exactlyRevokeFamily(familyId);
  }
  return globalUserIds;
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
      const globalUserIds = await revokeTerminalSubjects(
        tx,
        input.access,
        input.refreshToken,
        refresh,
      );
      if (mode === 'ordinary') {
        return { globalUserIds, replacement: await tx.retireWithSuccessor() } as const;
      }
      const issuedAt = Math.floor(tx.transition.databaseNow.getTime() / 1000);
      const expiresAt = issuedAt + TERMINAL_LOGOUT_TTL_SECONDS;
      const nonceDigest = createHash('sha256').update(nonce!, 'utf8').digest('hex');
      const pending = await tx.markLogoutPending({
        logoutId: logoutId!,
        nonceDigest,
        expiresAt: new Date(expiresAt * 1000),
      });
      return { globalUserIds, pending, issuedAt, expiresAt } as const;
    });

    let cleanupOk = true;
    try {
      await dependencies.cleanup({
        userIds: durable.globalUserIds,
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
        lockFamilies: async (userIds, familyIds) => {
          if (userIds.length === 0 && familyIds.length === 0) return new Map();
          const predicate = userIds.length === 0
            ? inArray(refreshTokenFamilies.familyId, [...familyIds])
            : familyIds.length === 0
              ? inArray(refreshTokenFamilies.userId, [...userIds])
              : or(
                  inArray(refreshTokenFamilies.userId, [...userIds]),
                  inArray(refreshTokenFamilies.familyId, [...familyIds]),
                );
          const rows = await mutation.tx
            .select({
              familyId: refreshTokenFamilies.familyId,
              userId: refreshTokenFamilies.userId,
              revokedAt: refreshTokenFamilies.revokedAt,
              absoluteExpiresAt: refreshTokenFamilies.absoluteExpiresAt,
              currentRefreshJtiDigest: refreshTokenFamilies.currentRefreshJtiDigest,
            })
            .from(refreshTokenFamilies)
            .where(predicate)
            .orderBy(refreshTokenFamilies.familyId)
            .for('update');
          return new Map(rows.map((row) => [row.familyId, row]));
        },
        classifyRefreshAuthority: (token) => classifyRefreshTokenAuthority(mutation.tx, token),
        globallyRevokeUser: async (userId) => {
          await advanceUserEpochs(mutation.tx, userId, { auth: true });
          await revokeAllRefreshFamilies(mutation.tx, userId, 'terminal_logout');
        },
        exactlyRevokeFamily: (familyId) =>
          revokeRefreshFamilyById(mutation.tx, familyId, 'terminal_logout'),
        retireWithSuccessor: mutation.retireWithSuccessor,
        markLogoutPending: async (input) => ({
          ...await mutation.markLogoutPending(input),
          nonceDigest: input.nonceDigest,
        }),
      };
      return callback(tx);
    }),
  cleanup: async ({ userIds, refreshJti }) => {
    const failures: unknown[] = [];
    for (const userId of userIds) {
      try {
        await revokeAllUserTokens(userId);
      } catch (error) {
        failures.push(error);
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
