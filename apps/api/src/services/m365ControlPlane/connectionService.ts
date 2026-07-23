import { randomUUID } from 'node:crypto';
import {
  canonicalGrantKey,
  M365_PERMISSION_PROFILES,
  type CanonicalAppRoleAssignment,
  type CompleteConsentResult,
  type M365ConnectionProfile,
  type M365PermissionProfileManifest,
  type RetestRequest,
  type RetestResult,
} from '@breeze/shared/m365';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { m365Connections, type M365ConnectionRow, type M365ConnectionStatus } from '../../db/schema';
import { dbAccessContextFromAuth, type AuthContext } from '../../middleware/auth';
import {
  consumeConsentSessionInTransaction,
  createAdminConsentSessionInTransaction,
  deleteConsentSessionsForAttemptInTransaction,
  insertPreparedIdentityVerificationSessionInTransaction,
  type M365ConsentSessionProfile,
  type PreparedIdentityVerificationSession,
} from './consentSessionService';
import {
  createGraphReadExecutorClient,
  type GraphReadExecutorClient,
} from './graphReadExecutorClient';
import { loadM365CustomerGraphReadRuntimeConfig } from './runtimeConfig';

const EXECUTABLE_STATUSES = ['active', 'degraded'] as const;
const CALLBACK_STATUSES = ['pending-consent', 'verifying'] as const;

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

export type ConnectionLifecycleErrorCode =
  | 'connection_not_found'
  | 'connection_not_executable'
  | 'stale_attempt'
  | 'tenant_already_bound';

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

export interface InitiatedConsent<P extends M365ConnectionProfile = M365ConnectionProfile> {
  connection: M365ConnectionSnapshot<P>;
  rawState: string;
  consentUrl: string;
}

export interface ConnectionService<P extends M365ConsentSessionProfile, Client> {
  initiateConsent(input: InitiateConsentInput): Promise<InitiatedConsent<P>>;
  listConnections(orgId: string): Promise<Array<M365ConnectionSnapshot<P> & { grantHealth: GrantHealth }>>;
  markAdminConsentReturned(input: M365ConsentAttemptSnapshot<P>): Promise<M365ConnectionSnapshot<P>>;
  transitionAdminConsentToIdentity(input: {
    attempt: M365ConsentAttemptSnapshot<P>;
    rawAdminState: string;
    prepared: PreparedIdentityVerificationSession;
  }): Promise<{
    connection: M365ConnectionSnapshot<P>;
    identity: Awaited<ReturnType<typeof insertPreparedIdentityVerificationSessionInTransaction>>;
    actorId: string;
  }>;
  markConsentAttemptFailed(
    input: M365ConsentAttemptSnapshot<P>,
    errorCode: string,
  ): Promise<M365ConnectionSnapshot<P>>;
  applyIdentityVerificationResult(
    input: M365ConsentAttemptSnapshot<P>,
    result: CompleteConsentResult,
  ): Promise<M365ConnectionSnapshot<P>>;
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
      await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.orgId}/${profile}`}, 0))`);
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

      const created = await createAdminConsentSessionInTransaction({
        connectionId: connection.id,
        orgId: connection.orgId,
        consentAttemptId: connection.consentAttemptId,
        userId: input.actorId,
        profile,
      });
      const consentUrl = new URL('https://login.microsoftonline.com/common/adminconsent');
      consentUrl.searchParams.set('client_id', config.clientId);
      consentUrl.searchParams.set('redirect_uri', config.callbackUrl);
      consentUrl.searchParams.set('state', created.rawState);
      return { connection, rawState: created.rawState, consentUrl: consentUrl.toString() };
    }));
  }

  async function markAdminConsentReturned(
    input: M365ConsentAttemptSnapshot<P>,
  ): Promise<M365ConnectionSnapshot<P>> {
    if (input.status !== 'pending-consent') throw lifecycleError('stale_attempt');
    return runOutsideDbContext(() => withSystemDbAccessContext(async () => requireCasRow(
      await db.update(m365Connections).set({
        status: 'verifying',
        consentedAt: new Date(),
        lastErrorCode: null,
        updatedAt: new Date(),
      }).where(attemptPredicate(input)).returning(),
    )));
  }

  /**
   * Advances admin consent to identity verification in one system transaction.
   * Any consume, CAS, or insert failure rolls back the entire phase change, so
   * the original admin callback remains retryable and no identity session can be
   * orphaned.
   */
  async function transitionAdminConsentToIdentity(input: {
    attempt: M365ConsentAttemptSnapshot<P>;
    rawAdminState: string;
    prepared: PreparedIdentityVerificationSession;
  }): Promise<{
    connection: M365ConnectionSnapshot<P>;
    identity: Awaited<ReturnType<typeof insertPreparedIdentityVerificationSessionInTransaction>>;
    actorId: string;
  }> {
    if (input.attempt.status !== 'pending-consent') throw lifecycleError('stale_attempt');
    return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      const adminSession = await consumeConsentSessionInTransaction({
        rawState: input.rawAdminState,
        phase: 'admin_consent',
        connectionId: input.attempt.id,
        orgId: input.attempt.orgId,
        consentAttemptId: input.attempt.consentAttemptId,
        profile,
      });
      if (!adminSession) throw lifecycleError('stale_attempt');

      const connection = await requireCasRow(await db.update(m365Connections).set({
        status: 'verifying',
        consentedAt: new Date(),
        lastErrorCode: null,
        updatedAt: new Date(),
      }).where(attemptPredicate(input.attempt)).returning());

      const identity = await insertPreparedIdentityVerificationSessionInTransaction({
        connectionId: input.attempt.id,
        orgId: input.attempt.orgId,
        consentAttemptId: input.attempt.consentAttemptId,
        userId: adminSession.userId,
        profile,
      }, input.prepared);
      return { connection, identity, actorId: adminSession.userId };
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

  async function applyIdentityVerificationResult(
    input: M365ConsentAttemptSnapshot<P>,
    result: CompleteConsentResult,
  ): Promise<M365ConnectionSnapshot<P>> {
    if (input.status !== 'verifying') throw lifecycleError('stale_attempt');
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

      const verifiedAt = new Date(result.verifiedAt);
      const common = {
        tenantId: result.tenantId,
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
          or(isNull(m365Connections.tenantId), eq(m365Connections.tenantId, result.tenantId)),
        )).returning();
        if (!rows[0]) return distinguishTenantConflict(input, result.tenantId);
        return requireCasRow(rows);
      } catch (error) {
        return bindingError(error);
      }
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
      return requireCasRow(await db.update(m365Connections).set({
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
    }));
  }

  return {
    initiateConsent,
    listConnections,
    markAdminConsentReturned,
    transitionAdminConsentToIdentity,
    markConsentAttemptFailed,
    applyIdentityVerificationResult,
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
export const listCustomerGraphReadConnections = readConnectionService.listConnections;
export const markAdminConsentReturned = readConnectionService.markAdminConsentReturned;
export const transitionAdminConsentToIdentity = readConnectionService.transitionAdminConsentToIdentity;
export const markConsentAttemptFailed = readConnectionService.markConsentAttemptFailed;
export const applyIdentityVerificationResult = readConnectionService.applyIdentityVerificationResult;
export const loadRetestSnapshot = readConnectionService.loadRetestSnapshot;
export const applyRetestResult = readConnectionService.applyRetestResult;
export const retestCustomerGraphReadConnection = readConnectionService.retestConnection;
export const disconnectCustomerGraphReadConnection = readConnectionService.disconnectConnection;
