import { randomUUID } from 'node:crypto';
import {
  M365_PERMISSION_PROFILES,
  canonicalGrantKey,
  type CanonicalAppRoleAssignment,
  type CompleteConsentResult,
  type M365PermissionProfileManifest,
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
  type PreparedIdentityVerificationSession,
} from './consentSessionService';
import {
  createGraphReadExecutorClient,
  type GraphReadExecutorClient,
} from './graphReadExecutorClient';
import {
  loadM365CustomerGraphReadRuntimeConfig,
  type M365CustomerGraphReadRuntimeConfig,
} from './runtimeConfig';

const PROFILE = 'customer-graph-read' as const;
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

export type CustomerGraphReadConnectionSnapshot = Pick<
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
  profile: typeof PROFILE;
  consentAttemptId: string;
};

export interface ConsentAttemptSnapshot {
  id: string;
  orgId: string;
  profile: typeof PROFILE;
  consentAttemptId: string;
  status: M365ConnectionStatus;
}

export interface RetestSnapshot extends CustomerGraphReadConnectionSnapshot {
  tenantId: string;
  status: 'active' | 'degraded';
  /** Exact caller scope used to reopen the short CAS write transaction. */
  auth: AuthContext;
}

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

function snapshot(row: M365ConnectionRow): CustomerGraphReadConnectionSnapshot | null {
  if (
    row.orgId === null
    || row.profile !== PROFILE
    || row.consentAttemptId === null
  ) return null;
  return {
    id: row.id,
    orgId: row.orgId,
    tenantId: row.tenantId,
    clientId: row.clientId,
    profile: PROFILE,
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

function attemptPredicate(input: ConsentAttemptSnapshot) {
  return and(
    eq(m365Connections.id, input.id),
    eq(m365Connections.orgId, input.orgId),
    eq(m365Connections.profile, PROFILE),
    eq(m365Connections.consentAttemptId, input.consentAttemptId),
    eq(m365Connections.status, input.status),
  );
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

async function requireCasRow(
  rows: M365ConnectionRow[],
): Promise<CustomerGraphReadConnectionSnapshot> {
  const value = rows[0] ? snapshot(rows[0]) : null;
  if (!value) throw lifecycleError('stale_attempt');
  return value;
}

function lifecycleErrorForHealth(health: GrantHealth): string | null {
  if (health.state === 'manifest-stale') return 'manifest_stale';
  if (health.missingGrants.length > 0) return 'grant_missing';
  if (health.unexpectedGrants.length > 0) return 'grant_unexpected';
  return null;
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
  }, M365_PERMISSION_PROFILES[PROFILE]);
  return {
    status: health.state === 'active' ? 'active' : 'degraded',
    errorCode: lifecycleErrorForHealth(health),
  };
}

function runtimeClient(config: M365CustomerGraphReadRuntimeConfig): GraphReadExecutorClient {
  return createGraphReadExecutorClient({
    executorUrl: config.executorUrl,
    executorAudience: config.executorAudience,
    signingPrivateJwk: config.executorSigningPrivateJwk,
    signingKid: config.executorSigningKid,
  });
}

export async function listCustomerGraphReadConnections(
  orgId: string,
): Promise<Array<CustomerGraphReadConnectionSnapshot & { grantHealth: GrantHealth }>> {
  const rows = await db.select().from(m365Connections).where(and(
    eq(m365Connections.orgId, orgId),
    eq(m365Connections.profile, PROFILE),
  ));
  return rows.flatMap((row) => {
    const value = snapshot(row);
    return value ? [{
      ...value,
      grantHealth: deriveGrantHealth(value, M365_PERMISSION_PROFILES[PROFILE]),
    }] : [];
  });
}

export interface InitiateCustomerGraphReadConsentInput {
  orgId: string;
  actorId: string;
}

export interface InitiatedCustomerGraphReadConsent {
  connection: CustomerGraphReadConnectionSnapshot;
  rawState: string;
  consentUrl: string;
}

export async function initiateCustomerGraphReadConsent(
  input: InitiateCustomerGraphReadConsentInput,
): Promise<InitiatedCustomerGraphReadConsent> {
  const config = loadM365CustomerGraphReadRuntimeConfig();
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    // Serialize both the no-row and existing-row cases for this exact owner/profile.
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.orgId}/${PROFILE}`}, 0))`);
    const existingRows = await db.select().from(m365Connections).where(and(
      eq(m365Connections.orgId, input.orgId),
      eq(m365Connections.profile, PROFILE),
    )).limit(1).for('update');
    const existing = existingRows[0];
    const nextAttemptId = randomUUID();

    if (existing?.consentAttemptId) {
      await deleteConsentSessionsForAttemptInTransaction({
        connectionId: existing.id,
        orgId: input.orgId,
        consentAttemptId: existing.consentAttemptId,
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
        credentialDomain: PROFILE,
        vaultRef: config.vaultRef,
        credentialVersion: config.credentialVersion,
        status: 'pending-consent',
        revokedAt: null,
        lastErrorCode: null,
        updatedAt: new Date(),
      }).where(and(
        eq(m365Connections.id, existing.id),
        eq(m365Connections.orgId, input.orgId),
        eq(m365Connections.profile, PROFILE),
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
        profile: PROFILE,
        authMode: 'application-certificate',
        credentialDomain: PROFILE,
        vaultRef: config.vaultRef,
        credentialVersion: config.credentialVersion,
        permissionManifestVersion: M365_PERMISSION_PROFILES[PROFILE].version,
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
    });
    const consentUrl = new URL('https://login.microsoftonline.com/common/adminconsent');
    consentUrl.searchParams.set('client_id', config.clientId);
    consentUrl.searchParams.set('redirect_uri', config.callbackUrl);
    consentUrl.searchParams.set('state', created.rawState);
    return { connection, rawState: created.rawState, consentUrl: consentUrl.toString() };
  }));
}

export async function markAdminConsentReturned(
  input: ConsentAttemptSnapshot,
): Promise<CustomerGraphReadConnectionSnapshot> {
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
export async function transitionAdminConsentToIdentity(input: {
  attempt: ConsentAttemptSnapshot;
  rawAdminState: string;
  prepared: PreparedIdentityVerificationSession;
}): Promise<{
  connection: CustomerGraphReadConnectionSnapshot;
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
    }, input.prepared);
    return { connection, identity, actorId: adminSession.userId };
  }));
}

export async function markConsentAttemptFailed(
  input: ConsentAttemptSnapshot,
  errorCode: string,
): Promise<CustomerGraphReadConnectionSnapshot> {
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

async function distinguishTenantConflict(
  input: ConsentAttemptSnapshot,
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

export async function applyIdentityVerificationResult(
  input: ConsentAttemptSnapshot,
  result: CompleteConsentResult,
): Promise<CustomerGraphReadConnectionSnapshot> {
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
    if (result.applicationId !== loadM365CustomerGraphReadRuntimeConfig().clientId) {
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

export async function loadRetestSnapshot(input: {
  id: string;
  orgId: string;
  auth: AuthContext;
}): Promise<RetestSnapshot> {
  const context = dbAccessContextFromAuth(input.auth);
  return withDbAccessContext(context, async () => {
    const rows = await db.select().from(m365Connections).where(and(
      eq(m365Connections.id, input.id),
      eq(m365Connections.orgId, input.orgId),
      eq(m365Connections.profile, PROFILE),
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

export async function applyRetestResult(
  input: RetestSnapshot,
  result: RetestResult,
): Promise<CustomerGraphReadConnectionSnapshot> {
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

async function recordRetestExecutorUnavailable(
  input: RetestSnapshot,
): Promise<CustomerGraphReadConnectionSnapshot> {
  const context = dbAccessContextFromAuth(input.auth);
  return withDbAccessContext(context, async () => requireCasRow(
    await db.update(m365Connections).set({
      status: input.status,
      lastErrorCode: 'executor_unavailable',
      updatedAt: new Date(),
    }).where(attemptPredicate(input)).returning(),
  ));
}

export async function retestCustomerGraphReadConnection(input: {
  id: string;
  orgId: string;
  auth: AuthContext;
  correlationId?: string;
  executorClient?: GraphReadExecutorClient;
}): Promise<CustomerGraphReadConnectionSnapshot> {
  return runOutsideDbContext(async () => {
    const retestSnapshot = await loadRetestSnapshot(input);
    let result: RetestResult;
    try {
      const client = input.executorClient ?? runtimeClient(loadM365CustomerGraphReadRuntimeConfig());
      result = await client.retestCustomerGraphRead({
        correlationId: input.correlationId ?? randomUUID(),
        tenantId: retestSnapshot.tenantId,
      });
    } catch {
      return recordRetestExecutorUnavailable(retestSnapshot);
    }
    return applyRetestResult(retestSnapshot, result);
  });
}

export async function disconnectCustomerGraphReadConnection(input: {
  id: string;
  orgId: string;
  actorId: string;
}): Promise<CustomerGraphReadConnectionSnapshot> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = await db.select().from(m365Connections).where(and(
      eq(m365Connections.id, input.id),
      eq(m365Connections.orgId, input.orgId),
      eq(m365Connections.profile, PROFILE),
    )).limit(1).for('update');
    const current = rows[0];
    if (!current?.orgId || !current.consentAttemptId) {
      throw lifecycleError('connection_not_found');
    }
    await deleteConsentSessionsForAttemptInTransaction({
      connectionId: current.id,
      orgId: current.orgId,
      consentAttemptId: current.consentAttemptId,
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
      profile: PROFILE,
      consentAttemptId: current.consentAttemptId,
      status: current.status,
    })).returning());
  }));
}
