/**
 * Refresh-Token Family Mint Helper (Task 7 follow-up)
 *
 * Centralises the family-creation dance so every authenticated token-mint
 * path uses one source of truth. Without this helper, /login, /mfa/verify,
 * /register-partner, /accept-invite, and /sso/callback all had to repeat
 * the same 4-step sequence — and missing it on any path (most importantly
 * /mfa/verify) silently disabled reuse-detection for that cohort of users.
 *
 * Sequence (single-source-of-truth, OAuth 2.1 / RFC 9700 §4.13.2):
 *   1. Generate a fresh familyId UUID.
 *   2. INSERT into refresh_token_families under system scope (audit row).
 *   3. Caller mints the token pair with `{ refreshFam: familyId }`.
 *   4. Caller calls bindRefreshJtiToFamily(refreshJti, familyId) so the
 *      jti → family mapping is hot in Redis for the next /refresh.
 *
 * Steps 1+2 live here; 3+4 stay in the route handler so each path can apply
 * its own surrounding logic (db wrapping, audit trail, etc).
 */
import { createHash, randomUUID } from 'crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { refreshTokenFamilies } from '../db/schema/refreshTokenFamilies';
import { users } from '../db/schema/users';
import type { Tx } from './authLifecycle';
import { verifyToken } from './jwt';
import { rememberJtiFamily } from './tokenRevocation';

function absoluteTtlDays(): number {
  const raw = Number.parseInt(process.env.REFRESH_FAMILY_ABSOLUTE_TTL_DAYS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}

/**
 * Mints a fresh refresh-token family for a user and persists the audit row
 * to refresh_token_families under system scope (matches the existing /login
 * pattern — RLS Shape 6, system-scope OR branch).
 *
 * Returns the new familyId, which the caller must pass to createTokenPair
 * via `{ refreshFam: familyId }` and then to bindRefreshJtiToFamily once the
 * pair is minted.
 *
 * If the insert fails this throws — callers should let the error propagate
 * (no token has been minted yet, so failing the request is the right
 * outcome; the alternative is a token without a family, which is exactly
 * the bug this helper exists to prevent).
 */
// W07-A rollout overload for the frozen pre-guard issuer inventory only.
export async function mintRefreshTokenFamily(userId: string): Promise<string>;
export async function mintRefreshTokenFamily(
  userId: string,
  currentRefreshJti: string,
  options?: { tx?: Tx },
): Promise<string>;
export async function mintRefreshTokenFamily(
  userId: string,
  currentRefreshJti?: string,
  options: { tx?: Tx } = {},
): Promise<string> {
  const familyId = randomUUID();
  const absoluteExpiresAt = new Date(Date.now() + absoluteTtlDays() * 24 * 60 * 60 * 1000);
  const insert = async (executor: Pick<Tx, 'insert'>) => {
    await executor.insert(refreshTokenFamilies).values({
      familyId,
      userId,
      absoluteExpiresAt,
      currentRefreshJtiDigest: currentRefreshJti === undefined
        ? null
        : digestRefreshTokenJti(currentRefreshJti),
    });
  };
  if (options.tx) {
    await insert(options.tx);
  } else {
    await dbModule.runOutsideDbContext(() =>
      dbModule.withSystemDbAccessContext(() => insert(dbModule.db)),
    );
  }
  return familyId;
}

export function digestRefreshTokenJti(jti: string): string {
  return createHash('sha256')
    .update(`auth-refresh-jti:v1\0${jti}`, 'utf8')
    .digest('hex');
}

export class RefreshTokenCurrentnessError extends Error {
  constructor() {
    super('Refresh token is not the durable current token for its family');
    this.name = 'RefreshTokenCurrentnessError';
  }
}

/** Lock and compare/swap one owner-bound live family using database time. */
export async function rotateRefreshTokenFamilyCurrentJti(
  tx: Tx,
  input: { familyId: string; userId: string; presentedJti: string; successorJti: string },
): Promise<void> {
  const [family] = await tx
    .select({
      userId: refreshTokenFamilies.userId,
      revokedAt: refreshTokenFamilies.revokedAt,
      absoluteExpiresAt: refreshTokenFamilies.absoluteExpiresAt,
      currentRefreshJtiDigest: refreshTokenFamilies.currentRefreshJtiDigest,
      databaseNow: sql<Date>`now()`,
    })
    .from(refreshTokenFamilies)
    .where(and(
      eq(refreshTokenFamilies.familyId, input.familyId),
      eq(refreshTokenFamilies.userId, input.userId),
    ))
    .for('update')
    .limit(1);

  const databaseNow = family?.databaseNow instanceof Date
    ? family.databaseNow
    : new Date(family?.databaseNow ?? Number.NaN);
  if (
    !family
    || family.userId !== input.userId
    || family.revokedAt !== null
    || !(family.absoluteExpiresAt instanceof Date)
    || !Number.isFinite(family.absoluteExpiresAt.getTime())
    || !Number.isFinite(databaseNow.getTime())
    || family.absoluteExpiresAt.getTime() <= databaseNow.getTime()
  ) {
    throw new RefreshTokenCurrentnessError();
  }

  const presentedDigest = digestRefreshTokenJti(input.presentedJti);
  const legacy = family.currentRefreshJtiDigest === null;
  if (!legacy && family.currentRefreshJtiDigest !== presentedDigest) {
    throw new RefreshTokenCurrentnessError();
  }

  const currentPredicate = legacy
    ? isNull(refreshTokenFamilies.currentRefreshJtiDigest)
    : eq(refreshTokenFamilies.currentRefreshJtiDigest, presentedDigest);
  const updated = await tx
    .update(refreshTokenFamilies)
    .set({
      currentRefreshJtiDigest: digestRefreshTokenJti(input.successorJti),
      lastUsedAt: sql`now()`,
    })
    .where(and(
      eq(refreshTokenFamilies.familyId, input.familyId),
      eq(refreshTokenFamilies.userId, input.userId),
      isNull(refreshTokenFamilies.revokedAt),
      currentPredicate,
    ))
    .returning({ familyId: refreshTokenFamilies.familyId });
  if (updated.length !== 1) throw new RefreshTokenCurrentnessError();
}

export type RefreshAuthority =
  | Readonly<{ kind: 'current'; userId: string; familyId: string }>
  | Readonly<{ kind: 'legacy_or_stale_family'; familyId: string }>
  | Readonly<{ kind: 'invalid' }>;

/**
 * Classify refresh authority without allowing legacy/stale tokens to name a
 * global logout subject. Caller already owns the transition lock; this helper
 * then follows the global user-before-family lock order.
 */
export async function classifyRefreshTokenAuthority(tx: Tx, token: string): Promise<RefreshAuthority> {
  const payload = await verifyToken(token);
  if (
    !payload
    || payload.type !== 'refresh'
    || !payload.sub
    || !payload.fam
    || !payload.jti
    || typeof payload.aep !== 'number'
    || typeof payload.mep !== 'number'
  ) {
    return { kind: 'invalid' };
  }

  const [user] = await tx
    .select({
      id: users.id,
      status: users.status,
      authEpoch: users.authEpoch,
      mfaEpoch: users.mfaEpoch,
    })
    .from(users)
    .where(eq(users.id, payload.sub))
    .for('update')
    .limit(1);
  if (
    !user
    || user.id !== payload.sub
    || user.status !== 'active'
    || user.authEpoch !== payload.aep
    || user.mfaEpoch !== payload.mep
  ) {
    return { kind: 'invalid' };
  }

  const [family] = await tx
    .select({
      familyId: refreshTokenFamilies.familyId,
      userId: refreshTokenFamilies.userId,
      revokedAt: refreshTokenFamilies.revokedAt,
      absoluteExpiresAt: refreshTokenFamilies.absoluteExpiresAt,
      currentRefreshJtiDigest: refreshTokenFamilies.currentRefreshJtiDigest,
      databaseNow: sql<Date>`now()`,
    })
    .from(refreshTokenFamilies)
    .where(and(
      eq(refreshTokenFamilies.familyId, payload.fam),
      eq(refreshTokenFamilies.userId, payload.sub),
    ))
    .for('update')
    .limit(1);

  const databaseNow = family?.databaseNow instanceof Date
    ? family.databaseNow
    : new Date(family?.databaseNow ?? Number.NaN);
  if (
    !family
    || family.familyId !== payload.fam
    || family.userId !== payload.sub
    || family.revokedAt !== null
    || !(family.absoluteExpiresAt instanceof Date)
    || !Number.isFinite(databaseNow.getTime())
    || family.absoluteExpiresAt.getTime() <= databaseNow.getTime()
  ) {
    return { kind: 'invalid' };
  }

  if (family.currentRefreshJtiDigest !== digestRefreshTokenJti(payload.jti)) {
    return { kind: 'legacy_or_stale_family', familyId: payload.fam };
  }
  return { kind: 'current', userId: payload.sub, familyId: payload.fam };
}

/**
 * Best-effort bind of the newly-minted refresh jti to its family in Redis.
 * Mirrors the /login post-mint dance. Failure here is non-fatal: the family
 * id is also encoded in the JWT `fam` claim, so the family-revocation check
 * still works from the verified payload.
 */
export async function bindRefreshJtiToFamily(jti: string, familyId: string): Promise<void> {
  await rememberJtiFamily(jti, familyId);
}

/**
 * Fetch a family's revocation + absolute-expiry state for the /refresh gate.
 * System-scoped: /refresh runs pre-request-context. Returns null when no row.
 */
export async function getRefreshFamily(
  familyId: string,
): Promise<{ revokedAt: Date | null; absoluteExpiresAt: Date } | null> {
  return dbModule.withSystemDbAccessContext(async () => {
    const rows = await dbModule.db
      .select({
        revokedAt: refreshTokenFamilies.revokedAt,
        absoluteExpiresAt: refreshTokenFamilies.absoluteExpiresAt,
      })
      .from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, familyId))
      .limit(1);
    return rows[0] ?? null;
  });
}
