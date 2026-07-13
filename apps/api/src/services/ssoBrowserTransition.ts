import { createHash } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import {
  authBrowserTransitions,
  refreshTokenFamilies,
  ssoSessions,
  ssoTokenExchangeGrants,
  users,
} from '../db/schema';
import {
  withAuthLifecycleSystemTransaction,
  type AuthLifecycleTransaction,
} from './authLifecycle';
import {
  beginAuthIssuanceForStoredTransition,
  type AuthIssuanceCapability,
} from './authBrowserTransition';
import { decryptSecret, encryptSecret } from './secretCrypto';

const SSO_EXCHANGE_CODE_AAD = 'sso-token-exchange-grant.code:v1';
const SSO_EXCHANGE_GRANT_TTL_MINUTES = 2;

export type SsoExchangeTokenHandoff = Readonly<{
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}>;

function isSsoExchangeTokenHandoff(value: unknown): value is SsoExchangeTokenHandoff {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SsoExchangeTokenHandoff>;
  return typeof candidate.accessToken === 'string' && candidate.accessToken.length > 0
    && typeof candidate.refreshToken === 'string' && candidate.refreshToken.length > 0
    && typeof candidate.expiresInSeconds === 'number'
    && Number.isFinite(candidate.expiresInSeconds)
    && candidate.expiresInSeconds > 0;
}

export function digestSsoExchangeCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

export function sealSsoExchangeCode(
  payload: SsoExchangeTokenHandoff,
): Readonly<{ code: string; codeDigest: string }> {
  if (!isSsoExchangeTokenHandoff(payload)) {
    throw new Error('Invalid SSO token handoff');
  }
  const code = encryptSecret(JSON.stringify(payload), { aad: SSO_EXCHANGE_CODE_AAD });
  if (!code) throw new Error('Failed to seal SSO exchange code');
  return Object.freeze({ code, codeDigest: digestSsoExchangeCode(code) });
}

export function openSsoExchangeCode(code: string): SsoExchangeTokenHandoff {
  const plaintext = decryptSecret(code, { aad: SSO_EXCHANGE_CODE_AAD });
  if (!plaintext) throw new Error('Invalid SSO exchange code');
  const parsed: unknown = JSON.parse(plaintext);
  if (!isSsoExchangeTokenHandoff(parsed)) throw new Error('Invalid SSO token handoff');
  return Object.freeze({ ...parsed });
}

export class SsoCallbackStateUnavailableError extends Error {
  constructor() {
    super('SSO callback state is unavailable');
    this.name = 'SsoCallbackStateUnavailableError';
  }
}

export type ClaimedSsoCallback =
  | Readonly<{
      kind: 'link';
      session: typeof ssoSessions.$inferSelect;
    }>
  | Readonly<{
      kind: 'login';
      session: typeof ssoSessions.$inferSelect;
      capability: AuthIssuanceCapability;
    }>;

/**
 * Claim callback state without spanning the IdP exchange. Login callbacks
 * reserve the persisted browser generation; link callbacks retain their
 * legacy one-statement consume because they mint no Breeze session.
 */
export async function claimSsoCallbackIssuance(
  state: string,
): Promise<ClaimedSsoCallback | null> {
  const [candidate] = await withSystemDbAccessContext(() =>
    db
      .select()
      .from(ssoSessions)
      .where(and(eq(ssoSessions.state, state), gt(ssoSessions.expiresAt, sql`now()`)))
      .limit(1)
  );
  if (!candidate) return null;

  if (candidate.linkUserId) {
    const [consumed] = await withSystemDbAccessContext(() =>
      db
        .delete(ssoSessions)
        .where(and(
          eq(ssoSessions.id, candidate.id),
          eq(ssoSessions.state, state),
          gt(ssoSessions.expiresAt, sql`now()`),
        ))
        .returning()
    );
    return consumed ? Object.freeze({ kind: 'link' as const, session: consumed }) : null;
  }

  if (!candidate.browserTransitionId || candidate.browserGeneration === null) {
    throw new SsoCallbackStateUnavailableError();
  }
  const admission = await beginAuthIssuanceForStoredTransition({
    transitionId: candidate.browserTransitionId,
    generation: candidate.browserGeneration,
  }, async (tx) => {
    const [consumed] = await tx
      .delete(ssoSessions)
      .where(and(
        eq(ssoSessions.id, candidate.id),
        eq(ssoSessions.state, state),
        eq(ssoSessions.browserTransitionId, candidate.browserTransitionId!),
        eq(ssoSessions.browserGeneration, candidate.browserGeneration!),
        gt(ssoSessions.expiresAt, sql`now()`),
      ))
      .returning();
    if (!consumed) {
      throw new SsoCallbackStateUnavailableError();
    }
    return consumed;
  });
  return Object.freeze({
    kind: 'login' as const,
    session: admission.claimed,
    capability: admission.capability,
  });
}

export async function createDurableSsoExchangeGrant(
  tx: AuthLifecycleTransaction,
  input: Readonly<{
    capability: AuthIssuanceCapability;
    userId: string;
    familyId: string;
    tokens: SsoExchangeTokenHandoff;
  }>,
): Promise<string> {
  const sealed = sealSsoExchangeCode(input.tokens);
  const inserted = await tx
    .insert(ssoTokenExchangeGrants)
    .values({
      codeDigest: sealed.codeDigest,
      browserTransitionId: input.capability.transitionId,
      browserGeneration: input.capability.generation,
      userId: input.userId,
      familyId: input.familyId,
      expiresAt: sql`now() + ${SSO_EXCHANGE_GRANT_TTL_MINUTES} * interval '1 minute'`,
    })
    .returning({ id: ssoTokenExchangeGrants.id });
  if (inserted.length !== 1) throw new Error('Failed to create SSO exchange grant');
  return sealed.code;
}

function instantMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/** Consume one durable grant under transition → user → family → grant locks. */
export async function consumeDurableSsoExchangeGrant(
  code: string,
): Promise<SsoExchangeTokenHandoff | null> {
  let payload: SsoExchangeTokenHandoff;
  try {
    payload = openSsoExchangeCode(code);
  } catch {
    return null;
  }
  const codeDigest = digestSsoExchangeCode(code);
  const [candidate] = await withSystemDbAccessContext(() =>
    db
      .select()
      .from(ssoTokenExchangeGrants)
      .where(eq(ssoTokenExchangeGrants.codeDigest, codeDigest))
      .limit(1)
  );
  if (!candidate) return null;

  const consumed = await withAuthLifecycleSystemTransaction(async (tx) => {
    const [transition] = await tx
      .select({
        id: authBrowserTransitions.id,
        generation: authBrowserTransitions.generation,
        state: authBrowserTransitions.state,
        currentUserId: authBrowserTransitions.currentUserId,
        currentFamilyId: authBrowserTransitions.currentFamilyId,
        databaseNow: sql<Date>`now()`,
      })
      .from(authBrowserTransitions)
      .where(eq(authBrowserTransitions.id, candidate.browserTransitionId))
      .for('update')
      .limit(1);
    if (!transition
      || transition.state !== 'active'
      || transition.generation !== candidate.browserGeneration
      || transition.currentUserId !== candidate.userId
      || transition.currentFamilyId !== candidate.familyId) return false;

    const [user] = await tx
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, candidate.userId))
      .for('update')
      .limit(1);
    if (!user || user.status !== 'active') return false;

    const [family] = await tx
      .select({
        familyId: refreshTokenFamilies.familyId,
        userId: refreshTokenFamilies.userId,
        revokedAt: refreshTokenFamilies.revokedAt,
        absoluteExpiresAt: refreshTokenFamilies.absoluteExpiresAt,
      })
      .from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, candidate.familyId))
      .for('update')
      .limit(1);
    if (!family
      || family.userId !== candidate.userId
      || family.revokedAt !== null
      || instantMillis(family.absoluteExpiresAt) <= instantMillis(transition.databaseNow)) return false;

    const [grant] = await tx
      .select()
      .from(ssoTokenExchangeGrants)
      .where(eq(ssoTokenExchangeGrants.id, candidate.id))
      .for('update')
      .limit(1);
    if (!grant
      || grant.codeDigest !== codeDigest
      || grant.consumedAt !== null
      || grant.browserTransitionId !== transition.id
      || grant.browserGeneration !== transition.generation
      || grant.userId !== user.id
      || grant.familyId !== family.familyId
      || instantMillis(grant.expiresAt) <= instantMillis(transition.databaseNow)) return false;

    const updated = await tx
      .update(ssoTokenExchangeGrants)
      .set({ consumedAt: sql`now()` })
      .where(and(
        eq(ssoTokenExchangeGrants.id, grant.id),
        isNull(ssoTokenExchangeGrants.consumedAt),
      ))
      .returning({ id: ssoTokenExchangeGrants.id });
    return updated.length === 1;
  });
  return consumed ? payload : null;
}
