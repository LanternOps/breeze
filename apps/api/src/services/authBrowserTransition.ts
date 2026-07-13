import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { authBrowserTransitions } from '../db/schema/authBrowserTransitions';
import {
  withAuthLifecycleSystemTransaction,
  type AuthLifecycleTransaction,
} from './authLifecycle';
import {
  getSecretDerivedKeyMaterials,
  type SecretDerivedKeyMaterial,
  type SecretDerivedKeyMaterials,
} from './secretCrypto';

const AUTH_BINDING_PATTERN = /^[0-9a-f]{64}$/;
const AUTH_BINDING_DERIVATION_DOMAIN = 'auth-browser-binding:v1';
const AUTH_BINDING_HMAC_DOMAIN = 'auth-browser-binding:v1:';
const AUTH_BINDING_VALUE_DOMAIN = 'auth-browser-binding-value:v1:';
const AUTH_BINDING_SUCCESSOR_DOMAIN = 'auth-browser-binding-successor:v1:';
const AUTH_ISSUANCE_LEASE_MINUTES = 2;
const AUTH_ISSUANCE_CAPABILITY: unique symbol = Symbol('AuthIssuanceCapability');

export type AuthBindingSource =
  | Readonly<{ kind: 'browser'; value: string }>
  | Readonly<{ kind: 'native'; value: string }>;

export type ResolvedAuthBinding = Readonly<{
  kind: AuthBindingSource['kind'];
  bindingDigest: string;
}>;

export type AuthIssuanceCapability = Readonly<{
  transitionId: string;
  generation: number;
  operationId: string;
  expiresAt: Date;
  [AUTH_ISSUANCE_CAPABILITY]: true;
}>;

type BindingRotationReason = 'missing' | 'invalid' | 'expired' | 'retired';

export class AuthBindingRotationRequiredError extends Error {
  readonly status = 428;

  constructor(
    readonly replacement: AuthBindingSource,
    readonly reason: BindingRotationReason,
  ) {
    super('A fresh authentication binding is required');
    this.name = 'AuthBindingRotationRequiredError';
  }
}

export class AuthBindingUnavailableError extends Error {
  readonly status = 409;

  constructor(readonly reason: 'active' | 'logout_pending' | 'missing') {
    super('The authentication binding is not available for issuance');
    this.name = 'AuthBindingUnavailableError';
  }
}

export class AuthIssuanceConflictError extends Error {
  readonly status = 409;
  readonly retryable = true;

  constructor() {
    super('Another authentication issuance operation is in progress');
    this.name = 'AuthIssuanceConflictError';
  }
}

export class AuthIssuanceCapabilityError extends Error {
  readonly status = 409;

  constructor() {
    super('The authentication issuance capability is no longer valid');
    this.name = 'AuthIssuanceCapabilityError';
  }
}

type BindingCandidate = SecretDerivedKeyMaterial & { bindingDigest: string };

type BindingResolution = Readonly<{
  kind: AuthBindingSource['kind'];
  canonicalDigest: string;
  candidates: readonly BindingCandidate[];
}>;

function bindingDigest(value: string, key: Buffer): string {
  return createHmac('sha256', key)
    .update(`${AUTH_BINDING_HMAC_DOMAIN}${value}`)
    .digest('hex');
}

function bindingValueTag(
  kind: AuthBindingSource['kind'],
  payload: string,
  key: Buffer,
): string {
  return createHmac('sha256', key)
    .update(`${AUTH_BINDING_VALUE_DOMAIN}${kind}:${payload}`)
    .digest('hex')
    .slice(0, 32);
}

function bindingTagMatches(
  source: AuthBindingSource,
  material: SecretDerivedKeyMaterial,
): boolean {
  const payload = source.value.slice(0, 32);
  const suppliedTag = Buffer.from(source.value.slice(32), 'hex');
  const expectedTag = Buffer.from(bindingValueTag(source.kind, payload, material.key), 'hex');
  return suppliedTag.length === expectedTag.length && timingSafeEqual(suppliedTag, expectedTag);
}

function bindingResolution(
  source: AuthBindingSource,
  keyMaterials: SecretDerivedKeyMaterials,
): BindingResolution {
  const validatingKeys = keyMaterials.retained.filter((material) =>
    bindingTagMatches(source, material),
  );
  if (validatingKeys.length !== 1) {
    throw new AuthBindingRotationRequiredError(
      freshBinding(source.kind, keyMaterials),
      'invalid',
    );
  }
  const signer = validatingKeys[0]!;
  const byDigest = new Map<string, BindingCandidate>();
  for (const material of keyMaterials.retained) {
    const digest = bindingDigest(source.value, material.key);
    if (!byDigest.has(digest)) {
      byDigest.set(digest, { ...material, bindingDigest: digest });
    }
  }
  return Object.freeze({
    kind: source.kind,
    canonicalDigest: bindingDigest(source.value, signer.key),
    candidates: Object.freeze([...byDigest.values()]),
  });
}

function freshBinding(
  kind: AuthBindingSource['kind'],
  keyMaterials: SecretDerivedKeyMaterials,
): AuthBindingSource {
  const payload = randomBytes(16).toString('hex');
  return Object.freeze({
    kind,
    value: `${payload}${bindingValueTag(kind, payload, keyMaterials.active.key)}`,
  });
}

function resolveAuthBindingWithMaterials(
  source: AuthBindingSource | null | undefined,
  keyMaterials: SecretDerivedKeyMaterials,
): ResolvedAuthBinding {
  if (!source) {
    throw new AuthBindingRotationRequiredError(freshBinding('browser', keyMaterials), 'missing');
  }
  if (!AUTH_BINDING_PATTERN.test(source.value)) {
    throw new AuthBindingRotationRequiredError(freshBinding(source.kind, keyMaterials), 'invalid');
  }

  const resolved = bindingResolution(source, keyMaterials);
  return Object.freeze({ kind: source.kind, bindingDigest: resolved.canonicalDigest });
}

const lockedTransitionFields = {
  id: authBrowserTransitions.id,
  bindingDigest: authBrowserTransitions.bindingDigest,
  generation: authBrowserTransitions.generation,
  state: authBrowserTransitions.state,
  activeOperationId: authBrowserTransitions.activeOperationId,
  activeOperationExpiresAt: authBrowserTransitions.activeOperationExpiresAt,
  logoutExpiresAt: authBrowserTransitions.logoutExpiresAt,
  databaseNow: sql<Date>`now()`,
};

type LockedTransition = {
  id: string;
  bindingDigest: string;
  generation: number;
  state: 'active' | 'logout_pending' | 'retired';
  activeOperationId: string | null;
  activeOperationExpiresAt: Date | null;
  logoutExpiresAt: Date | null;
  databaseNow: Date | string;
};

async function lockTransitionByDigest(
  tx: AuthLifecycleTransaction,
  bindingDigest: string,
): Promise<LockedTransition | undefined> {
  const [transition] = await tx
    .select(lockedTransitionFields)
    .from(authBrowserTransitions)
    .where(eq(authBrowserTransitions.bindingDigest, bindingDigest))
    .for('update')
    .limit(1);
  return transition;
}

async function lockTransitionForResolution(
  tx: AuthLifecycleTransaction,
  resolution: BindingResolution,
): Promise<{ transition: LockedTransition; matchedKey: SecretDerivedKeyMaterial } | undefined> {
  let match: { transition: LockedTransition; matchedKey: SecretDerivedKeyMaterial } | undefined;
  const candidates = [...resolution.candidates]
    .sort((left, right) => left.bindingDigest.localeCompare(right.bindingDigest));
  for (const candidate of candidates) {
    const transition = await lockTransitionByDigest(tx, candidate.bindingDigest);
    if (!transition) continue;
    if (match && match.transition.id !== transition.id) {
      throw new AuthIssuanceCapabilityError();
    }
    match = { transition, matchedKey: { keyId: candidate.keyId, key: candidate.key } };
  }
  return match;
}

async function lockTransitionById(
  tx: AuthLifecycleTransaction,
  transitionId: string,
): Promise<LockedTransition | undefined> {
  const [transition] = await tx
    .select(lockedTransitionFields)
    .from(authBrowserTransitions)
    .where(eq(authBrowserTransitions.id, transitionId))
    .for('update')
    .limit(1);
  return transition;
}

function instantMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function isAfter(left: Date | null, right: Date | string): boolean {
  return left !== null && left.getTime() > instantMillis(right);
}

async function retireExpiredTransition(
  tx: AuthLifecycleTransaction,
  transition: LockedTransition,
): Promise<void> {
  const retired = await tx
    .update(authBrowserTransitions)
    .set({
      state: 'retired',
      activeOperationId: null,
      activeOperationExpiresAt: null,
      retiredAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(
      eq(authBrowserTransitions.id, transition.id),
      eq(authBrowserTransitions.generation, transition.generation),
      eq(authBrowserTransitions.state, 'logout_pending'),
    ))
    .returning({ id: authBrowserTransitions.id });

  if (retired.length !== 1) {
    throw new AuthIssuanceCapabilityError();
  }
}

/**
 * Retire an expired pending binding (or acknowledge an already-retired one)
 * and return a fresh transport value. The old digest is never reopened.
 */
async function rotateExpiredBindingWithMaterials(
  source: AuthBindingSource,
  keyMaterials: SecretDerivedKeyMaterials,
): Promise<AuthBindingSource> {
  if (!AUTH_BINDING_PATTERN.test(source.value)) {
    throw new AuthBindingRotationRequiredError(freshBinding(source.kind, keyMaterials), 'invalid');
  }
  const resolution = bindingResolution(source, keyMaterials);
  const replacement = await withAuthLifecycleSystemTransaction(async (tx) => {
    const locked = await lockTransitionForResolution(tx, resolution);
    if (!locked) {
      throw new AuthBindingUnavailableError('missing');
    }
    const { transition, matchedKey } = locked;

    if (transition.state === 'retired') {
      return ensureSuccessorTransition(tx, source.kind, transition, matchedKey, keyMaterials);
    }
    if (
      transition.state === 'logout_pending'
      && transition.logoutExpiresAt !== null
      && !isAfter(transition.logoutExpiresAt, transition.databaseNow)
    ) {
      await retireExpiredTransition(tx, transition);
      return ensureSuccessorTransition(tx, source.kind, transition, matchedKey, keyMaterials);
    }

    throw new AuthBindingUnavailableError(
      transition.state === 'logout_pending' ? 'logout_pending' : 'active',
    );
  });
  return replacement;
}

function deterministicSuccessorBinding(
  kind: AuthBindingSource['kind'],
  transition: Pick<LockedTransition, 'id' | 'generation'>,
  matchedKey: SecretDerivedKeyMaterial,
): AuthBindingSource {
  const payload = createHmac('sha256', matchedKey.key)
    .update(`${AUTH_BINDING_SUCCESSOR_DOMAIN}${kind}:${transition.id}:${transition.generation}`)
    .digest('hex')
    .slice(0, 32);
  return Object.freeze({
    kind,
    value: `${payload}${bindingValueTag(kind, payload, matchedKey.key)}`,
  });
}

async function ensureSuccessorTransition(
  tx: AuthLifecycleTransaction,
  kind: AuthBindingSource['kind'],
  predecessor: LockedTransition,
  matchedKey: SecretDerivedKeyMaterial,
  keyMaterials: SecretDerivedKeyMaterials,
): Promise<AuthBindingSource> {
  const replacement = deterministicSuccessorBinding(kind, predecessor, matchedKey);
  const resolution = bindingResolution(replacement, keyMaterials);
  let successor = await lockTransitionForResolution(tx, resolution);
  if (!successor) {
    await tx
      .insert(authBrowserTransitions)
      .values({ bindingDigest: resolution.canonicalDigest })
      .onConflictDoNothing({ target: authBrowserTransitions.bindingDigest });
    successor = await lockTransitionForResolution(tx, resolution);
  }
  if (!successor || successor.transition.id === predecessor.id) {
    throw new AuthIssuanceCapabilityError();
  }
  return replacement;
}

type AdmissionResult =
  | { kind: 'capability'; capability: AuthIssuanceCapability }
  | { kind: 'rotation'; replacement: AuthBindingSource; reason: 'expired' | 'retired' | 'invalid' };

/** Reserve one short database-time lease without spanning verification or network work. */
async function beginAuthIssuanceWithMaterials(
  source: AuthBindingSource,
  keyMaterials: SecretDerivedKeyMaterials,
): Promise<AuthIssuanceCapability> {
  if (!AUTH_BINDING_PATTERN.test(source.value)) {
    throw new AuthBindingRotationRequiredError(freshBinding(source.kind, keyMaterials), 'invalid');
  }
  const resolution = bindingResolution(source, keyMaterials);
  const result = await withAuthLifecycleSystemTransaction<AdmissionResult>(async (tx) => {
    let locked = await lockTransitionForResolution(tx, resolution);
    if (!locked) {
      await tx
        .insert(authBrowserTransitions)
        .values({ bindingDigest: resolution.canonicalDigest })
        .onConflictDoNothing({ target: authBrowserTransitions.bindingDigest });
      locked = await lockTransitionForResolution(tx, resolution);
      if (!locked) {
        throw new AuthIssuanceCapabilityError();
      }
    }
    const { transition, matchedKey } = locked;

    if (transition.state === 'retired') {
      return {
        kind: 'rotation',
        replacement: await ensureSuccessorTransition(
          tx,
          source.kind,
          transition,
          matchedKey,
          keyMaterials,
        ),
        reason: 'retired',
      };
    }

    if (transition.state === 'logout_pending') {
      if (
        transition.logoutExpiresAt !== null
        && !isAfter(transition.logoutExpiresAt, transition.databaseNow)
      ) {
        await retireExpiredTransition(tx, transition);
        return {
          kind: 'rotation',
          replacement: await ensureSuccessorTransition(
            tx,
            source.kind,
            transition,
            matchedKey,
            keyMaterials,
          ),
          reason: 'expired',
        };
      }
      throw new AuthBindingUnavailableError('logout_pending');
    }

    if (
      transition.activeOperationId !== null
      && isAfter(transition.activeOperationExpiresAt, transition.databaseNow)
    ) {
      throw new AuthIssuanceConflictError();
    }

    const operationId = randomUUID();
    const [reserved] = await tx
      .update(authBrowserTransitions)
      .set({
        activeOperationId: operationId,
        activeOperationExpiresAt:
          sql`now() + ${AUTH_ISSUANCE_LEASE_MINUTES} * interval '1 minute'`,
        updatedAt: sql`now()`,
      })
      .where(and(
        eq(authBrowserTransitions.id, transition.id),
        eq(authBrowserTransitions.generation, transition.generation),
        eq(authBrowserTransitions.state, 'active'),
      ))
      .returning({
        expiresAt: authBrowserTransitions.activeOperationExpiresAt,
      });

    if (!reserved?.expiresAt) {
      throw new AuthIssuanceCapabilityError();
    }

    const capability: AuthIssuanceCapability = Object.freeze({
      transitionId: transition.id,
      generation: transition.generation,
      operationId,
      expiresAt: new Date(reserved.expiresAt),
      [AUTH_ISSUANCE_CAPABILITY]: true as const,
    });
    return { kind: 'capability', capability };
  });

  if (result.kind === 'rotation') {
    throw new AuthBindingRotationRequiredError(result.replacement, result.reason);
  }
  return result.capability;
}

export type AuthBindingKeyProvider = () => SecretDerivedKeyMaterials;

export interface AuthBrowserTransitionService {
  resolveAuthBinding(
    source: AuthBindingSource | null | undefined,
  ): ResolvedAuthBinding;
  rotateExpiredBinding(source: AuthBindingSource): Promise<AuthBindingSource>;
  beginAuthIssuance(source: AuthBindingSource): Promise<AuthIssuanceCapability>;
}

function defaultAuthBindingKeyProvider(): SecretDerivedKeyMaterials {
  return getSecretDerivedKeyMaterials(AUTH_BINDING_DERIVATION_DOMAIN);
}

export function createAuthBrowserTransitionService(
  keyProvider: AuthBindingKeyProvider = defaultAuthBindingKeyProvider,
): AuthBrowserTransitionService {
  return Object.freeze({
    resolveAuthBinding: (source: AuthBindingSource | null | undefined) =>
      resolveAuthBindingWithMaterials(source, keyProvider()),
    rotateExpiredBinding: (source: AuthBindingSource) =>
      rotateExpiredBindingWithMaterials(source, keyProvider()),
    beginAuthIssuance: (source: AuthBindingSource) =>
      beginAuthIssuanceWithMaterials(source, keyProvider()),
  });
}

const defaultAuthBrowserTransitionService = createAuthBrowserTransitionService();

/** Resolve a transport binding without persisting or returning the raw value. */
export function resolveAuthBinding(
  source: AuthBindingSource | null | undefined,
): ResolvedAuthBinding {
  return defaultAuthBrowserTransitionService.resolveAuthBinding(source);
}

export function rotateExpiredBinding(source: AuthBindingSource): Promise<AuthBindingSource> {
  return defaultAuthBrowserTransitionService.rotateExpiredBinding(source);
}

/** Reserve one short database-time lease without spanning verification or network work. */
export function beginAuthIssuance(source: AuthBindingSource): Promise<AuthIssuanceCapability> {
  return defaultAuthBrowserTransitionService.beginAuthIssuance(source);
}

function assertCapabilityBrand(
  capability: AuthIssuanceCapability,
): asserts capability is AuthIssuanceCapability {
  if (
    !capability
    || typeof capability !== 'object'
    || capability[AUTH_ISSUANCE_CAPABILITY] !== true
  ) {
    throw new AuthIssuanceCapabilityError();
  }
}

/**
 * Runtime guard for session issuers. The transaction is supplied by
 * `finishAuthIssuance`, so this re-check observes (and retains) the transition
 * lock before any user or refresh-family row is locked.
 */
export async function assertAuthIssuanceCapability(
  tx: AuthLifecycleTransaction,
  capability: AuthIssuanceCapability,
): Promise<void> {
  assertCapabilityBrand(capability);
  const transition = await lockTransitionById(tx, capability.transitionId);
  if (
    !transition
    || transition.state !== 'active'
    || transition.generation !== capability.generation
    || transition.activeOperationId !== capability.operationId
    || !isAfter(transition.activeOperationExpiresAt, transition.databaseNow)
  ) {
    throw new AuthIssuanceCapabilityError();
  }
}

/** Link the guarded binding to the exact session family before commit. */
export async function bindAuthIssuanceSession(
  tx: AuthLifecycleTransaction,
  capability: AuthIssuanceCapability,
  userId: string,
  familyId: string,
): Promise<void> {
  assertCapabilityBrand(capability);
  const bound = await tx
    .update(authBrowserTransitions)
    .set({
      currentUserId: userId,
      currentFamilyId: familyId,
      updatedAt: sql`now()`,
    })
    .where(and(
      eq(authBrowserTransitions.id, capability.transitionId),
      eq(authBrowserTransitions.generation, capability.generation),
      eq(authBrowserTransitions.state, 'active'),
      eq(authBrowserTransitions.activeOperationId, capability.operationId),
    ))
    .returning({ id: authBrowserTransitions.id });
  if (bound.length !== 1) throw new AuthIssuanceCapabilityError();
}

/**
 * Best-effort abandonment for a capability whose authority transaction did
 * not commit. The exact generation and operation CAS prevents a stale owner
 * from clearing a successor lease or a retired transition.
 */
export async function cancelAuthIssuance(
  capability: AuthIssuanceCapability,
): Promise<boolean> {
  assertCapabilityBrand(capability);
  return withAuthLifecycleSystemTransaction(async (tx) => {
    const cleared = await tx
      .update(authBrowserTransitions)
      .set({
        activeOperationId: null,
        activeOperationExpiresAt: null,
        updatedAt: sql`now()`,
      })
      .where(and(
        eq(authBrowserTransitions.id, capability.transitionId),
        eq(authBrowserTransitions.generation, capability.generation),
        eq(authBrowserTransitions.state, 'active'),
        eq(authBrowserTransitions.activeOperationId, capability.operationId),
      ))
      .returning({ id: authBrowserTransitions.id });
    return cleared.length === 1;
  });
}

/**
 * Recheck exact lease ownership before invoking a database-only callback. The
 * callback and operation clearing commit or roll back in one system transaction.
 */
export async function finishAuthIssuance<T>(
  capability: AuthIssuanceCapability,
  callback: (tx: AuthLifecycleTransaction) => Promise<T>,
): Promise<T> {
  assertCapabilityBrand(capability);

  return withAuthLifecycleSystemTransaction(async (tx) => {
    const transition = await lockTransitionById(tx, capability.transitionId);
    if (
      !transition
      || transition.state !== 'active'
      || transition.generation !== capability.generation
      || transition.activeOperationId !== capability.operationId
      || !isAfter(transition.activeOperationExpiresAt, transition.databaseNow)
    ) {
      throw new AuthIssuanceCapabilityError();
    }

    const result = await callback(tx);
    const cleared = await tx
      .update(authBrowserTransitions)
      .set({
        activeOperationId: null,
        activeOperationExpiresAt: null,
        updatedAt: sql`now()`,
      })
      .where(and(
        eq(authBrowserTransitions.id, capability.transitionId),
        eq(authBrowserTransitions.generation, capability.generation),
        eq(authBrowserTransitions.state, 'active'),
        eq(authBrowserTransitions.activeOperationId, capability.operationId),
      ))
      .returning({ id: authBrowserTransitions.id });

    if (cleared.length !== 1) {
      throw new AuthIssuanceCapabilityError();
    }
    return result;
  });
}
