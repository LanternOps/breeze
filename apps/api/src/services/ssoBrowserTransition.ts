import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { and, eq, gt, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  authBrowserTransitions,
  refreshTokenFamilies,
  ssoProviders,
  ssoSessions,
  ssoTokenExchangeGrants,
  users,
} from '../db/schema';
import type { Tx as AuthLifecycleTransaction } from './authLifecycle';
import {
  beginAuthIssuanceForStoredTransition,
  type AuthIssuanceCapability,
} from './authBrowserTransition';
import { getSecretDerivedKeyMaterials } from './secretCrypto';

const SSO_EXCHANGE_CODE_AAD = 'sso-token-exchange-grant.code:v1';
const SSO_EXCHANGE_CODE_PREFIX = 'sso-exchange:v1:';
const SSO_EXCHANGE_GRANT_TTL_MINUTES = 2;
const SSO_EXCHANGE_KEY_ID_PATTERN = /^(?:~|[A-Za-z0-9._-]+)$/;

async function withSsoSystemTransaction<T>(
  callback: (tx: AuthLifecycleTransaction) => Promise<T>,
): Promise<T> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() => db.transaction(callback)),
  );
}

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

function encryptSsoExchangePayload(value: string): string {
  const { active } = getSecretDerivedKeyMaterials(SSO_EXCHANGE_CODE_AAD);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', active.key, iv);
  cipher.setAAD(Buffer.from(SSO_EXCHANGE_CODE_AAD, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${SSO_EXCHANGE_CODE_PREFIX}${active.keyId ?? '~'}:${iv.toString('base64url')}.${authTag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function decryptSsoExchangePayload(code: string): string {
  if (!code.startsWith(SSO_EXCHANGE_CODE_PREFIX)) {
    throw new Error('Invalid SSO exchange code envelope');
  }
  const encoded = code.slice(SSO_EXCHANGE_CODE_PREFIX.length);
  const keyIdSeparator = encoded.indexOf(':');
  if (keyIdSeparator <= 0) throw new Error('Invalid SSO exchange code envelope');
  const envelopeKeyId = encoded.slice(0, keyIdSeparator);
  const parts = encoded.slice(keyIdSeparator + 1).split('.');
  if (!SSO_EXCHANGE_KEY_ID_PATTERN.test(envelopeKeyId) || parts.length !== 3) {
    throw new Error('Invalid SSO exchange code envelope');
  }
  const [ivText, authTagText, ciphertextText] = parts;
  if (!ivText || !authTagText || !ciphertextText) {
    throw new Error('Invalid SSO exchange code envelope');
  }
  const iv = Buffer.from(ivText, 'base64url');
  const authTag = Buffer.from(authTagText, 'base64url');
  const ciphertext = Buffer.from(ciphertextText, 'base64url');
  if (iv.length !== 12 || authTag.length !== 16 || ciphertext.length === 0) {
    throw new Error('Invalid SSO exchange code envelope');
  }

  const materials = getSecretDerivedKeyMaterials(SSO_EXCHANGE_CODE_AAD);
  const candidates = [materials.active, ...materials.retained]
    .filter((material) => envelopeKeyId === '~' || material.keyId === envelopeKeyId)
    .filter((material, index, all) =>
      all.findIndex((candidate) => candidate.key.equals(material.key)) === index,
    );
  if (candidates.length === 0) throw new Error('Unknown SSO exchange key ID');

  let lastError: unknown;
  for (const material of candidates) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', material.key, iv);
      decipher.setAAD(Buffer.from(SSO_EXCHANGE_CODE_AAD, 'utf8'));
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Invalid SSO exchange code');
}

export function sealSsoExchangeCode(
  payload: SsoExchangeTokenHandoff,
): Readonly<{ code: string; codeDigest: string }> {
  if (!isSsoExchangeTokenHandoff(payload)) {
    throw new Error('Invalid SSO token handoff');
  }
  const code = encryptSsoExchangePayload(JSON.stringify(payload));
  return Object.freeze({ code, codeDigest: digestSsoExchangeCode(code) });
}

export function openSsoExchangeCode(code: string): SsoExchangeTokenHandoff {
  const plaintext = decryptSsoExchangePayload(code);
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

// Reauthentication shares link-mode provider admission: `testing` is allowed,
// while `inactive` and generation mismatches remain terminal.
export type SsoProviderAuthorityMode = 'login' | 'link' | 'reauth';
export type SsoProviderAuthorityFailureReason =
  | 'provider_not_found'
  | 'provider_inactive'
  | 'provider_not_usable'
  | 'provider_version_missing'
  | 'provider_version_mismatch';

export function checkSsoProviderAuthority(
  provider: Readonly<{ status: string; configVersion: number }>,
  input: Readonly<{ providerVersion: number | null; mode: SsoProviderAuthorityMode }>,
): { ok: true } | { ok: false; reason: SsoProviderAuthorityFailureReason } {
  if (provider.status === 'inactive') return { ok: false, reason: 'provider_inactive' };
  if (input.mode === 'login' && provider.status !== 'active') {
    return { ok: false, reason: 'provider_not_usable' };
  }
  if (input.providerVersion === null) {
    return { ok: false, reason: 'provider_version_missing' };
  }
  if (input.providerVersion !== provider.configVersion) {
    return { ok: false, reason: 'provider_version_mismatch' };
  }
  return { ok: true };
}

/** Lock the provider after IdP work, at the route-specific end of auth lock order. */
export async function lockSsoProviderAuthority(
  tx: AuthLifecycleTransaction,
  input: Readonly<{
    providerId: string;
    providerVersion: number | null;
    mode: SsoProviderAuthorityMode;
  }>,
): Promise<{ ok: true } | { ok: false; reason: SsoProviderAuthorityFailureReason }> {
  const [provider] = await tx
    .select({ status: ssoProviders.status, configVersion: ssoProviders.configVersion })
    .from(ssoProviders)
    .where(eq(ssoProviders.id, input.providerId))
    .for('update')
    .limit(1);
  if (!provider) return { ok: false, reason: 'provider_not_found' };
  return checkSsoProviderAuthority(provider, input);
}

export async function withLockedSsoProviderAuthority<T>(
  input: Readonly<{
    providerId: string;
    providerVersion: number | null;
    mode: SsoProviderAuthorityMode;
  }>,
  callback: (tx: AuthLifecycleTransaction) => Promise<T>,
): Promise<
  | { ok: true; value: T }
  | { ok: false; reason: SsoProviderAuthorityFailureReason }
> {
  return withSsoSystemTransaction(async (tx) => {
    const authority = await lockSsoProviderAuthority(tx, input);
    if (!authority.ok) return authority;
    return { ok: true as const, value: await callback(tx) };
  });
}

export type ClaimedSsoCallback =
  | Readonly<{
      kind: 'link';
      session: typeof ssoSessions.$inferSelect;
    }>
  | Readonly<{
      kind: 'reauth';
      session: typeof ssoSessions.$inferSelect;
    }>
  | Readonly<{
      kind: 'login';
      session: typeof ssoSessions.$inferSelect;
      capability: AuthIssuanceCapability;
    }>;

/**
 * Claim callback state without spanning the IdP exchange. Login callbacks
 * reserve the persisted browser generation; link callbacks keep their existing
 * one-statement consume because they mint no Breeze session.
 */
export async function claimSsoCallbackIssuance(
  state: string,
): Promise<ClaimedSsoCallback | null> {
  // Link and re-auth callbacks never mint a Breeze login session. Consume
  // those modes atomically before looking for a browser-transition login so
  // they do not require (or accidentally reserve) login issuance authority.
  const [nonLogin] = await withSystemDbAccessContext(() =>
    db
      .delete(ssoSessions)
      .where(and(
        eq(ssoSessions.state, state),
        gt(ssoSessions.expiresAt, sql`now()`),
        or(isNotNull(ssoSessions.linkUserId), isNotNull(ssoSessions.reauthUserId)),
      ))
      .returning()
  );
  if (nonLogin) {
    return Object.freeze({
      kind: nonLogin.reauthUserId ? 'reauth' as const : 'link' as const,
      session: nonLogin,
    });
  }

  const [candidate] = await withSystemDbAccessContext(() =>
    db
      .select()
      .from(ssoSessions)
      .where(and(eq(ssoSessions.state, state), gt(ssoSessions.expiresAt, sql`now()`)))
      .limit(1)
  );
  if (!candidate) return null;

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
    if (!consumed) throw new SsoCallbackStateUnavailableError();
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

/** Consume one durable grant under transition -> user -> family -> grant locks. */
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

  const consumed = await withSsoSystemTransaction(async (tx) => {
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
