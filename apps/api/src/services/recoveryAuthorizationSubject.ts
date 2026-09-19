import { createHash } from 'node:crypto';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { AiAgentKind } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  aiAgentRuns,
  aiAgents,
  apiKeys,
  devices,
  oauthClientBlocks,
  oauthClients,
  oauthGrants,
  servicePrincipals,
  users,
} from '../db/schema';
import type { AuthContext, PrincipalKind } from '../middleware/auth';
import { validateApiKeyScopeDelegation } from './apiKeyScopes';
import { resolveEffectiveAgent } from './aiAgents/effectivePolicy';
import { canAccessOrg, getUserPermissions, hasPermission, type UserPermissions } from './permissions';
import {
  authorizeResilienceResources,
  ResilienceAuthorizationError,
  type AuthorizedResilienceResources,
  type ResilienceOperation,
  type ResilienceResourceRef,
} from './resilienceSiteAuthorization';

export const RECOVERY_AUTHORIZATION_PRINCIPAL_KINDS = [
  'user_session',
  'client_user',
  'api_key',
  'oauth_grant',
  'ai_agent',
  'system',
  'unknown',
] as const;

export const RECOVERY_AUTHORIZATION_STATES = [
  'pending',
  'authorized',
  'denied',
  'quarantined_authorization_unknown',
  'not_required',
] as const;

export type RecoveryAuthorizationPrincipalKind = typeof RECOVERY_AUTHORIZATION_PRINCIPAL_KINDS[number];
export type RecoveryAuthorizationState = typeof RECOVERY_AUTHORIZATION_STATES[number];
export type RecoveryAuthorizationOperation = ResilienceOperation | 'c2c_restore' | 'c2c_sync';

export interface RecoveryAuthorizationIntent {
  operation: RecoveryAuthorizationOperation;
  requiredPermission?: { resource: string; action: string };
  requiredDelegatedScopesAny?: readonly string[];
  requiredAiTool?: string;
}

export interface RecoveryAuthorizationSubjectRow {
  authorizationPrincipalKind: RecoveryAuthorizationPrincipalKind;
  authorizationPrincipalId: string | null;
  authorizationGrantRevision: string | null;
  authorizationState: RecoveryAuthorizationState;
  authorizationDenialCode: string | null;
  authorizationCheckedAt: Date | null;
  /** Historical attribution fields are deliberately ignored. */
  createdBy?: string | null;
  initiatedBy?: string | null;
}

export interface CapturedRecoveryAuthorizationSubject extends RecoveryAuthorizationSubjectRow {
  authorizationPrincipalKind: Exclude<RecoveryAuthorizationPrincipalKind, 'unknown'>;
  authorizationPrincipalId: string;
  authorizationGrantRevision: string;
  authorizationState: 'pending';
  authorizationDenialCode: null;
  authorizationCheckedAt: null;
}

export interface LiveUserAuthorization {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  status: string;
  authEpoch: number;
  permissionsEpoch: number;
  permissions: UserPermissions | null;
}

export interface LiveApiKeyAuthorization {
  id: string;
  orgId: string;
  status: string;
  expiresAt: Date | null;
  updatedAt: Date;
  scopes: string[];
  principalType: string;
  principalId: string | null;
  createdBy: string;
}

export interface LiveServicePrincipalAuthorization {
  id: string;
  orgId: string;
  status: string;
  scopes: string[];
  updatedAt: Date;
}

export interface LiveOAuthGrantAuthorization {
  id: string;
  accountId: string;
  clientId: string;
  partnerId: string | null;
  orgId: string | null;
  scopes: string[];
  expiresAt: Date;
  revokedAt: Date | null;
  clientDisabledAt: Date | null;
  clientBlocked: boolean;
}

export interface LiveAiRunAuthorization {
  id: string;
  orgId: string;
  agentId: string;
  runStatus: string;
  agentEnabled: boolean;
  agentDisabledAt: Date | null;
  effectiveEnabled: boolean;
  effectiveMode: string;
  effectiveToolAllowlist: string[];
  effectivePolicyRevision: string;
  allowedSiteIds: string[];
}

export interface RecoveryAuthorizationSubjectDependencies {
  now(): Date;
  loadUser(id: string, orgId: string): Promise<LiveUserAuthorization | null>;
  loadApiKey(id: string, orgId: string): Promise<LiveApiKeyAuthorization | null>;
  loadServicePrincipal(id: string, orgId: string): Promise<LiveServicePrincipalAuthorization | null>;
  loadOAuthGrant(id: string, orgId: string): Promise<LiveOAuthGrantAuthorization | null>;
  loadAiRun(id: string, orgId: string): Promise<LiveAiRunAuthorization | null>;
  authorizeResilienceResources(input: {
    orgId: string;
    principal: { kind: PrincipalKind['kind']; permissions: UserPermissions };
    refs: readonly ResilienceResourceRef[];
    operation: ResilienceOperation;
  }): Promise<AuthorizedResilienceResources>;
}

export type RecoveryAuthorizationErrorCode =
  | 'authorization_subject_unknown'
  | 'unknown_principal'
  | 'principal_kind_not_supported'
  | 'principal_id_missing'
  | 'principal_inactive'
  | 'principal_disabled'
  | 'principal_expired'
  | 'principal_tenant_mismatch'
  | 'delegation_scope_denied'
  | 'base_permission_denied'
  | 'system_reason_not_allowed'
  | 'site_access_denied'
  | 'resource_not_found'
  | 'authorization_dependency_unavailable';

export class RecoveryAuthorizationDeniedError extends Error {
  readonly retriable = false;

  constructor(readonly code: RecoveryAuthorizationErrorCode) {
    super(code);
    this.name = 'RecoveryAuthorizationDeniedError';
  }
}

export class RecoveryAuthorizationTransientError extends Error {
  readonly retriable = true;

  constructor(readonly code: 'authorization_dependency_unavailable') {
    super(code);
    this.name = 'RecoveryAuthorizationTransientError';
  }
}

export interface RehydratedRecoveryAuthorizationSubject {
  principalKind: Exclude<RecoveryAuthorizationPrincipalKind, 'unknown'>;
  principalId: string;
  permissions: UserPermissions | null;
  delegatedScopes: string[];
  currentGrantRevision: string;
  storedGrantRevision: string;
  grantRevisionDrifted: boolean;
}

const SYSTEM_REASON_REVISIONS: Readonly<Record<string, Readonly<{
  revision: string;
  operations: readonly RecoveryAuthorizationOperation[];
}>>> = {
  'backup-verification-scheduler': {
    revision: 'system-recovery-v1',
    operations: ['verify'],
  },
  'c2c-sync-scheduler': {
    revision: 'system-recovery-v1',
    operations: ['c2c_sync'],
  },
};

const DEFAULT_INTENTS: Readonly<Record<RecoveryAuthorizationOperation, RecoveryAuthorizationIntent>> = {
  read: {
    operation: 'read',
    requiredPermission: { resource: 'backup', action: 'read' },
    requiredDelegatedScopesAny: ['ai:read', 'devices:read'],
  },
  restore: {
    operation: 'restore',
    requiredPermission: { resource: 'backup', action: 'write' },
    requiredDelegatedScopesAny: ['ai:execute', 'devices:execute'],
  },
  verify: {
    operation: 'verify',
    requiredPermission: { resource: 'backup', action: 'write' },
    requiredDelegatedScopesAny: ['ai:execute', 'devices:execute'],
  },
  token: {
    operation: 'token',
    requiredPermission: { resource: 'backup', action: 'write' },
    requiredDelegatedScopesAny: ['ai:execute', 'devices:execute'],
  },
  media: {
    operation: 'media',
    requiredPermission: { resource: 'backup', action: 'write' },
    requiredDelegatedScopesAny: ['ai:execute', 'devices:execute'],
  },
  revoke: {
    operation: 'revoke',
    requiredPermission: { resource: 'backup', action: 'write' },
    requiredDelegatedScopesAny: ['ai:execute', 'devices:execute'],
  },
  c2c_restore: {
    operation: 'c2c_restore',
    requiredPermission: { resource: 'organizations', action: 'write' },
    requiredDelegatedScopesAny: ['ai:write'],
  },
  c2c_sync: {
    operation: 'c2c_sync',
    requiredPermission: { resource: 'organizations', action: 'write' },
    requiredDelegatedScopesAny: ['ai:write'],
  },
};

function normalizeIntent(intent: RecoveryAuthorizationOperation | RecoveryAuthorizationIntent): RecoveryAuthorizationIntent {
  if (typeof intent === 'string') return DEFAULT_INTENTS[intent];
  return { ...DEFAULT_INTENTS[intent.operation], ...intent };
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

function revision(material: unknown): string {
  // Grant revisions are deterministic audit checksums over non-secret IDs,
  // epochs, statuses, and scopes; they are not password verifiers.
  // codeql[js/insufficient-password-hash]
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(material))).digest('hex')}`;
}

async function dependencyRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (
      error instanceof RecoveryAuthorizationDeniedError
      || error instanceof RecoveryAuthorizationTransientError
    ) {
      throw error;
    }
    if (error instanceof ResilienceAuthorizationError) {
      throw new RecoveryAuthorizationDeniedError(error.code);
    }
    throw new RecoveryAuthorizationTransientError('authorization_dependency_unavailable');
  }
}

function requireKnownTuple(row: RecoveryAuthorizationSubjectRow): asserts row is RecoveryAuthorizationSubjectRow & {
  authorizationPrincipalKind: Exclude<RecoveryAuthorizationPrincipalKind, 'unknown'>;
  authorizationPrincipalId: string;
  authorizationGrantRevision: string;
} {
  if (row.authorizationPrincipalKind === 'unknown') {
    throw new RecoveryAuthorizationDeniedError('authorization_subject_unknown');
  }
  if (!row.authorizationPrincipalId?.trim() || !row.authorizationGrantRevision?.trim()) {
    throw new RecoveryAuthorizationDeniedError('principal_id_missing');
  }
}

function requireLiveUser(user: LiveUserAuthorization | null, orgId: string): LiveUserAuthorization {
  if (!user) throw new RecoveryAuthorizationDeniedError('principal_inactive');
  if (user.status !== 'active') throw new RecoveryAuthorizationDeniedError('principal_disabled');
  if (!user.permissions || !canAccessOrg(user.permissions, orgId)) {
    throw new RecoveryAuthorizationDeniedError('principal_inactive');
  }
  return user;
}

function requireDelegatedScope(scopes: readonly string[], intent: RecoveryAuthorizationIntent): void {
  const required = intent.requiredDelegatedScopesAny ?? [];
  if (required.length > 0 && !required.some((scope) => scopes.includes(scope))) {
    throw new RecoveryAuthorizationDeniedError('delegation_scope_denied');
  }
}

function expandOAuthRecoveryScopes(scopes: readonly string[]): string[] {
  const expanded = new Set(scopes);
  for (const scope of scopes) {
    if (scope === 'mcp:read') {
      expanded.add('ai:read');
    } else if (scope === 'mcp:write') {
      expanded.add('ai:read');
      expanded.add('ai:write');
    } else if (scope === 'mcp:execute') {
      expanded.add('ai:read');
      expanded.add('ai:write');
      expanded.add('ai:execute');
    }
  }
  return [...expanded];
}

function userRevision(kind: string, user: LiveUserAuthorization): string {
  return revision({
    kind,
    userId: user.id,
    authEpoch: user.authEpoch,
    permissionsEpoch: user.permissionsEpoch,
  });
}

function placeholderPermissions(orgId: string, allowedSiteIds?: string[]): UserPermissions {
  return {
    permissions: [],
    partnerId: null,
    orgId,
    roleId: 'queued-recovery-delegated-subject',
    scope: 'organization',
    allowedSiteIds,
  };
}

async function rehydrateKnownSubject(
  row: RecoveryAuthorizationSubjectRow & {
    authorizationPrincipalKind: Exclude<RecoveryAuthorizationPrincipalKind, 'unknown'>;
    authorizationPrincipalId: string;
    authorizationGrantRevision: string;
  },
  orgId: string,
  intent: RecoveryAuthorizationIntent,
  deps: RecoveryAuthorizationSubjectDependencies,
): Promise<Omit<RehydratedRecoveryAuthorizationSubject, 'storedGrantRevision' | 'grantRevisionDrifted'>> {
  switch (row.authorizationPrincipalKind) {
    case 'user_session':
    case 'client_user': {
      const user = requireLiveUser(
        await dependencyRead(() => deps.loadUser(row.authorizationPrincipalId, orgId)),
        orgId,
      );
      return {
        principalKind: row.authorizationPrincipalKind,
        principalId: user.id,
        permissions: user.permissions,
        delegatedScopes: [],
        currentGrantRevision: userRevision(row.authorizationPrincipalKind, user),
      };
    }
    case 'api_key': {
      const key = await dependencyRead(() => deps.loadApiKey(row.authorizationPrincipalId, orgId));
      if (!key || key.status !== 'active') throw new RecoveryAuthorizationDeniedError('principal_inactive');
      if (key.orgId !== orgId) throw new RecoveryAuthorizationDeniedError('principal_tenant_mismatch');
      if (key.expiresAt && key.expiresAt <= deps.now()) {
        throw new RecoveryAuthorizationDeniedError('principal_expired');
      }
      requireDelegatedScope(key.scopes, intent);

      if (key.principalType === 'service') {
        if (!key.principalId) throw new RecoveryAuthorizationDeniedError('principal_inactive');
        const principal = await dependencyRead(() => deps.loadServicePrincipal(key.principalId!, orgId));
        if (!principal || principal.status !== 'active') {
          throw new RecoveryAuthorizationDeniedError('principal_disabled');
        }
        if (principal.orgId !== orgId) throw new RecoveryAuthorizationDeniedError('principal_tenant_mismatch');
        if (key.scopes.some((scope) => !principal.scopes.includes(scope))) {
          throw new RecoveryAuthorizationDeniedError('delegation_scope_denied');
        }
        return {
          principalKind: 'api_key',
          principalId: key.id,
          permissions: null,
          delegatedScopes: [...key.scopes],
          currentGrantRevision: revision({
            kind: 'service_api_key',
            keyId: key.id,
            keyStatus: key.status,
            keyUpdatedAt: key.updatedAt,
            keyExpiresAt: key.expiresAt,
            keyScopes: [...key.scopes].sort(),
            servicePrincipalId: principal.id,
            servicePrincipalStatus: principal.status,
            servicePrincipalScopes: [...principal.scopes].sort(),
            servicePrincipalUpdatedAt: principal.updatedAt,
          }),
        };
      }

      const creator = requireLiveUser(
        await dependencyRead(() => deps.loadUser(key.createdBy, orgId)),
        orgId,
      );
      if (!validateApiKeyScopeDelegation(key.scopes, creator.permissions ?? undefined).ok) {
        throw new RecoveryAuthorizationDeniedError('delegation_scope_denied');
      }
      return {
        principalKind: 'api_key',
        principalId: key.id,
        permissions: creator.permissions,
        delegatedScopes: [...key.scopes],
        currentGrantRevision: revision({
          kind: 'human_api_key',
          keyId: key.id,
          keyStatus: key.status,
          keyUpdatedAt: key.updatedAt,
          keyExpiresAt: key.expiresAt,
          keyScopes: [...key.scopes].sort(),
          creatorId: creator.id,
          creatorAuthEpoch: creator.authEpoch,
          creatorPermissionsEpoch: creator.permissionsEpoch,
        }),
      };
    }
    case 'oauth_grant': {
      const grant = await dependencyRead(() => deps.loadOAuthGrant(row.authorizationPrincipalId, orgId));
      if (!grant) throw new RecoveryAuthorizationDeniedError('principal_inactive');
      if (grant.revokedAt || grant.clientDisabledAt || grant.clientBlocked) {
        throw new RecoveryAuthorizationDeniedError('principal_disabled');
      }
      if (grant.expiresAt <= deps.now()) throw new RecoveryAuthorizationDeniedError('principal_expired');
      if (grant.orgId && grant.orgId !== orgId) {
        throw new RecoveryAuthorizationDeniedError('principal_tenant_mismatch');
      }
      const delegatedScopes = expandOAuthRecoveryScopes(grant.scopes);
      requireDelegatedScope(delegatedScopes, intent);
      const account = requireLiveUser(
        await dependencyRead(() => deps.loadUser(grant.accountId, orgId)),
        orgId,
      );
      if (!grant.orgId && (!grant.partnerId || grant.partnerId !== account.partnerId)) {
        throw new RecoveryAuthorizationDeniedError('principal_tenant_mismatch');
      }
      return {
        principalKind: 'oauth_grant',
        principalId: grant.id,
        permissions: account.permissions,
        delegatedScopes,
        currentGrantRevision: revision({
          kind: 'oauth_grant',
          grantId: grant.id,
          accountId: grant.accountId,
          clientId: grant.clientId,
          partnerId: grant.partnerId,
          orgId: grant.orgId,
          expiresAt: grant.expiresAt,
          scopes: [...grant.scopes].sort(),
          delegatedScopes: [...delegatedScopes].sort(),
          accountAuthEpoch: account.authEpoch,
          accountPermissionsEpoch: account.permissionsEpoch,
          clientDisabledAt: grant.clientDisabledAt,
          clientBlocked: grant.clientBlocked,
        }),
      };
    }
    case 'ai_agent': {
      const run = await dependencyRead(() => deps.loadAiRun(row.authorizationPrincipalId, orgId));
      if (!run) throw new RecoveryAuthorizationDeniedError('principal_inactive');
      if (run.orgId !== orgId) throw new RecoveryAuthorizationDeniedError('principal_tenant_mismatch');
      if (run.runStatus !== 'running') {
        throw new RecoveryAuthorizationDeniedError('principal_inactive');
      }
      if (
        !run.agentEnabled
        || run.agentDisabledAt
        || !run.effectiveEnabled
        || run.effectiveMode === 'off'
      ) {
        throw new RecoveryAuthorizationDeniedError('principal_disabled');
      }
      if (run.allowedSiteIds.length === 0) {
        throw new RecoveryAuthorizationDeniedError('principal_inactive');
      }
      if (!intent.requiredAiTool || !run.effectiveToolAllowlist.includes(intent.requiredAiTool)) {
        throw new RecoveryAuthorizationDeniedError('delegation_scope_denied');
      }
      return {
        principalKind: 'ai_agent',
        principalId: run.id,
        permissions: placeholderPermissions(orgId, run.allowedSiteIds),
        delegatedScopes: [],
        currentGrantRevision: revision({
          kind: 'ai_agent',
          runId: run.id,
          agentId: run.agentId,
          runStatus: run.runStatus,
          effectivePolicyRevision: run.effectivePolicyRevision,
          effectiveEnabled: run.effectiveEnabled,
          effectiveMode: run.effectiveMode,
          effectiveToolAllowlist: [...run.effectiveToolAllowlist].sort(),
          allowedSiteIds: [...run.allowedSiteIds].sort(),
        }),
      };
    }
    case 'system': {
      const policy = SYSTEM_REASON_REVISIONS[row.authorizationPrincipalId];
      if (!policy || !policy.operations.includes(intent.operation)) {
        throw new RecoveryAuthorizationDeniedError('system_reason_not_allowed');
      }
      return {
        principalKind: 'system',
        principalId: row.authorizationPrincipalId,
        permissions: placeholderPermissions(orgId),
        delegatedScopes: [],
        currentGrantRevision: policy.revision,
      };
    }
  }
}

export async function rehydrateRecoveryAuthorizationSubject(
  row: RecoveryAuthorizationSubjectRow,
  orgId: string,
  operation: RecoveryAuthorizationOperation | RecoveryAuthorizationIntent,
  deps: RecoveryAuthorizationSubjectDependencies = defaultRecoveryAuthorizationSubjectDependencies,
): Promise<RehydratedRecoveryAuthorizationSubject> {
  requireKnownTuple(row);
  const live = await rehydrateKnownSubject(row, orgId, normalizeIntent(operation), deps);
  return {
    ...live,
    storedGrantRevision: row.authorizationGrantRevision,
    grantRevisionDrifted: row.authorizationGrantRevision !== live.currentGrantRevision,
  };
}

function stablePrincipalFor(auth: AuthContext): {
  kind: Exclude<RecoveryAuthorizationPrincipalKind, 'unknown'>;
  id: string;
} {
  switch (auth.principal.kind) {
    case 'user_session':
    case 'client_user':
      return { kind: auth.principal.kind, id: auth.user.id };
    case 'api_key':
      if (!auth.principal.apiKeyId) throw new RecoveryAuthorizationDeniedError('principal_id_missing');
      return { kind: 'api_key', id: auth.principal.apiKeyId };
    case 'oauth_grant':
      if (!auth.principal.grantId) throw new RecoveryAuthorizationDeniedError('principal_id_missing');
      return { kind: 'oauth_grant', id: auth.principal.grantId };
    case 'ai_agent':
      if (!auth.principal.runId) throw new RecoveryAuthorizationDeniedError('principal_id_missing');
      return { kind: 'ai_agent', id: auth.principal.runId };
    case 'system':
      if (!auth.principal.reason.trim()) throw new RecoveryAuthorizationDeniedError('principal_id_missing');
      return { kind: 'system', id: auth.principal.reason };
    case 'unknown':
      throw new RecoveryAuthorizationDeniedError('unknown_principal');
    case 'agent':
    case 'helper':
      throw new RecoveryAuthorizationDeniedError('principal_kind_not_supported');
  }
}

export async function captureRecoveryAuthorizationSubject(
  auth: AuthContext,
  orgId: string,
  operation: RecoveryAuthorizationOperation | RecoveryAuthorizationIntent,
  deps: RecoveryAuthorizationSubjectDependencies = defaultRecoveryAuthorizationSubjectDependencies,
): Promise<CapturedRecoveryAuthorizationSubject> {
  if (!auth.canAccessOrg(orgId) && auth.principal.kind !== 'system') {
    throw new RecoveryAuthorizationDeniedError('principal_tenant_mismatch');
  }
  const stable = stablePrincipalFor(auth);
  const provisional: CapturedRecoveryAuthorizationSubject = {
    authorizationPrincipalKind: stable.kind,
    authorizationPrincipalId: stable.id,
    authorizationGrantRevision: stable.kind === 'system'
      ? SYSTEM_REASON_REVISIONS[stable.id]?.revision ?? 'system-recovery-v1'
      : 'capture-pending-live-revision',
    authorizationState: 'pending',
    authorizationDenialCode: null,
    authorizationCheckedAt: null,
  };
  const live = await rehydrateRecoveryAuthorizationSubject(provisional, orgId, operation, deps);
  return {
    ...provisional,
    authorizationGrantRevision: live.currentGrantRevision,
  };
}

export async function authorizeQueuedRecoveryWork(
  row: RecoveryAuthorizationSubjectRow,
  orgId: string,
  refs: readonly ResilienceResourceRef[],
  operation: RecoveryAuthorizationOperation | RecoveryAuthorizationIntent,
  deps: RecoveryAuthorizationSubjectDependencies = defaultRecoveryAuthorizationSubjectDependencies,
): Promise<{
  subject: RehydratedRecoveryAuthorizationSubject;
  resources: AuthorizedResilienceResources;
}> {
  const intent = normalizeIntent(operation);
  const subject = await rehydrateRecoveryAuthorizationSubject(row, orgId, intent, deps);

  if (subject.principalKind !== 'system' && subject.principalKind !== 'ai_agent') {
    if (
      subject.permissions
      && intent.requiredPermission
      && !hasPermission(subject.permissions, intent.requiredPermission.resource, intent.requiredPermission.action)
    ) {
      throw new RecoveryAuthorizationDeniedError('base_permission_denied');
    }

    if (!subject.permissions) requireDelegatedScope(subject.delegatedScopes, intent);
  }

  const queuedOperation = intent.operation;
  if (queuedOperation === 'c2c_restore' || queuedOperation === 'c2c_sync') {
    return { subject, resources: { resources: [] } };
  }

  const resources = await dependencyRead(() => deps.authorizeResilienceResources({
    orgId,
    principal: {
      kind: subject.principalKind,
      permissions: subject.permissions ?? placeholderPermissions(orgId),
    },
    refs,
    operation: queuedOperation,
  }));
  return { subject, resources };
}

function grantShapeScopes(payload: unknown): Set<string> {
  const scopes = new Set<string>();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return scopes;
  const value = payload as {
    scope?: unknown;
    scopes?: unknown;
    openid?: unknown;
    resources?: unknown;
  };
  const add = (candidate: unknown) => {
    if (typeof candidate !== 'string') return;
    for (const scope of candidate.split(/\s+/).filter(Boolean)) scopes.add(scope);
  };

  add(value.scope);
  if (Array.isArray(value.scopes)) {
    for (const scope of value.scopes) add(scope);
  }
  if (value.openid && typeof value.openid === 'object' && !Array.isArray(value.openid)) {
    add((value.openid as { scope?: unknown }).scope);
  }
  if (value.resources && typeof value.resources === 'object' && !Array.isArray(value.resources)) {
    for (const resourceScopes of Object.values(value.resources)) add(resourceScopes);
  }
  return scopes;
}

export function extractRecoveryOAuthScopes(payload: unknown): string[] {
  const granted = grantShapeScopes(payload);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [...granted];
  const rejected = grantShapeScopes((payload as { rejected?: unknown }).rejected);
  for (const scope of rejected) granted.delete(scope);
  return [...granted];
}

async function inSystemContext<T>(work: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(work));
}

function systemAuth(orgId: string): AuthContext {
  return {
    principal: { kind: 'system', reason: 'queued-recovery-subject-rehydration' },
    user: { id: 'system', email: 'system@localhost', name: 'System', isPlatformAdmin: true },
    token: null,
    partnerId: null,
    orgId,
    scope: 'system',
    accessibleOrgIds: null,
    orgCondition: () => undefined,
    canAccessOrg: () => true,
  } as AuthContext;
}

export const defaultRecoveryAuthorizationSubjectDependencies: RecoveryAuthorizationSubjectDependencies = {
  now: () => new Date(),
  async loadUser(id, orgId) {
    const row = await inSystemContext(async () => {
      const [result] = await db.select({
        id: users.id,
        orgId: users.orgId,
        partnerId: users.partnerId,
        status: users.status,
        authEpoch: users.authEpoch,
        permissionsEpoch: users.permissionsEpoch,
      }).from(users).where(eq(users.id, id)).limit(1);
      return result ?? null;
    });
    if (!row) return null;
    const permissions = await getUserPermissions(id, { orgId, partnerId: row.partnerId });
    return { ...row, permissions };
  },
  async loadApiKey(id, orgId) {
    return inSystemContext(async () => {
      const [row] = await db.select({
        id: apiKeys.id,
        orgId: apiKeys.orgId,
        status: apiKeys.status,
        expiresAt: apiKeys.expiresAt,
        updatedAt: apiKeys.updatedAt,
        scopes: apiKeys.scopes,
        principalType: apiKeys.principalType,
        principalId: apiKeys.principalId,
        createdBy: apiKeys.createdBy,
      }).from(apiKeys).where(and(eq(apiKeys.id, id), eq(apiKeys.orgId, orgId))).limit(1);
      return row ? { ...row, scopes: row.scopes ?? [] } : null;
    });
  },
  async loadServicePrincipal(id, orgId) {
    return inSystemContext(async () => {
      const [row] = await db.select({
        id: servicePrincipals.id,
        orgId: servicePrincipals.orgId,
        status: servicePrincipals.status,
        scopes: servicePrincipals.scopes,
        updatedAt: servicePrincipals.updatedAt,
      }).from(servicePrincipals).where(and(
        eq(servicePrincipals.id, id),
        eq(servicePrincipals.orgId, orgId),
      )).limit(1);
      return row ? { ...row, scopes: row.scopes ?? [] } : null;
    });
  },
  async loadOAuthGrant(id, orgId) {
    return inSystemContext(async () => {
      const [grant] = await db.select({
        id: oauthGrants.id,
        accountId: oauthGrants.accountId,
        clientId: oauthGrants.clientId,
        partnerId: oauthGrants.partnerId,
        orgId: oauthGrants.orgId,
        payload: oauthGrants.payload,
        expiresAt: oauthGrants.expiresAt,
        revokedAt: oauthGrants.revokedAt,
        clientDisabledAt: oauthClients.disabledAt,
      }).from(oauthGrants)
        .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
        .where(eq(oauthGrants.id, id))
        .limit(1);
      if (!grant) return null;
      const now = new Date();
      const [block] = await db.select({ id: oauthClientBlocks.id })
        .from(oauthClientBlocks)
        .where(and(
          eq(oauthClientBlocks.orgId, orgId),
          eq(oauthClientBlocks.clientId, grant.clientId),
          or(isNull(oauthClientBlocks.blockedUntil), gt(oauthClientBlocks.blockedUntil, now)),
        ))
        .limit(1);
      return {
        ...grant,
        scopes: extractRecoveryOAuthScopes(grant.payload),
        clientBlocked: Boolean(block),
      };
    });
  },
  async loadAiRun(id, orgId) {
    return inSystemContext(async () => {
      const [run] = await db.select({
        id: aiAgentRuns.id,
        orgId: aiAgentRuns.orgId,
        agentId: aiAgentRuns.agentId,
        runStatus: aiAgentRuns.status,
        agentEnabled: aiAgents.enabled,
        agentDisabledAt: aiAgents.disabledAt,
        agentKind: aiAgents.kind,
        siteId: devices.siteId,
      }).from(aiAgentRuns)
        .innerJoin(aiAgents, eq(aiAgents.id, aiAgentRuns.agentId))
        .leftJoin(devices, eq(devices.id, aiAgentRuns.deviceId))
        .where(and(eq(aiAgentRuns.id, id), eq(aiAgentRuns.orgId, orgId)))
        .limit(1);
      if (!run) return null;
      const effective = await resolveEffectiveAgent(systemAuth(orgId), orgId, run.agentKind as AiAgentKind);
      if (!effective) return null;
      return {
        id: run.id,
        orgId: run.orgId,
        agentId: run.agentId,
        runStatus: run.runStatus,
        agentEnabled: run.agentEnabled,
        agentDisabledAt: run.agentDisabledAt,
        effectiveEnabled: effective.effective.enabled,
        effectiveMode: effective.effective.mode,
        effectiveToolAllowlist: effective.effective.toolAllowlist,
        effectivePolicyRevision: revision({
          schemaVersion: effective.schemaVersion,
          agentId: effective.agentId,
          effective: effective.effective,
          provenance: effective.provenance,
        }),
        allowedSiteIds: run.siteId ? [run.siteId] : [],
      };
    });
  },
  authorizeResilienceResources,
};
