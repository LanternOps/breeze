import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { authBrowserTransitions } from '../db/schema/authBrowserTransitions';
import {
  withAuthLifecycleSystemTransaction,
  type AuthLifecycleTransaction,
} from './authLifecycle';

const AUTH_BINDING_PATTERN = /^[0-9a-f]{64}$/;
const AUTH_BINDING_HMAC_DOMAIN = 'auth-browser-binding:v1:';
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

function freshBinding(kind: AuthBindingSource['kind'] = 'browser'): AuthBindingSource {
  return Object.freeze({ kind, value: randomBytes(32).toString('hex') });
}

function bindingHmacKey(): string {
  const key = process.env.APP_ENCRYPTION_KEY?.trim();
  if (!key) {
    throw new Error('APP_ENCRYPTION_KEY is required for authentication binding HMACs');
  }
  return key;
}

/** Resolve a transport binding without persisting or returning the raw value. */
export function resolveAuthBinding(
  source: AuthBindingSource | null | undefined,
): ResolvedAuthBinding {
  if (!source) {
    throw new AuthBindingRotationRequiredError(freshBinding('browser'), 'missing');
  }
  if (!AUTH_BINDING_PATTERN.test(source.value)) {
    throw new AuthBindingRotationRequiredError(freshBinding(source.kind), 'invalid');
  }

  return Object.freeze({
    kind: source.kind,
    bindingDigest: createHmac('sha256', bindingHmacKey())
      .update(`${AUTH_BINDING_HMAC_DOMAIN}${source.value}`)
      .digest('hex'),
  });
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
  databaseNow: Date;
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

function isAfter(left: Date | null, right: Date): boolean {
  return left !== null && left.getTime() > right.getTime();
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
export async function rotateExpiredBinding(
  source: AuthBindingSource,
): Promise<AuthBindingSource> {
  const resolved = resolveAuthBinding(source);
  const replacement = await withAuthLifecycleSystemTransaction(async (tx) => {
    const transition = await lockTransitionByDigest(tx, resolved.bindingDigest);
    if (!transition) {
      throw new AuthBindingUnavailableError('missing');
    }

    if (transition.state === 'retired') {
      return freshBinding(source.kind);
    }
    if (
      transition.state === 'logout_pending'
      && transition.logoutExpiresAt !== null
      && !isAfter(transition.logoutExpiresAt, transition.databaseNow)
    ) {
      await retireExpiredTransition(tx, transition);
      return freshBinding(source.kind);
    }

    throw new AuthBindingUnavailableError(
      transition.state === 'logout_pending' ? 'logout_pending' : 'active',
    );
  });
  return replacement;
}

type AdmissionResult =
  | { kind: 'capability'; capability: AuthIssuanceCapability }
  | { kind: 'rotation'; replacement: AuthBindingSource; reason: 'expired' | 'retired' };

/** Reserve one short database-time lease without spanning verification or network work. */
export async function beginAuthIssuance(
  source: AuthBindingSource,
): Promise<AuthIssuanceCapability> {
  const resolved = resolveAuthBinding(source);
  const result = await withAuthLifecycleSystemTransaction<AdmissionResult>(async (tx) => {
    await tx
      .insert(authBrowserTransitions)
      .values({ bindingDigest: resolved.bindingDigest })
      .onConflictDoNothing({ target: authBrowserTransitions.bindingDigest });

    const transition = await lockTransitionByDigest(tx, resolved.bindingDigest);
    if (!transition) {
      throw new AuthIssuanceCapabilityError();
    }

    if (transition.state === 'retired') {
      return {
        kind: 'rotation',
        replacement: freshBinding(source.kind),
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
          replacement: freshBinding(source.kind),
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

function sameInstant(left: Date | null, right: Date): boolean {
  return left !== null && left.getTime() === right.getTime();
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
      || !sameInstant(transition.activeOperationExpiresAt, capability.expiresAt)
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
        eq(authBrowserTransitions.activeOperationExpiresAt, capability.expiresAt),
      ))
      .returning({ id: authBrowserTransitions.id });

    if (cleared.length !== 1) {
      throw new AuthIssuanceCapabilityError();
    }
    return result;
  });
}
