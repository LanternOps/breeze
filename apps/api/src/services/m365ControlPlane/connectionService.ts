import { randomUUID } from 'node:crypto';
import {
  canonicalGrantKey,
  M365_PERMISSION_PROFILES,
  type CanonicalAppRoleAssignment,
  type M365ConnectionProfile,
  type M365PermissionProfileManifest,
  type RetestRequest,
  type RetestResult,
} from '@breeze/shared/m365';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { m365Connections, type M365ConnectionRow, type M365ConnectionStatus } from '../../db/schema';
import { dbAccessContextFromAuth, type AuthContext } from '../../middleware/auth';
import type { M365ConsentBrowserBinding } from './browserBinding';
import {
  consumeConsentSessionInTransaction,
  consumeTenantConfirmationSessionInTransaction,
  createIdentitySessionInTransaction,
  deleteConsentSessionsForAttemptInTransaction,
  deleteConsentSessionsForConnection,
  insertVerifiedConsentSessionInTransaction,
  readTenantConfirmationSessionInTransaction,
  verifiedIdentityFromSession,
  type M365ConsentPurpose,
  type M365ConsentSessionProfile,
  type VerifiedConsentIdentity,
} from './consentSessionService';
import {
  buildMicrosoftIdentityAuthorizationUrl,
  buildMicrosoftTenantAdminConsentUrl,
} from './microsoftAuthorization';
import {
  createGraphReadExecutorClient,
  type GraphReadExecutorClient,
} from './graphReadExecutorClient';
import { loadM365CustomerGraphReadRuntimeConfig } from './runtimeConfig';
import { onConnectionDisconnected } from '../m365Sync/lifecycle';

const EXECUTABLE_STATUSES = ['active', 'degraded'] as const;
const CALLBACK_STATUSES = ['pending-consent', 'verifying'] as const;

function lockKey(orgId: string, profile: string) {
  return sql`select pg_advisory_xact_lock(hashtextextended(${`${orgId}/${profile}`}, 0))`;
}

export type GrantHealthState =
  | 'active'
  | 'degraded'
  | 'missing'
  | 'unexpected'
  | 'both'
  | 'manifest-stale';

export interface GrantHealth {
  state: GrantHealthState;
  requiredGrants: CanonicalAppRoleAssignment[];
  observedGrants: CanonicalAppRoleAssignment[];
  missingGrants: CanonicalAppRoleAssignment[];
  unexpectedGrants: CanonicalAppRoleAssignment[];
}

/**
 * Profile-parameterized lifecycle snapshot. The read and actions consent
 * surfaces are the same shape narrowed to a single profile literal.
 */
export type M365ConnectionSnapshot<P extends M365ConnectionProfile = M365ConnectionProfile> = Pick<
  M365ConnectionRow,
  | 'id'
  | 'orgId'
  | 'tenantId'
  | 'clientId'
  | 'profile'
  | 'permissionManifestVersion'
  | 'observedGrants'
  | 'consentAttemptId'
  | 'grantsVerifiedAt'
  | 'displayName'
  | 'status'
  | 'lastVerifiedAt'
  | 'lastErrorCode'
> & {
  orgId: string;
  profile: P;
  consentAttemptId: string;
};

export type CustomerGraphReadConnectionSnapshot = M365ConnectionSnapshot<'customer-graph-read'>;

export interface M365ConsentAttemptSnapshot<P extends M365ConnectionProfile = M365ConnectionProfile> {
  id: string;
  orgId: string;
  profile: P;
  consentAttemptId: string;
  status: M365ConnectionStatus;
}

export type ConsentAttemptSnapshot = M365ConsentAttemptSnapshot<'customer-graph-read'>;

export interface M365RetestSnapshot<P extends M365ConnectionProfile = M365ConnectionProfile>
  extends M365ConnectionSnapshot<P> {
  tenantId: string;
  status: 'active' | 'degraded';
  /** Exact caller scope used to reopen the short CAS write transaction. */
  auth: AuthContext;
}

export type RetestSnapshot = M365RetestSnapshot<'customer-graph-read'>;

/**
 * Outcome of an upgrade-consent apply.
 *
 * `failureCode` exists because every failure branch of an upgrade is a
 * deliberate NO-OP on the row (that is the whole point: a cancelled or
 * mis-tenanted upgrade must leave a live connection exactly as it was). With
 * nothing written, the caller could not otherwise tell "the administrator
 * never came back" from "the administrator consented the WRONG TENANT" — both
 * would surface as the same generic manifest-stale redirect and, worse, as a
 * `tenant_binding_verified` audit event. The reason is therefore returned in
 * band instead of being persisted.
 */
export interface AppliedUpgradeVerification<P extends M365ConnectionProfile = M365ConnectionProfile> {
  connection: M365ConnectionSnapshot<P>;
  /** null when the manifest was promoted; otherwise why it was not. */
  failureCode: string | null;
}

export type ConnectionLifecycleErrorCode =
  | 'connection_not_found'
  | 'connection_not_executable'
  | 'stale_attempt'
  | 'tenant_already_bound'
  | 'tenant_mismatch'
  | 'manifest_current';

export class ConnectionLifecycleError extends Error {
  constructor(readonly code: ConnectionLifecycleErrorCode) {
    super(code);
    this.name = 'ConnectionLifecycleError';
  }
}

function lifecycleError(code: ConnectionLifecycleErrorCode): ConnectionLifecycleError {
  return new ConnectionLifecycleError(code);
}

function requiredGrants(
  manifest: M365PermissionProfileManifest,
): CanonicalAppRoleAssignment[] {
  return [...(manifest.applicationPermissionAssignments ?? [])];
}

export function deriveGrantHealth(
  row: Pick<
    CustomerGraphReadConnectionSnapshot,
    | 'status'
    | 'permissionManifestVersion'
    | 'observedGrants'
    | 'grantsVerifiedAt'
    | 'lastErrorCode'
  >,
  currentManifest: M365PermissionProfileManifest,
): GrantHealth {
  const required = requiredGrants(currentManifest);
  const requiredKeys = new Set(required.map(canonicalGrantKey));
  const observedKeys = new Set(row.observedGrants.map(canonicalGrantKey));
  const hasAuthoritativeObservation = row.grantsVerifiedAt !== null;
  const missingGrants = hasAuthoritativeObservation
    ? required.filter((grant) => !observedKeys.has(canonicalGrantKey(grant)))
    : [];
  const unexpectedGrants = hasAuthoritativeObservation
    ? row.observedGrants.filter((grant) => !requiredKeys.has(canonicalGrantKey(grant)))
    : [];

  let state: GrantHealthState;
  if (row.permissionManifestVersion !== currentManifest.version) state = 'manifest-stale';
  else if (row.grantsVerifiedAt === null || row.lastErrorCode === 'grant_reconciliation_unavailable') {
    state = 'degraded';
  }
  else if (missingGrants.length > 0 && unexpectedGrants.length > 0) state = 'both';
  else if (missingGrants.length > 0) state = 'missing';
  else if (unexpectedGrants.length > 0) state = 'unexpected';
  else if (row.status === 'active' && row.grantsVerifiedAt !== null) state = 'active';
  else state = 'degraded';

  return {
    state,
    requiredGrants: required,
    observedGrants: [...row.observedGrants],
    missingGrants,
    unexpectedGrants,
  };
}

function postgresCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string') return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

function bindingError(error: unknown): never {
  if (postgresCode(error) === '23505') throw lifecycleError('tenant_already_bound');
  throw error;
}

function lifecycleErrorForHealth(health: GrantHealth): string | null {
  if (health.state === 'manifest-stale') return 'manifest_stale';
  if (health.missingGrants.length > 0) return 'grant_missing';
  if (health.unexpectedGrants.length > 0) return 'grant_unexpected';
  return null;
}

/**
 * Minimal runtime-config shape the connection lifecycle reads directly. Executor
 * construction (which needs more fields) is delegated to `createExecutorClient`,
 * so per-profile configs may be arbitrarily wider than this.
 */
export interface ConnectionRuntimeConfig {
  clientId: string;
  callbackUrl: string;
  vaultRef: string;
  credentialVersion: string;
}

export interface ConnectionServiceDeps<
  P extends M365ConsentSessionProfile,
  Config extends ConnectionRuntimeConfig,
  Client,
> {
  profile: P;
  manifest: M365PermissionProfileManifest;
  loadRuntimeConfig: () => Config;
  createExecutorClient: (config: Config) => Client;
  /** Adapts a profile-specific executor client to the generic retest call. */
  retest: (client: Client, request: RetestRequest) => Promise<RetestResult>;
  /**
   * Optional observability hooks. The connection lifecycle itself records
   * nothing today (metrics are emitted by the route handlers), so these are
   * unused by the read surface and reserved for callers that record inline.
   */
  recordEvent?: (...args: unknown[]) => void;
  recordMetric?: (...args: unknown[]) => void;
}

export interface InitiateConsentInput {
  orgId: string;
  actorId: string;
}

export interface InitiateUpgradeConsentInput {
  connectionId: string;
  orgId: string;
  /**
   * The caller's exact scope. The connection is loaded under it so RLS — not
   * an app-layer org comparison — is what proves the caller may touch this
   * row, mirroring loadRetestSnapshot.
   */
  auth: AuthContext;
}

/**
 * Identity-first consent (#7910): initiate returns the phase-1 identity
 * sign-in URL and the browser binding the route sets as a cookie.
 */
export interface InitiatedConsent<P extends M365ConnectionProfile = M365ConnectionProfile> {
  connection: M365ConnectionSnapshot<P>;
  /** phase `identity_verification`; tenantId = pinned authority or null for /organizations. */
  binding: M365ConsentBrowserBinding;
  /** v2 OIDC + PKCE authorize URL at /organizations or the bound tenant. */
  authorizationUrl: string;
}

/**
 * Confirm-tenant interstitial (#7913 W03). The caller is the Breeze user who
 * started the attempt; the org has already been resolved and authorized by
 * the route. Nothing here accepts a tenant: the tenant only ever comes from
 * the server-side session the identity callback parked.
 */
export interface TenantConfirmationInput {
  orgId: string;
  actorId: string;
}

/** What the confirm-tenant screen shows. Display only — never authority. */
export interface PendingTenantConfirmation {
  tenantId: string;
  /** Display-only username from the verified id_token; may be null. */
  administratorUsername: string | null;
  expiresAt: Date;
}

export interface ContinuedToConsent<P extends M365ConnectionProfile = M365ConnectionProfile> {
  connection: M365ConnectionSnapshot<P>;
  /** phase `admin_consent`, tenant = the verified tenant, under a NEW one-use state. */
  binding: M365ConsentBrowserBinding;
  /** v1 tenant-pinned admin-consent URL for the verified tenant. */
  consentUrl: string;
  verifiedTenantId: string;
  verifiedAdministratorObjectId: string;
}

/** The attempt the second callback resumes, after its consent session is consumed. */
export interface StartedConsentFinalization<P extends M365ConnectionProfile = M365ConnectionProfile> {
  /** `verifying` for a first-time consent; unchanged (executable) for an upgrade. */
  attempt: M365ConsentAttemptSnapshot<P>;
  purpose: M365ConsentPurpose;
  verified: VerifiedConsentIdentity;
  /** The Breeze user who initiated the attempt (the session owner). */
  actorId: string;
}

/** Executor application-token proof against the tenant verified in phase 1. */
export interface ConsentFinalization {
  verifiedTenantId: string;
  result: RetestResult;
}

export interface ConnectionService<P extends M365ConsentSessionProfile, Client> {
  initiateConsent(input: InitiateConsentInput): Promise<InitiatedConsent<P>>;
  initiateUpgradeConsent(input: InitiateUpgradeConsentInput): Promise<InitiatedConsent<P>>;
  listConnections(orgId: string): Promise<Array<M365ConnectionSnapshot<P> & { grantHealth: GrantHealth }>>;
  /**
   * Identity verified → continue to tenant-pinned admin consent. Mints the
   * post-identity session under a rotated state. Writes nothing to the
   * connection row: no consent has been given yet.
   */
  transitionIdentityToConsent(input: {
    attempt: M365ConsentAttemptSnapshot<P>;
    purpose: M365ConsentPurpose;
    actorId: string;
    verified: VerifiedConsentIdentity;
    nextPhase: 'admin_consent' | 'tenant_confirmation';
  }): Promise<{ rawState: string; verifiedTenantId: string }>;
  /** The parked confirm-tenant session for this user's current attempt, or null. */
  readPendingTenantConfirmation(input: TenantConfirmationInput): Promise<PendingTenantConfirmation | null>;
  /** Operator confirmed the verified tenant → mint the admin-consent session + URL. One-shot. */
  continueToConsent(input: TenantConfirmationInput): Promise<ContinuedToConsent<P>>;
  /** Operator rejected the verified tenant → consume the park, record consent_cancelled. */
  cancelTenantConfirmation(input: TenantConfirmationInput): Promise<M365ConnectionSnapshot<P>>;
  markConsentAttemptFailed(
    input: M365ConsentAttemptSnapshot<P>,
    errorCode: string,
  ): Promise<M365ConnectionSnapshot<P>>;
  /** Consent returned → consume the consent session; first-time: pending-consent → verifying. */
  beginConsentFinalization(input: {
    attempt: M365ConsentAttemptSnapshot<P>;
    rawConsentState: string;
  }): Promise<StartedConsentFinalization<P>>;
  applyConsentFinalizationResult(
    input: M365ConsentAttemptSnapshot<P>,
    finalization: ConsentFinalization,
  ): Promise<M365ConnectionSnapshot<P>>;
  applyUpgradeFinalizationResult(
    input: M365ConsentAttemptSnapshot<P>,
    finalization: ConsentFinalization,
  ): Promise<AppliedUpgradeVerification<P>>;
  loadRetestSnapshot(input: {
    id: string;
    orgId: string;
    auth: AuthContext;
  }): Promise<M365RetestSnapshot<P>>;
  applyRetestResult(input: M365RetestSnapshot<P>, result: RetestResult): Promise<M365ConnectionSnapshot<P>>;
  retestConnection(input: {
    id: string;
    orgId: string;
    auth: AuthContext;
    correlationId?: string;
    executorClient?: Client;
  }): Promise<M365ConnectionSnapshot<P>>;
  disconnectConnection(input: {
    id: string;
    orgId: string;
    actorId: string;
  }): Promise<M365ConnectionSnapshot<P>>;
}

/**
 * Builds a connection-lifecycle service bound to a single M365 permission
 * profile. All profile-specific inputs — the profile literal, its manifest,
 * runtime-config loader, executor client, and retest adapter — arrive via
 * `deps`, so the read and actions surfaces share exactly this implementation.
 */
export function createConnectionService<
  P extends M365ConsentSessionProfile,
  Config extends ConnectionRuntimeConfig,
  Client,
>(deps: ConnectionServiceDeps<P, Config, Client>): ConnectionService<P, Client> {
  const { profile } = deps;

  function snapshot(row: M365ConnectionRow): M365ConnectionSnapshot<P> | null {
    if (
      row.orgId === null
      || row.profile !== profile
      || row.consentAttemptId === null
    ) return null;
    return {
      id: row.id,
      orgId: row.orgId,
      tenantId: row.tenantId,
      clientId: row.clientId,
      profile,
      permissionManifestVersion: row.permissionManifestVersion,
      observedGrants: row.observedGrants,
      consentAttemptId: row.consentAttemptId,
      grantsVerifiedAt: row.grantsVerifiedAt,
      displayName: row.displayName,
      status: row.status,
      lastVerifiedAt: row.lastVerifiedAt,
      lastErrorCode: row.lastErrorCode,
    };
  }

  function attemptPredicate(input: M365ConsentAttemptSnapshot<P>) {
    return and(
      eq(m365Connections.id, input.id),
      eq(m365Connections.orgId, input.orgId),
      eq(m365Connections.profile, profile),
      eq(m365Connections.consentAttemptId, input.consentAttemptId),
      eq(m365Connections.status, input.status),
    );
  }

  async function requireCasRow(rows: M365ConnectionRow[]): Promise<M365ConnectionSnapshot<P>> {
    const value = rows[0] ? snapshot(rows[0]) : null;
    if (!value) throw lifecycleError('stale_attempt');
    return value;
  }

  function resultState(
    status: M365ConnectionStatus,
    manifestVersion: number,
    observedGrants: CanonicalAppRoleAssignment[],
    grantsVerifiedAt: Date | null,
  ): { status: 'active' | 'degraded'; errorCode: string | null } {
    const health = deriveGrantHealth({
      status,
      permissionManifestVersion: manifestVersion,
      observedGrants,
      grantsVerifiedAt,
      lastErrorCode: null,
    }, deps.manifest);
    return {
      status: health.state === 'active' ? 'active' : 'degraded',
      errorCode: lifecycleErrorForHealth(health),
    };
  }

  async function distinguishTenantConflict(
    input: M365ConsentAttemptSnapshot<P>,
    verifiedTenantId: string,
  ): Promise<never> {
    const rows = await db.select({ tenantId: m365Connections.tenantId })
      .from(m365Connections)
      .where(attemptPredicate(input)).limit(1);
    if (rows[0]?.tenantId && rows[0].tenantId !== verifiedTenantId) {
      throw lifecycleError('tenant_already_bound');
    }
    throw lifecycleError('stale_attempt');
  }

  async function recordRetestExecutorUnavailable(
    input: M365RetestSnapshot<P>,
  ): Promise<M365ConnectionSnapshot<P>> {
    const context = dbAccessContextFromAuth(input.auth);
    return withDbAccessContext(context, async () => requireCasRow(
      await db.update(m365Connections).set({
        status: input.status,
        lastErrorCode: 'executor_unavailable',
        updatedAt: new Date(),
      }).where(attemptPredicate(input)).returning(),
    ));
  }

  async function listConnections(
    orgId: string,
  ): Promise<Array<M365ConnectionSnapshot<P> & { grantHealth: GrantHealth }>> {
    const rows = await db.select().from(m365Connections).where(and(
      eq(m365Connections.orgId, orgId),
      eq(m365Connections.profile, profile),
    ));
    return rows.flatMap((row) => {
      const value = snapshot(row);
      return value ? [{
        ...value,
        grantHealth: deriveGrantHealth(value, deps.manifest),
      }] : [];
    });
  }

  async function initiateConsent(input: InitiateConsentInput): Promise<InitiatedConsent<P>> {
    const config = deps.loadRuntimeConfig();
    return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      // Serialize both the no-row and existing-row cases for this exact owner/profile.
      await db.execute(lockKey(input.orgId, profile));
      const existingRows = await db.select().from(m365Connections).where(and(
        eq(m365Connections.orgId, input.orgId),
        eq(m365Connections.profile, profile),
      )).limit(1).for('update');
      const existing = existingRows[0];
      const nextAttemptId = randomUUID();

      if (existing?.consentAttemptId) {
        await deleteConsentSessionsForAttemptInTransaction({
          connectionId: existing.id,
          orgId: input.orgId,
          consentAttemptId: existing.consentAttemptId,
          profile,
        });
      }

      let connectionRow: M365ConnectionRow | undefined;
      if (existing) {
        const oldAttempt = existing.consentAttemptId === null
          ? isNull(m365Connections.consentAttemptId)
          : eq(m365Connections.consentAttemptId, existing.consentAttemptId);
        const updated = await db.update(m365Connections).set({
          consentAttemptId: nextAttemptId,
          clientId: config.clientId,
          authMode: 'application-certificate',
          credentialDomain: profile,
          vaultRef: config.vaultRef,
          credentialVersion: config.credentialVersion,
          status: 'pending-consent',
          revokedAt: null,
          lastErrorCode: null,
          updatedAt: new Date(),
        }).where(and(
          eq(m365Connections.id, existing.id),
          eq(m365Connections.orgId, input.orgId),
          eq(m365Connections.profile, profile),
          oldAttempt,
          eq(m365Connections.status, existing.status),
        )).returning();
        connectionRow = updated[0];
      } else {
        const inserted = await db.insert(m365Connections).values({
          orgId: input.orgId,
          userId: null,
          tenantId: null,
          clientId: config.clientId,
          clientSecret: null,
          profile,
          authMode: 'application-certificate',
          credentialDomain: profile,
          vaultRef: config.vaultRef,
          credentialVersion: config.credentialVersion,
          permissionManifestVersion: deps.manifest.version,
          observedGrants: [],
          consentAttemptId: nextAttemptId,
          status: 'pending-consent',
          createdBy: input.actorId,
        }).returning();
        connectionRow = inserted[0];
      }
      const connection = connectionRow ? snapshot(connectionRow) : null;
      if (!connection) throw lifecycleError('stale_attempt');

      // Identity first (#7910). A row that is still bound (reconnect of a
      // degraded/pending row) pins the sign-in to its tenant; an unbound row
      // (first connect, or reconnect after disconnect cleared tenant_id) signs
      // in at /organizations and learns the tenant from the verified id_token.
      return startIdentityPhase(config, connection, input.actorId, 'initial', connection.tenantId ?? null);
    }));
  }

  /**
   * Mints the phase-1 identity session in the caller's system transaction and
   * builds its v2 authorize URL + browser binding. Shared by first-time and
   * upgrade initiation so both profiles and both purposes take one code path.
   */
  async function startIdentityPhase(
    config: Config,
    connection: M365ConnectionSnapshot<P>,
    actorId: string,
    purpose: M365ConsentPurpose,
    expectedTenantId: string | null,
  ): Promise<InitiatedConsent<P>> {
    const created = await createIdentitySessionInTransaction({
      connectionId: connection.id,
      orgId: connection.orgId,
      consentAttemptId: connection.consentAttemptId,
      userId: actorId,
      profile,
      purpose,
      expectedTenantId,
    });
    const authorizationUrl = buildMicrosoftIdentityAuthorizationUrl({
      authority: expectedTenantId ?? 'organizations',
      clientId: config.clientId,
      redirectUri: config.callbackUrl,
      expectedCallbackPath: new URL(config.callbackUrl).pathname,
      state: created.rawState,
      nonce: created.nonce,
      codeChallenge: created.codeChallenge,
    });
    return {
      connection,
      binding: {
        phase: 'identity_verification',
        rawState: created.rawState,
        connectionId: connection.id,
        consentAttemptId: connection.consentAttemptId,
        tenantId: expectedTenantId,
      },
      authorizationUrl,
    };
  }

  /**
   * Starts a manifest UPGRADE consent on an already-executable connection.
   *
   * Differs from initiateConsent in the two ways that matter (spec §2.2):
   *   - it does not rotate `consent_attempt_id`, so the session binds to the
   *     EXISTING attempt through the composite FK; and
   *   - it writes nothing to m365_connections at all, so an administrator who
   *     abandons the Microsoft flow leaves a fully working connection behind.
   *     initiateConsent moves the row to `pending-consent`, which stops reads.
   */
  async function initiateUpgradeConsent(
    input: InitiateUpgradeConsentInput,
  ): Promise<InitiatedConsent<P>> {
    const config = deps.loadRuntimeConfig();

    // Phase 1 — authorize under the caller's own scope. RLS is the authority
    // for "may this caller see this connection"; the org id in the predicate
    // is a narrowing, not the check.
    const current = await withDbAccessContext(dbAccessContextFromAuth(input.auth), async () => {
      const rows = await db.select().from(m365Connections).where(and(
        eq(m365Connections.id, input.connectionId),
        eq(m365Connections.orgId, input.orgId),
        eq(m365Connections.profile, profile),
        inArray(m365Connections.status, [...EXECUTABLE_STATUSES]),
      )).limit(1);
      const value = rows[0] ? snapshot(rows[0]) : null;
      if (!value) throw lifecycleError('connection_not_found');
      if (!value.tenantId) throw lifecycleError('connection_not_executable');
      return value;
    });
    if (current.permissionManifestVersion === deps.manifest.version) {
      throw lifecycleError('manifest_current');
    }

    // Phase 2 — mint the session in a system transaction. m365_consent_sessions
    // is system-scope-only RLS, so this cannot run under the caller's context.
    return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      // Same key initiateConsent takes, so an upgrade and a full re-consent on
      // the same owner/profile can never interleave.
      await db.execute(lockKey(input.orgId, profile));
      const rows = await db.select().from(m365Connections).where(and(
        eq(m365Connections.id, current.id),
        eq(m365Connections.orgId, input.orgId),
        eq(m365Connections.profile, profile),
        eq(m365Connections.consentAttemptId, current.consentAttemptId),
        inArray(m365Connections.status, [...EXECUTABLE_STATUSES]),
      )).limit(1).for('update');
      const locked = rows[0] ? snapshot(rows[0]) : null;
      if (!locked) throw lifecycleError('stale_attempt');

      // An abandoned earlier upgrade left a live session on this same attempt.
      // Superseding it keeps at most one outstanding upgrade per connection.
      await deleteConsentSessionsForAttemptInTransaction({
        connectionId: locked.id,
        orgId: locked.orgId,
        consentAttemptId: locked.consentAttemptId,
        profile,
      });

      if (!locked.tenantId) throw lifecycleError('connection_not_executable');
      // Upgrade pins BOTH phases to the bound tenant.
      return startIdentityPhase(config, locked, input.auth.user.id, 'upgrade', locked.tenantId);
    }));
  }

  function isExecutable(status: M365ConnectionStatus): boolean {
    return EXECUTABLE_STATUSES.includes(status as typeof EXECUTABLE_STATUSES[number]);
  }

  /** The status an attempt must hold while its consent flow is in flight. */
  function inFlightStatusAllowed(status: M365ConnectionStatus, purpose: M365ConsentPurpose): boolean {
    return purpose === 'upgrade' ? isExecutable(status) : status === 'pending-consent';
  }

  /**
   * Identity verified → tenant-pinned admin consent, in one system
   * transaction under the owner/profile advisory lock. Writes NO status: the
   * administrator has proven who they are, not consented to anything, so a
   * row only ever reaches `verifying` once consent has returned
   * (beginConsentFinalization) and only ever binds after the application proof
   * (applyConsentFinalizationResult).
   *
   * A row that already carries a tenant (reconnect of a bound row, upgrade)
   * only ever continues with an identity verified in THAT tenant; the binding
   * is never moved by this flow.
   */
  async function transitionIdentityToConsent(input: {
    attempt: M365ConsentAttemptSnapshot<P>;
    purpose: M365ConsentPurpose;
    actorId: string;
    verified: VerifiedConsentIdentity;
    nextPhase: 'admin_consent' | 'tenant_confirmation';
  }): Promise<{ rawState: string; verifiedTenantId: string }> {
    if (!inFlightStatusAllowed(input.attempt.status, input.purpose)) throw lifecycleError('stale_attempt');
    return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      await db.execute(lockKey(input.attempt.orgId, profile));
      const rows = await db.select().from(m365Connections)
        .where(attemptPredicate(input.attempt)).limit(1).for('update');
      const locked = rows[0] ? snapshot(rows[0]) : null;
      if (!locked) throw lifecycleError('stale_attempt');

      if (input.purpose === 'upgrade') {
        // Strict equality: an upgrade always has a bound tenant.
        if (!locked.tenantId || locked.tenantId !== input.verified.tenantId) {
          throw lifecycleError('tenant_mismatch');
        }
      } else if (locked.tenantId && locked.tenantId !== input.verified.tenantId) {
        throw lifecycleError('tenant_mismatch');
      }

      const created = await insertVerifiedConsentSessionInTransaction({
        connectionId: locked.id,
        orgId: locked.orgId,
        consentAttemptId: locked.consentAttemptId,
        userId: input.actorId,
        profile,
        purpose: input.purpose,
        phase: input.nextPhase,
        verified: input.verified,
      });
      return { rawState: created.rawState, verifiedTenantId: input.verified.tenantId };
    }));
  }

  /**
   * The first-time attempt a confirm-tenant step may act on: this org's
   * profile row, still `pending-consent`. Runs in the caller's system
   * transaction; `lock` adds FOR UPDATE for the mutating paths.
   */
  async function loadPendingAttemptInTransaction(
    orgId: string,
    lock: boolean,
  ): Promise<M365ConnectionSnapshot<P> | null> {
    const query = db.select().from(m365Connections).where(and(
      eq(m365Connections.orgId, orgId),
      eq(m365Connections.profile, profile),
      eq(m365Connections.status, 'pending-consent'),
    )).limit(1);
    const rows = lock ? await query.for('update') : await query;
    return rows[0] ? snapshot(rows[0]) : null;
  }

  function tenantConfirmationLookup(connection: M365ConnectionSnapshot<P>, actorId: string) {
    return {
      connectionId: connection.id,
      orgId: connection.orgId,
      consentAttemptId: connection.consentAttemptId,
      profile,
      userId: actorId,
    };
  }

  async function readPendingTenantConfirmation(
    input: TenantConfirmationInput,
  ): Promise<PendingTenantConfirmation | null> {
    return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      const connection = await loadPendingAttemptInTransaction(input.orgId, false);
      if (!connection) return null;
      const session = await readTenantConfirmationSessionInTransaction(
        tenantConfirmationLookup(connection, input.actorId),
      );
      const verified = session ? verifiedIdentityFromSession(session) : null;
      if (!session || !verified) return null;
      return {
        tenantId: verified.tenantId,
        administratorUsername: verified.administratorUsername,
        expiresAt: session.expiresAt,
      };
    }));
  }

  /**
   * The operator confirmed the tenant shown on the interstitial. In one system
   * transaction under the owner/profile advisory lock: consume the parked
   * session (one-shot; bound to this org, profile, current attempt and user,
   * unexpired), mint a fresh admin_consent session carrying the SAME verified
   * identity under a new state, and build the v1 tenant-pinned consent URL.
   * Writes nothing to the connection row. Any throw rolls the consume back.
   */
  async function continueToConsent(input: TenantConfirmationInput): Promise<ContinuedToConsent<P>> {
    const config = deps.loadRuntimeConfig();
    return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      await db.execute(lockKey(input.orgId, profile));
      const locked = await loadPendingAttemptInTransaction(input.orgId, true);
      if (!locked) throw lifecycleError('stale_attempt');
      const session = await consumeTenantConfirmationSessionInTransaction(
        tenantConfirmationLookup(locked, input.actorId),
      );
      const verified = session ? verifiedIdentityFromSession(session) : null;
      if (!session || !verified || session.purpose !== 'initial') throw lifecycleError('stale_attempt');
      // An unbound row is the only kind that parks; the belt for a row that
      // somehow gained a different tenant meanwhile.
      if (locked.tenantId && locked.tenantId !== verified.tenantId) throw lifecycleError('tenant_mismatch');

      const created = await insertVerifiedConsentSessionInTransaction({
        connectionId: locked.id,
        orgId: locked.orgId,
        consentAttemptId: locked.consentAttemptId,
        userId: input.actorId,
        profile,
        purpose: 'initial',
        phase: 'admin_consent',
        verified,
      });
      const consentUrl = buildMicrosoftTenantAdminConsentUrl({
        tenantId: verified.tenantId,
        clientId: config.clientId,
        redirectUri: config.callbackUrl,
        expectedCallbackPath: new URL(config.callbackUrl).pathname,
        state: created.rawState,
      });
      return {
        connection: locked,
        binding: {
          phase: 'admin_consent',
          rawState: created.rawState,
          connectionId: locked.id,
          consentAttemptId: locked.consentAttemptId,
          tenantId: verified.tenantId,
        },
        consentUrl,
        verifiedTenantId: verified.tenantId,
        verifiedAdministratorObjectId: verified.administratorObjectId,
      };
    }));
  }

  /**
   * The operator rejected the tenant (for example it is their own MSP tenant).
   * Consumes the parked session and records `consent_cancelled` on the still
   * pending-consent attempt. Nothing was consented and nothing is bound.
   */
  async function cancelTenantConfirmation(
    input: TenantConfirmationInput,
  ): Promise<M365ConnectionSnapshot<P>> {
    return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      await db.execute(lockKey(input.orgId, profile));
      const locked = await loadPendingAttemptInTransaction(input.orgId, true);
      if (!locked) throw lifecycleError('stale_attempt');
      const session = await consumeTenantConfirmationSessionInTransaction(
        tenantConfirmationLookup(locked, input.actorId),
      );
      if (!session) throw lifecycleError('stale_attempt');
      return requireCasRow(await db.update(m365Connections).set({
        status: 'pending-consent',
        lastErrorCode: 'consent_cancelled',
        updatedAt: new Date(),
      }).where(attemptPredicate({
        id: locked.id,
        orgId: locked.orgId,
        profile,
        consentAttemptId: locked.consentAttemptId,
        status: 'pending-consent',
      })).returning());
    }));
  }

  /**
   * Consent returned from Microsoft. Consumes the one-use consent session (the
   * returned authorization code is never seen here — the route discards it)
   * and, for a first-time consent, CAS-moves pending-consent → verifying in the
   * SAME transaction so a failed CAS leaves the session consumable for a
   * retry and a replayed state finds nothing to consume.
   */
  async function beginConsentFinalization(input: {
    attempt: M365ConsentAttemptSnapshot<P>;
    rawConsentState: string;
  }): Promise<StartedConsentFinalization<P>> {
    return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      const session = await consumeConsentSessionInTransaction({
        rawState: input.rawConsentState,
        phase: 'admin_consent',
        connectionId: input.attempt.id,
        orgId: input.attempt.orgId,
        consentAttemptId: input.attempt.consentAttemptId,
        profile,
      });
      if (!session) throw lifecycleError('stale_attempt');
      const verified = verifiedIdentityFromSession(session);
      if (!verified) throw lifecycleError('stale_attempt');
      const purpose = session.purpose;
      // The consumed row is the authority on which flow this is; the
      // callback's non-consuming lookup only routed us here.
      if (!inFlightStatusAllowed(input.attempt.status, purpose)) throw lifecycleError('stale_attempt');

      if (purpose === 'upgrade') {
        const rows = await db.select().from(m365Connections)
          .where(attemptPredicate(input.attempt)).limit(1).for('update');
        if (!rows[0] || !snapshot(rows[0])) throw lifecycleError('stale_attempt');
        return { attempt: input.attempt, purpose, verified, actorId: session.userId };
      }

      const connection = await requireCasRow(await db.update(m365Connections).set({
        status: 'verifying',
        consentedAt: new Date(),
        lastErrorCode: null,
        updatedAt: new Date(),
      }).where(attemptPredicate(input.attempt)).returning());
      return {
        attempt: {
          id: connection.id,
          orgId: connection.orgId,
          profile,
          consentAttemptId: connection.consentAttemptId,
          status: connection.status,
        },
        purpose,
        verified,
        actorId: session.userId,
      };
    }));
  }

  async function markConsentAttemptFailed(
    input: M365ConsentAttemptSnapshot<P>,
    errorCode: string,
  ): Promise<M365ConnectionSnapshot<P>> {
    if (!CALLBACK_STATUSES.includes(input.status as typeof CALLBACK_STATUSES[number])) {
      throw lifecycleError('stale_attempt');
    }
    return runOutsideDbContext(() => withSystemDbAccessContext(async () => requireCasRow(
      await db.update(m365Connections).set({
        status: 'pending-consent',
        lastErrorCode: errorCode,
        updatedAt: new Date(),
      }).where(attemptPredicate(input)).returning(),
    )));
  }

  /**
   * Applies the executor application-token proof (retest against the tenant
   * verified in phase 1). This is the ONLY place a first-time consent binds a
   * tenant, and it binds `verifiedTenantId` only when the proof was obtained
   * for exactly that tenant.
   */
  async function applyConsentFinalizationResult(
    input: M365ConsentAttemptSnapshot<P>,
    finalization: ConsentFinalization,
  ): Promise<M365ConnectionSnapshot<P>> {
    if (input.status !== 'verifying') throw lifecycleError('stale_attempt');
    const { result, verifiedTenantId } = finalization;
    return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      if (!result.success) {
        return requireCasRow(await db.update(m365Connections).set({
          status: 'pending-consent',
          lastErrorCode: result.errorCode,
          updatedAt: new Date(),
        }).where(attemptPredicate(input)).returning());
      }

      // The executor is fixed-profile, but the control plane independently
      // checks the returned proof against its own code/config-owned application.
      if (result.applicationId !== deps.loadRuntimeConfig().clientId) {
        return requireCasRow(await db.update(m365Connections).set({
          status: 'pending-consent',
          lastErrorCode: 'application_token_invalid',
          updatedAt: new Date(),
        }).where(attemptPredicate(input)).returning());
      }
      // The executor proved an application token for result.tenantId; it must
      // be exactly the tenant whose administrator was verified in phase 1.
      if (result.tenantId !== verifiedTenantId) {
        return requireCasRow(await db.update(m365Connections).set({
          status: 'pending-consent',
          lastErrorCode: 'tenant_mismatch',
          updatedAt: new Date(),
        }).where(attemptPredicate(input)).returning());
      }

      const verifiedAt = new Date(result.verifiedAt);
      const common = {
        tenantId: verifiedTenantId,
        clientId: result.applicationId,
        displayName: result.organizationDisplayName,
        permissionManifestVersion: result.manifestVersion,
        lastVerifiedAt: verifiedAt,
        revokedAt: null,
        updatedAt: new Date(),
      };
      const set = result.grantReconciliation === 'complete'
        ? (() => {
            const grantsVerifiedAt = new Date(result.grantsVerifiedAt);
            const state = resultState('active', result.manifestVersion, result.observedGrants, grantsVerifiedAt);
            return {
              ...common,
              observedGrants: result.observedGrants,
              grantsVerifiedAt,
              status: state.status,
              lastErrorCode: state.errorCode,
            };
          })()
        : {
            ...common,
            status: 'degraded' as const,
            lastErrorCode: 'grant_reconciliation_unavailable',
          };

      try {
        const rows = await db.update(m365Connections).set(set).where(and(
          attemptPredicate(input),
          or(isNull(m365Connections.tenantId), eq(m365Connections.tenantId, verifiedTenantId)),
        )).returning();
        if (!rows[0]) return distinguishTenantConflict(input, verifiedTenantId);
        return requireCasRow(rows);
      } catch (error) {
        return bindingError(error);
      }
    }));
  }

  /**
   * Applies an upgrade callback result in place (spec §2.2).
   *
   * Every early return is a deliberate no-op: an abandoned, cancelled, or
   * failed upgrade must leave the connection exactly as it was, still
   * executing on the grants it already holds. The one write path never lowers
   * executability — a partial approval records what was observed and leaves
   * the stored manifest version, so deriveGrantHealth keeps reporting
   * manifest-stale and the card keeps offering the banner.
   */
  async function applyUpgradeFinalizationResult(
    input: M365ConsentAttemptSnapshot<P>,
    finalization: ConsentFinalization,
  ): Promise<AppliedUpgradeVerification<P>> {
    if (!isExecutable(input.status)) throw lifecycleError('stale_attempt');
    const { result, verifiedTenantId } = finalization;
    return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      const rows = await db.select().from(m365Connections)
        .where(attemptPredicate(input)).limit(1).for('update');
      const current = rows[0] ? snapshot(rows[0]) : null;
      if (!current) throw lifecycleError('stale_attempt');

      // Every early return writes nothing; the reason travels back in band so
      // the callback can redirect and audit it truthfully.
      if (!result.success) return { connection: current, failureCode: result.errorCode };
      // The executor is fixed-profile, but the control plane checks the proof
      // against its own code/config-owned application, exactly as the
      // first-time path does.
      if (result.applicationId !== deps.loadRuntimeConfig().clientId) {
        return { connection: current, failureCode: 'application_token_invalid' };
      }
      // Strict equality, not "NULL or equal": an upgrade always has a bound
      // tenant, so a different tenant — verified in phase 1 or proven by the
      // application token — is a rebind attempt, never a binding.
      if (verifiedTenantId !== current.tenantId || result.tenantId !== current.tenantId) {
        return { connection: current, failureCode: 'tenant_mismatch' };
      }
      if (result.grantReconciliation !== 'complete') {
        return { connection: current, failureCode: 'grant_reconciliation_unavailable' };
      }

      const verifiedAt = new Date(result.verifiedAt);
      const grantsVerifiedAt = new Date(result.grantsVerifiedAt);
      const health = deriveGrantHealth({
        status: current.status,
        permissionManifestVersion: deps.manifest.version,
        observedGrants: result.observedGrants,
        grantsVerifiedAt,
        lastErrorCode: null,
      }, deps.manifest);
      const promote = health.missingGrants.length === 0
        && result.manifestVersion === deps.manifest.version;

      const set = promote
        ? {
            displayName: result.organizationDisplayName,
            observedGrants: result.observedGrants,
            grantsVerifiedAt,
            lastVerifiedAt: verifiedAt,
            permissionManifestVersion: deps.manifest.version,
            consentGeneration: sql`${m365Connections.consentGeneration} + 1`,
            status: health.state === 'active' ? 'active' as const : 'degraded' as const,
            lastErrorCode: lifecycleErrorForHealth(health),
            updatedAt: new Date(),
          }
        : {
            displayName: result.organizationDisplayName,
            observedGrants: result.observedGrants,
            grantsVerifiedAt,
            lastVerifiedAt: verifiedAt,
            lastErrorCode: 'grant_missing',
            updatedAt: new Date(),
          };
      const connection = await requireCasRow(await db.update(m365Connections).set(set)
        .where(attemptPredicate(input)).returning());
      return { connection, failureCode: promote ? null : 'grant_missing' };
    }));
  }

  async function loadRetestSnapshot(input: {
    id: string;
    orgId: string;
    auth: AuthContext;
  }): Promise<M365RetestSnapshot<P>> {
    const context = dbAccessContextFromAuth(input.auth);
    return withDbAccessContext(context, async () => {
      const rows = await db.select().from(m365Connections).where(and(
        eq(m365Connections.id, input.id),
        eq(m365Connections.orgId, input.orgId),
        eq(m365Connections.profile, profile),
        inArray(m365Connections.status, [...EXECUTABLE_STATUSES]),
      )).limit(1);
      const current = rows[0] ? snapshot(rows[0]) : null;
      if (!current) throw lifecycleError('connection_not_found');
      if (!current.tenantId || !EXECUTABLE_STATUSES.includes(current.status as typeof EXECUTABLE_STATUSES[number])) {
        throw lifecycleError('connection_not_executable');
      }

      // Claim a unique operation generation before leaving the caller-scoped
      // transaction. A later retest rotates it again, so delayed results can no
      // longer satisfy the attempt/status CAS even when both operations leave
      // the lifecycle status unchanged.
      const claimed = await requireCasRow(await db.update(m365Connections).set({
        consentAttemptId: randomUUID(),
        updatedAt: new Date(),
      }).where(attemptPredicate(current)).returning());
      return {
        ...claimed,
        tenantId: current.tenantId,
        status: claimed.status as 'active' | 'degraded',
        auth: input.auth,
      };
    });
  }

  async function applyRetestResult(
    input: M365RetestSnapshot<P>,
    result: RetestResult,
  ): Promise<M365ConnectionSnapshot<P>> {
    const context = dbAccessContextFromAuth(input.auth);
    return withDbAccessContext(context, async () => {
      if (!result.success) {
        const transient = result.errorCode === 'credential_unavailable';
        return requireCasRow(await db.update(m365Connections).set({
          status: transient ? input.status : 'degraded',
          lastErrorCode: result.errorCode,
          updatedAt: new Date(),
        }).where(attemptPredicate(input)).returning());
      }
      if (result.tenantId !== input.tenantId || result.applicationId !== input.clientId) {
        return requireCasRow(await db.update(m365Connections).set({
          status: 'degraded',
          lastErrorCode: result.tenantId !== input.tenantId
            ? 'tenant_mismatch'
            : 'application_token_invalid',
          updatedAt: new Date(),
        }).where(attemptPredicate(input)).returning());
      }

      const verifiedAt = new Date(result.verifiedAt);
      const common = {
        displayName: result.organizationDisplayName,
        permissionManifestVersion: result.manifestVersion,
        lastVerifiedAt: verifiedAt,
        updatedAt: new Date(),
      };
      const set = result.grantReconciliation === 'complete'
        ? (() => {
            const grantsVerifiedAt = new Date(result.grantsVerifiedAt);
            const state = resultState('active', result.manifestVersion, result.observedGrants, grantsVerifiedAt);
            return {
              ...common,
              observedGrants: result.observedGrants,
              grantsVerifiedAt,
              status: state.status,
              lastErrorCode: state.errorCode,
            };
          })()
        : {
            ...common,
            status: 'degraded' as const,
            lastErrorCode: 'grant_reconciliation_unavailable',
          };
      return requireCasRow(await db.update(m365Connections).set(set)
        .where(attemptPredicate(input)).returning());
    });
  }

  async function retestConnection(input: {
    id: string;
    orgId: string;
    auth: AuthContext;
    correlationId?: string;
    executorClient?: Client;
  }): Promise<M365ConnectionSnapshot<P>> {
    return runOutsideDbContext(async () => {
      // loadRetestSnapshot rotates consent_attempt_id, and the consent-session
      // composite FK has ON DELETE CASCADE but no ON UPDATE CASCADE — so a
      // live session on this connection would make the rotation raise 23503.
      // Before upgrade consent existed, an executable connection never carried
      // one. Superseding an in-flight upgrade is the correct resolution: the
      // upgrade has written nothing, retest is an explicit operator action,
      // and the banner restarts it. Narrow race: an upgrade started between
      // this delete and the rotation still 409s, which is the pre-existing
      // failure mode, not a new one.
      await deleteConsentSessionsForConnection({
        connectionId: input.id,
        orgId: input.orgId,
        profile,
      });
      const retestSnapshot = await loadRetestSnapshot(input);
      let result: RetestResult;
      try {
        const client = input.executorClient ?? deps.createExecutorClient(deps.loadRuntimeConfig());
        result = await deps.retest(client, {
          correlationId: input.correlationId ?? randomUUID(),
          tenantId: retestSnapshot.tenantId,
        });
      } catch {
        return recordRetestExecutorUnavailable(retestSnapshot);
      }
      return applyRetestResult(retestSnapshot, result);
    });
  }

  async function disconnectConnection(input: {
    id: string;
    orgId: string;
    actorId: string;
  }): Promise<M365ConnectionSnapshot<P>> {
    return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      const rows = await db.select().from(m365Connections).where(and(
        eq(m365Connections.id, input.id),
        eq(m365Connections.orgId, input.orgId),
        eq(m365Connections.profile, profile),
      )).limit(1).for('update');
      const current = rows[0];
      if (!current?.orgId || !current.consentAttemptId) {
        throw lifecycleError('connection_not_found');
      }
      await deleteConsentSessionsForAttemptInTransaction({
        connectionId: current.id,
        orgId: current.orgId,
        consentAttemptId: current.consentAttemptId,
        profile,
      });
      const nextAttemptId = randomUUID();
      const disconnected = await requireCasRow(await db.update(m365Connections).set({
        consentAttemptId: nextAttemptId,
        tenantId: null,
        clientId: '',
        displayName: null,
        permissionManifestVersion: current.permissionManifestVersion,
        observedGrants: [],
        grantsVerifiedAt: null,
        lastVerifiedAt: null,
        consentedAt: null,
        expiresAt: null,
        status: 'revoked',
        revokedAt: new Date(),
        lastErrorCode: null,
        updatedAt: new Date(),
      }).where(attemptPredicate({
        id: current.id,
        orgId: current.orgId,
        profile,
        consentAttemptId: current.consentAttemptId,
        status: current.status,
      })).returning());

      // Spec §5.8: the row survives a disconnect (status 'revoked', tenant
      // cleared), so no FK cascade fires and the synced tenant snapshot would
      // otherwise outlive the consent that authorised it. The erasure runs in
      // THIS transaction — a committed disconnect that left m365_users behind
      // is a privacy defect, and a throw here rolls the status flip back too.
      // Only the read profile: the sync reads exclusively through that
      // connection, and the org-keyed m365_* tables must not be wiped by
      // disconnecting the separate actions profile while read stays connected.
      if (profile === 'customer-graph-read') {
        await onConnectionDisconnected({ id: disconnected.id, orgId: current.orgId });
      }
      return disconnected;
    }));
  }

  return {
    initiateConsent,
    initiateUpgradeConsent,
    listConnections,
    transitionIdentityToConsent,
    readPendingTenantConfirmation,
    continueToConsent,
    cancelTenantConfirmation,
    markConsentAttemptFailed,
    beginConsentFinalization,
    applyConsentFinalizationResult,
    applyUpgradeFinalizationResult,
    loadRetestSnapshot,
    applyRetestResult,
    retestConnection,
    disconnectConnection,
  };
}

// --- customer-graph-read instance (public names preserved as aliases) --------

const readConnectionService = createConnectionService({
  profile: 'customer-graph-read',
  manifest: M365_PERMISSION_PROFILES['customer-graph-read'],
  // Wrapped (not passed by reference) so the runtime-config binding is read
  // lazily at call time — matching the pre-factory behavior and keeping partial
  // module mocks that omit this export (route tests) importable.
  loadRuntimeConfig: () => loadM365CustomerGraphReadRuntimeConfig(),
  createExecutorClient: (config): GraphReadExecutorClient => createGraphReadExecutorClient({
    executorUrl: config.executorUrl,
    executorAudience: config.executorAudience,
    signingPrivateJwk: config.executorSigningPrivateJwk,
    signingKid: config.executorSigningKid,
  }),
  retest: (client, request) => client.retestCustomerGraphRead(request),
});

/** @deprecated shape retained for existing importers — use InitiateConsentInput. */
export type InitiateCustomerGraphReadConsentInput = InitiateConsentInput;
/** @deprecated shape retained for existing importers — use InitiatedConsent. */
export type InitiatedCustomerGraphReadConsent = InitiatedConsent<'customer-graph-read'>;

export const initiateCustomerGraphReadConsent = readConnectionService.initiateConsent;
export const initiateCustomerGraphReadUpgradeConsent = readConnectionService.initiateUpgradeConsent;
export const listCustomerGraphReadConnections = readConnectionService.listConnections;
export const transitionIdentityToConsent = readConnectionService.transitionIdentityToConsent;
export const readPendingCustomerGraphReadTenantConfirmation = readConnectionService.readPendingTenantConfirmation;
export const continueCustomerGraphReadConsent = readConnectionService.continueToConsent;
export const cancelCustomerGraphReadTenantConfirmation = readConnectionService.cancelTenantConfirmation;
export const markConsentAttemptFailed = readConnectionService.markConsentAttemptFailed;
export const beginConsentFinalization = readConnectionService.beginConsentFinalization;
export const applyConsentFinalizationResult = readConnectionService.applyConsentFinalizationResult;
export const applyUpgradeFinalizationResult = readConnectionService.applyUpgradeFinalizationResult;
export const loadRetestSnapshot = readConnectionService.loadRetestSnapshot;
export const applyRetestResult = readConnectionService.applyRetestResult;
export const retestCustomerGraphReadConnection = readConnectionService.retestConnection;
export const disconnectCustomerGraphReadConnection = readConnectionService.disconnectConnection;
