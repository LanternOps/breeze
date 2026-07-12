import { nanoid } from 'nanoid';
import { and, eq, isNull } from 'drizzle-orm';
import type { MfaMethod, MfaPrimaryMethod } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { userPasskeys, users } from '../db/schema';
import { resolveEffectiveMfaPolicy } from './mfaPolicy';
import { getRedis } from './redis';
import { issueUserSession } from './userSession';

const PENDING_MFA_TTL_SECONDS = 5 * 60;
const PENDING_MFA_TTL_MS = PENDING_MFA_TTL_SECONDS * 1000;
const PENDING_MFA_KEY_PREFIX = 'mfa:pending:';

const MFA_METHOD_ORDER: readonly MfaMethod[] = [
  'totp',
  'sms',
  'passkey',
  'recovery_code',
];
const MFA_PRIMARY_METHOD_ORDER: readonly MfaPrimaryMethod[] = ['totp', 'sms', 'passkey'];
const MFA_POLICY_SOURCE_ORDER = ['role', 'partner', 'organization'] as const;
const PRIMARY_AUTHENTICATION_METHODS = ['password', 'sso', 'cf_access'] as const;
const MFA_SCOPES = ['system', 'partner', 'organization'] as const;

type MfaPolicySource = typeof MFA_POLICY_SOURCE_ORDER[number];
type PrimaryAuthenticationMethod = typeof PRIMARY_AUTHENTICATION_METHODS[number];
type MfaScope = typeof MFA_SCOPES[number];

export interface CreatePendingMfaInput {
  userId: string;
  authEpoch: number;
  mfaEpoch: number;
  expectedStatus: 'active';
  roleId: string | null;
  orgId: string | null;
  partnerId: string | null;
  scope: MfaScope;
  policyRequired: boolean;
  policySources: readonly MfaPolicySource[];
  allowedMethods: ReadonlySet<MfaMethod>;
  enrolledMethods: ReadonlySet<MfaMethod>;
  primaryAuthenticationMethod: PrimaryAuthenticationMethod;
  primaryMfaMethod: MfaPrimaryMethod;
}

export interface PendingMfaSessionV2 {
  version: 2;
  userId: string;
  authEpoch: number;
  mfaEpoch: number;
  expectedStatus: 'active';
  roleId: string | null;
  orgId: string | null;
  partnerId: string | null;
  scope: MfaScope;
  policyRequired: boolean;
  policySources: MfaPolicySource[];
  allowedMethods: MfaMethod[];
  enrolledMethods: MfaMethod[];
  primaryAuthenticationMethod: PrimaryAuthenticationMethod;
  primaryMfaMethod: MfaPrimaryMethod;
  issuedAt: string;
  expiresAt: string;
}

export class PendingMfaUnavailableError extends Error {
  constructor(message = 'Pending MFA state is unavailable') {
    super(message);
    this.name = 'PendingMfaUnavailableError';
  }
}

export class PendingMfaInvalidError extends Error {
  constructor(message = 'Pending MFA state is invalid or expired') {
    super(message);
    this.name = 'PendingMfaInvalidError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === 'number' && value >= 0;
}

function hasExactKeys(value: Record<string, unknown>): boolean {
  const expected = [
    'allowedMethods',
    'authEpoch',
    'enrolledMethods',
    'expectedStatus',
    'expiresAt',
    'issuedAt',
    'mfaEpoch',
    'orgId',
    'partnerId',
    'policyRequired',
    'policySources',
    'primaryAuthenticationMethod',
    'primaryMfaMethod',
    'roleId',
    'scope',
    'userId',
    'version',
  ];
  return Object.keys(value).sort().join('\0') === expected.sort().join('\0');
}

function isExactOrderedSubset<T extends string>(
  value: unknown,
  order: readonly T[],
  options: { nonEmpty?: boolean } = {},
): value is T[] {
  if (!Array.isArray(value) || (options.nonEmpty === true && value.length === 0)) return false;
  if (!value.every((item): item is T => typeof item === 'string' && order.includes(item as T))) {
    return false;
  }
  if (new Set(value).size !== value.length) return false;
  const canonical = order.filter((item) => value.includes(item));
  return canonical.length === value.length && canonical.every((item, index) => item === value[index]);
}

function isExactIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function hasValidAuthorityAxes(value: {
  scope: MfaScope;
  roleId: string | null;
  orgId: string | null;
  partnerId: string | null;
}): boolean {
  if (value.scope === 'system') return value.orgId === null && value.partnerId === null;
  if (!value.roleId || !value.partnerId) return false;
  if (value.scope === 'partner') return value.orgId === null;
  return value.orgId !== null;
}

function parsePendingMfa(raw: string): PendingMfaSessionV2 | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(value) || !hasExactKeys(value)) return null;
  if (value.version !== 2
    || !isNonEmptyString(value.userId)
    || !isNonNegativeInteger(value.authEpoch)
    || !isNonNegativeInteger(value.mfaEpoch)
    || value.expectedStatus !== 'active'
    || !isNullableNonEmptyString(value.roleId)
    || !isNullableNonEmptyString(value.orgId)
    || !isNullableNonEmptyString(value.partnerId)
    || !MFA_SCOPES.includes(value.scope as MfaScope)
    || typeof value.policyRequired !== 'boolean'
    || !isExactOrderedSubset(value.policySources, MFA_POLICY_SOURCE_ORDER)
    || !isExactOrderedSubset(value.allowedMethods, MFA_METHOD_ORDER, { nonEmpty: true })
    || !isExactOrderedSubset(value.enrolledMethods, MFA_METHOD_ORDER, { nonEmpty: true })
    || !PRIMARY_AUTHENTICATION_METHODS.includes(value.primaryAuthenticationMethod as PrimaryAuthenticationMethod)
    || !MFA_PRIMARY_METHOD_ORDER.includes(value.primaryMfaMethod as MfaPrimaryMethod)
    || !isExactIsoDate(value.issuedAt)
    || !isExactIsoDate(value.expiresAt)) {
    return null;
  }

  const record = value as unknown as PendingMfaSessionV2;
  if (!hasValidAuthorityAxes(record)) return null;
  if (!record.allowedMethods.includes(record.primaryMfaMethod)
    || !record.enrolledMethods.includes(record.primaryMfaMethod)) {
    return null;
  }
  const issuedAt = Date.parse(record.issuedAt);
  const expiresAt = Date.parse(record.expiresAt);
  if (expiresAt - issuedAt !== PENDING_MFA_TTL_MS || issuedAt > Date.now() || expiresAt <= Date.now()) {
    return null;
  }
  return record;
}

function pendingMfaKey(tempToken: string): string {
  return `${PENDING_MFA_KEY_PREFIX}${tempToken}`;
}

function requireRedis() {
  const redis = getRedis();
  if (!redis) throw new PendingMfaUnavailableError();
  return redis;
}

function wrapRedisError(error: unknown): PendingMfaUnavailableError {
  if (error instanceof PendingMfaUnavailableError) return error;
  return new PendingMfaUnavailableError();
}

function canonicalSubset<T extends string>(values: ReadonlySet<T>, order: readonly T[]): T[] {
  return order.filter((value) => values.has(value));
}

export async function createPendingMfa(input: CreatePendingMfaInput): Promise<string> {
  const issuedAt = new Date();
  const record: PendingMfaSessionV2 = {
    version: 2,
    userId: input.userId,
    authEpoch: input.authEpoch,
    mfaEpoch: input.mfaEpoch,
    expectedStatus: input.expectedStatus,
    roleId: input.roleId,
    orgId: input.orgId,
    partnerId: input.partnerId,
    scope: input.scope,
    policyRequired: input.policyRequired,
    policySources: canonicalSubset(new Set(input.policySources), MFA_POLICY_SOURCE_ORDER),
    allowedMethods: canonicalSubset(input.allowedMethods, MFA_METHOD_ORDER),
    enrolledMethods: canonicalSubset(input.enrolledMethods, MFA_METHOD_ORDER),
    primaryAuthenticationMethod: input.primaryAuthenticationMethod,
    primaryMfaMethod: input.primaryMfaMethod,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + PENDING_MFA_TTL_MS).toISOString(),
  };
  if (!parsePendingMfa(JSON.stringify(record))) {
    throw new Error('Cannot create invalid pending MFA state');
  }

  const tempToken = nanoid(32);
  try {
    await requireRedis().setex(
      pendingMfaKey(tempToken),
      PENDING_MFA_TTL_SECONDS,
      JSON.stringify(record),
    );
  } catch (error) {
    throw wrapRedisError(error);
  }
  return tempToken;
}

export async function readPendingMfa(tempToken: string): Promise<PendingMfaSessionV2 | null> {
  try {
    const raw = await requireRedis().get(pendingMfaKey(tempToken));
    return raw === null ? null : parsePendingMfa(raw);
  } catch (error) {
    throw wrapRedisError(error);
  }
}

export async function consumePendingMfa(tempToken: string): Promise<PendingMfaSessionV2 | null> {
  try {
    const raw = await requireRedis().getdel(pendingMfaKey(tempToken));
    return raw === null ? null : parsePendingMfa(raw);
  } catch (error) {
    throw wrapRedisError(error);
  }
}

export function pendingMfaRecordsEqual(
  first: PendingMfaSessionV2,
  second: PendingMfaSessionV2,
): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

export interface IssueVerifiedPendingMfaSessionInput {
  tempToken: string;
  expectedPending: PendingMfaSessionV2;
  verifiedMethod: MfaPrimaryMethod;
  mobileDeviceId?: string;
}

export interface CreatePendingMfaForLoginInput {
  userId: string;
  roleId: string | null;
  orgId: string | null;
  partnerId: string | null;
  scope: MfaScope;
  primaryAuthenticationMethod: PrimaryAuthenticationMethod;
}

function deriveEnrolledMethods(
  user: {
    mfaEnabled: boolean;
    mfaMethod: string | null;
    mfaSecret: string | null;
    phoneNumber: string | null;
    phoneVerified: boolean;
    mfaRecoveryCodes?: unknown;
  },
  activePasskeyCount: number,
): Set<MfaMethod> {
  const enrolled = new Set<MfaMethod>();
  if (user.mfaEnabled && isNonEmptyString(user.mfaSecret)) enrolled.add('totp');
  if (user.mfaEnabled
    && user.mfaMethod === 'sms'
    && isNonEmptyString(user.phoneNumber)
    && user.phoneVerified) {
    enrolled.add('sms');
  }
  if (user.mfaEnabled && activePasskeyCount > 0) enrolled.add('passkey');
  if (user.mfaEnabled && user.mfaRecoveryCodes !== null && user.mfaRecoveryCodes !== undefined) {
    if (!Array.isArray(user.mfaRecoveryCodes)
      || !user.mfaRecoveryCodes.every((code) => isNonEmptyString(code))) {
      throw new PendingMfaInvalidError();
    }
    if (user.mfaRecoveryCodes.length > 0) enrolled.add('recovery_code');
  }
  return enrolled;
}

function derivePrimaryMfaMethod(user: { mfaMethod: string | null }): MfaPrimaryMethod | null {
  const method = user.mfaMethod ?? 'totp';
  return MFA_PRIMARY_METHOD_ORDER.includes(method as MfaPrimaryMethod)
    ? method as MfaPrimaryMethod
    : null;
}

function arraysEqual<T>(first: readonly T[], second: readonly T[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

async function loadPendingMfaLiveUserAndPasskeys(userId: string) {
  const [userRows, passkeyRows] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() => Promise.all([
      db
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
      db
        .select({ id: userPasskeys.id })
        .from(userPasskeys)
        .where(and(
          eq(userPasskeys.userId, userId),
          isNull(userPasskeys.disabledAt),
        ))
        .limit(100),
    ]))
  );
  return { user: userRows[0], activePasskeyCount: passkeyRows.length };
}

export async function createPendingMfaForLogin(input: CreatePendingMfaForLoginInput) {
  const [{ user, activePasskeyCount }, policy] = await Promise.all([
    loadPendingMfaLiveUserAndPasskeys(input.userId),
    resolveEffectiveMfaPolicy({
      userId: input.userId,
      roleId: input.roleId,
      orgId: input.orgId,
      partnerId: input.partnerId,
      scope: input.scope,
    }),
  ]);
  if (!user || user.id !== input.userId || user.status !== 'active' || user.mfaEnabled !== true) {
    throw new PendingMfaInvalidError();
  }

  const enrolledMethods = deriveEnrolledMethods(user, activePasskeyCount);
  const configuredPrimary = derivePrimaryMfaMethod(user);
  const primaryMfaMethod = configuredPrimary
    && enrolledMethods.has(configuredPrimary)
    && policy.allowedMethods.has(configuredPrimary)
    ? configuredPrimary
    : MFA_PRIMARY_METHOD_ORDER.find((method) => (
      enrolledMethods.has(method) && policy.allowedMethods.has(method)
    ));
  if (!primaryMfaMethod) throw new PendingMfaInvalidError();

  const createInput: CreatePendingMfaInput = {
    userId: user.id,
    authEpoch: user.authEpoch,
    mfaEpoch: user.mfaEpoch,
    expectedStatus: 'active',
    roleId: input.roleId,
    orgId: input.orgId,
    partnerId: input.partnerId,
    scope: input.scope,
    policyRequired: policy.required,
    policySources: policy.sources,
    allowedMethods: policy.allowedMethods,
    enrolledMethods,
    primaryAuthenticationMethod: input.primaryAuthenticationMethod,
    primaryMfaMethod,
  };
  const tempToken = await createPendingMfa(createInput);
  return {
    tempToken,
    primaryMfaMethod,
    passkeyAvailable: enrolledMethods.has('passkey') && policy.allowedMethods.has('passkey'),
    phoneLast4: primaryMfaMethod === 'sms' ? user.phoneNumber?.slice(-4) ?? null : null,
  };
}

/**
 * The only first-party post-factor user-session issuer. Factor verification is
 * intentionally completed by the caller first. This boundary then burns the
 * pending login atomically, proves it is the exact record previously read,
 * reloads every authority/assurance axis, and only then delegates token minting
 * to the Wave 1 issuer.
 */
export async function issueVerifiedPendingMfaSession(
  input: IssueVerifiedPendingMfaSessionInput,
) {
  const consumed = await consumePendingMfa(input.tempToken);
  if (!consumed || !pendingMfaRecordsEqual(consumed, input.expectedPending)) {
    throw new PendingMfaInvalidError();
  }

  const { user, activePasskeyCount } = await loadPendingMfaLiveUserAndPasskeys(consumed.userId);
  if (!user
    || user.id !== consumed.userId
    || user.status !== consumed.expectedStatus
    || user.authEpoch !== consumed.authEpoch
    || user.mfaEpoch !== consumed.mfaEpoch
    || user.mfaEnabled !== true) {
    throw new PendingMfaInvalidError();
  }

  let policy;
  try {
    policy = await resolveEffectiveMfaPolicy({
      userId: consumed.userId,
      roleId: consumed.roleId,
      orgId: consumed.orgId,
      partnerId: consumed.partnerId,
      scope: consumed.scope,
    });
  } catch {
    throw new PendingMfaInvalidError();
  }

  const currentAllowedMethods = canonicalSubset(policy.allowedMethods, MFA_METHOD_ORDER);
  const currentPolicySources = canonicalSubset(new Set(policy.sources), MFA_POLICY_SOURCE_ORDER);
  const currentEnrolledMethods = canonicalSubset(
    deriveEnrolledMethods(user, activePasskeyCount),
    MFA_METHOD_ORDER,
  );
  const currentPrimaryMfaMethod = derivePrimaryMfaMethod(user);
  if (policy.required !== consumed.policyRequired
    || !arraysEqual(currentPolicySources, consumed.policySources)
    || !arraysEqual(currentAllowedMethods, consumed.allowedMethods)
    || !arraysEqual(currentEnrolledMethods, consumed.enrolledMethods)
    || currentPrimaryMfaMethod !== consumed.primaryMfaMethod
    || !currentAllowedMethods.includes(input.verifiedMethod)
    || !currentEnrolledMethods.includes(input.verifiedMethod)) {
    throw new PendingMfaInvalidError();
  }

  const tokens = await issueUserSession({
    userId: user.id,
    email: user.email,
    roleId: consumed.roleId,
    orgId: consumed.orgId,
    partnerId: consumed.partnerId,
    scope: consumed.scope,
    mfa: true,
    amr: [consumed.primaryAuthenticationMethod, input.verifiedMethod],
    mobileDeviceId: input.mobileDeviceId,
  });

  return {
    user,
    tokens,
    authority: {
      roleId: consumed.roleId,
      orgId: consumed.orgId,
      partnerId: consumed.partnerId,
      scope: consumed.scope,
    },
  };
}
