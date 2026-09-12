import {
  M365_READ_ACTION_FIELDS,
  m365SyncFailureCodeSchema,
  type M365SyncAction,
  type M365SyncActionResponse,
  type M365SyncActionResult,
  type M365SyncSourceState,
} from '@breeze/shared/m365';
import type { ExecutorSyncConfig } from '../config';
import type { SigninLimiter } from '../signinLimiter';
import { SyncContinuationError, type SyncContinuationCodec } from '../syncContinuation';
import {
  GraphClientError,
  type GraphSyncLimits,
  type GraphSyncPageSet,
  type MicrosoftGraphClient,
} from './graphClient';
import { project } from './readActions';
import type { OpaqueAccessToken } from './tokenClient';

/**
 * Whole-domain snapshot pulls (spec §4.1). One case per action; every case
 * finishes by projecting through M365_READ_ACTION_FIELDS, including the
 * computed fields, so the allowlist stays the only thing that leaves the
 * executor. Nested objects (adminRoles, prepaidUnits, controlScores) are built
 * key by key — a raw Graph object is never spread into a result.
 */

export const SYNC_DEADLINE_MS = 110_000;
export const SYNC_MAX_PAGES = 60;
export const SYNC_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
export const ROLE_GROUP_EXPANSION_CAP = 50;

const USERS_SELECT = [
  'id', 'userPrincipalName', 'displayName', 'mail', 'accountEnabled', 'jobTitle',
  'department', 'usageLocation', 'onPremisesSyncEnabled', 'createdDateTime', 'assignedLicenses',
].join(',');

export interface GraphSyncActionContext {
  accessToken: OpaqueAccessToken;
  graphClient: MicrosoftGraphClient;
  tenantId: string;
  limits: ExecutorSyncConfig;
  continuations: SyncContinuationCodec;
  signinLimiter: SigninLimiter;
  now?: () => Date;
  deadlineAt?: number;
}

interface DomainSources { [source: string]: M365SyncSourceState }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A secondary source's failure is a state, not an outcome (spec §6). */
function sourceStateFor(error: unknown): M365SyncSourceState {
  if (error instanceof GraphClientError) {
    if (error.code === 'graph_permission_missing') return 'permission_missing';
    if (error.code === 'graph_license_required') return 'unlicensed';
    if (error.code === 'graph_throttled') return 'throttled';
  }
  return 'error';
}

function failureResponse(error: unknown): M365SyncActionResponse {
  if (error instanceof SyncContinuationError) {
    return { success: false, code: 'continuation_invalid' };
  }
  if (error instanceof GraphClientError) {
    const parsed = m365SyncFailureCodeSchema.safeParse(error.code);
    // NB: `code` is both GraphClientError's own field name and the sync wire
    // field name. They are the same value but different contracts — the
    // safeParse is what stops an unmapped client code reaching the wire.
    const code = parsed.success ? parsed.data : 'graph_response_invalid' as const;
    return error.retryAfterSeconds === undefined
      ? { success: false, code }
      : { success: false, code, retryAfterSeconds: error.retryAfterSeconds };
  }
  throw error;
}

function limitsFor(
  context: GraphSyncActionContext,
  maxItems: number,
  over: Partial<GraphSyncLimits> = {},
): GraphSyncLimits {
  return {
    maxItems,
    maxPages: SYNC_MAX_PAGES,
    maxResponseBytes: SYNC_MAX_RESPONSE_BYTES,
    deadlineAt: context.deadlineAt ?? Date.now() + SYNC_DEADLINE_MS,
    ...over,
  };
}

function succeed(
  action: M365SyncAction,
  items: Record<string, unknown>[],
  options: { truncated: boolean; sources: DomainSources; fetchedAt: Date; continuation?: string },
): M365SyncActionResult {
  const fields = M365_READ_ACTION_FIELDS[action.type];
  return {
    success: true,
    kind: 'sync',
    items: items.map((item) => project(item, fields)),
    truncated: options.truncated,
    fetchedAt: options.fetchedAt.toISOString(),
    sources: options.sources,
    ...(options.continuation === undefined ? {} : { continuation: options.continuation }),
  };
}

// --- m365.sync.users -------------------------------------------------------

interface RegistrationFacts {
  state: M365SyncSourceState;
  byUserId: Map<string, { mfaRegistered: boolean | null; mfaCapable: boolean | null; defaultMfaMethod: string | null }>;
}

interface RoleFacts {
  state: M365SyncSourceState;
  /**
   * `known` is false only when the role-assignment enumeration itself failed
   * or was truncated — direct assignments are then entirely unknown, so
   * adminRoles must be null (unknown), not []. `known` stays true when the
   * enumeration succeeded even though some GROUP expansions were capped: the
   * direct assignments are still known-good, so [] correctly claims "no
   * known assignment" and `state` alone reports the incomplete expansion.
   */
  known: boolean;
  byUserId: Map<string, { roleTemplateId: string; displayName: string; viaGroupId?: string }[]>;
}

async function fetchRegistrationFacts(context: GraphSyncActionContext): Promise<RegistrationFacts> {
  const byUserId = new Map<string, { mfaRegistered: boolean | null; mfaCapable: boolean | null; defaultMfaMethod: string | null }>();
  let pageSet: GraphSyncPageSet;
  try {
    pageSet = await context.graphClient.readSyncCollection({
      accessToken: context.accessToken,
      path: '/reports/authenticationMethods/userRegistrationDetails',
      query: { '$top': '999' },
      limits: limitsFor(context, context.limits.maxItemsUsers),
    });
  } catch (error) {
    return { state: sourceStateFor(error), byUserId };
  }
  // A partial report would make every unseen user look unregistered. Discard it.
  if (pageSet.stopReason !== 'complete') return { state: 'error', byUserId };
  for (const row of pageSet.items) {
    if (typeof row.id !== 'string') continue;
    byUserId.set(row.id, {
      mfaRegistered: typeof row.isMfaRegistered === 'boolean' ? row.isMfaRegistered : null,
      mfaCapable: typeof row.isMfaCapable === 'boolean' ? row.isMfaCapable : null,
      defaultMfaMethod: typeof row.defaultMfaMethod === 'string' ? row.defaultMfaMethod : null,
    });
  }
  return { state: 'ok', byUserId };
}

async function fetchRoleFacts(
  context: GraphSyncActionContext,
  userIds: ReadonlySet<string>,
): Promise<RoleFacts> {
  const byUserId = new Map<string, { roleTemplateId: string; displayName: string; viaGroupId?: string }[]>();
  let pageSet: GraphSyncPageSet;
  try {
    pageSet = await context.graphClient.readSyncCollection({
      accessToken: context.accessToken,
      path: '/roleManagement/directory/roleAssignments',
      query: { '$expand': 'roleDefinition($select=id,templateId,displayName)' },
      limits: limitsFor(context, context.limits.maxItemsUsers),
    });
  } catch (error) {
    return { state: sourceStateFor(error), known: false, byUserId };
  }
  if (pageSet.stopReason !== 'complete') return { state: 'error', known: false, byUserId };

  function add(userId: string, role: { roleTemplateId: string; displayName: string; viaGroupId?: string }): void {
    const existing = byUserId.get(userId);
    if (existing) existing.push(role);
    else byUserId.set(userId, [role]);
  }

  const groupAssignments: { principalId: string; role: { roleTemplateId: string; displayName: string } }[] = [];
  for (const assignment of pageSet.items) {
    const definition = assignment.roleDefinition;
    if (typeof assignment.principalId !== 'string' || !isRecord(definition)) continue;
    if (typeof definition.templateId !== 'string' || typeof definition.displayName !== 'string') continue;
    const role = { roleTemplateId: definition.templateId, displayName: definition.displayName };
    if (userIds.has(assignment.principalId)) add(assignment.principalId, role);
    else groupAssignments.push({ principalId: assignment.principalId, role });
  }

  // Principals that are not users are candidate role-assignable groups. Sorted
  // so the cap always truncates the same tail. Nested groups are NOT followed.
  const uniquePrincipals = [...new Set(groupAssignments.map((entry) => entry.principalId))].sort();
  const expandable = uniquePrincipals.slice(0, ROLE_GROUP_EXPANSION_CAP);
  let state: M365SyncSourceState = uniquePrincipals.length > expandable.length ? 'error' : 'ok';
  const membersByGroup = new Map<string, string[]>();
  for (const groupId of expandable) {
    try {
      const members = await context.graphClient.readSyncCollection({
        accessToken: context.accessToken,
        path: `/groups/${encodeURIComponent(groupId)}/members`,
        query: { '$select': 'id', '$top': '999' },
        limits: limitsFor(context, context.limits.maxItemsUsers, { maxPages: 5 }),
      });
      if (members.stopReason !== 'complete') state = 'error';
      membersByGroup.set(
        groupId,
        members.items.map((member) => member.id).filter((id): id is string => typeof id === 'string'),
      );
    } catch (error) {
      // A non-group principal (service principal, deleted object) 404s. That is
      // information, not a failure.
      if (!(error instanceof GraphClientError && error.code === 'graph_not_found')) state = 'error';
    }
  }
  for (const { principalId, role } of groupAssignments) {
    for (const memberId of membersByGroup.get(principalId) ?? []) {
      if (userIds.has(memberId)) add(memberId, { ...role, viaGroupId: principalId });
    }
  }
  return { state, known: true, byUserId };
}

async function syncUsers(
  action: Extract<M365SyncAction, { type: 'm365.sync.users' }>,
  context: GraphSyncActionContext,
  fetchedAt: Date,
): Promise<M365SyncActionResponse> {
  const primary = await context.graphClient.readSyncCollection({
    accessToken: context.accessToken,
    path: '/users',
    query: { '$select': USERS_SELECT, '$top': '999' },
    limits: limitsFor(context, context.limits.maxItemsUsers),
  });

  const userIds = new Set(
    primary.items.map((user) => user.id).filter((id): id is string => typeof id === 'string'),
  );
  const registration = await fetchRegistrationFacts(context);
  const roles = await fetchRoleFacts(context, userIds);

  const items = primary.items.flatMap((user) => {
    if (typeof user.id !== 'string') return [];
    const facts = registration.state === 'ok' ? registration.byUserId.get(user.id) : undefined;
    return [{
      ...user,
      assignedLicenses: Array.isArray(user.assignedLicenses)
        ? user.assignedLicenses
          .map((license) => (isRecord(license) && typeof license.skuId === 'string' ? license.skuId : undefined))
          .filter((skuId): skuId is string => skuId !== undefined)
        : [],
      // null, never false: the report lags and excludes some accounts (spec §4.1).
      mfaRegistered: facts?.mfaRegistered ?? null,
      mfaCapable: facts?.mfaCapable ?? null,
      defaultMfaMethod: facts?.defaultMfaMethod ?? null,
      // null = unknown; [] = definitely no active assignment.
      adminRoles: roles.known ? (roles.byUserId.get(user.id) ?? []) : null,
    }];
  });

  return succeed(action, items, {
    truncated: primary.stopReason !== 'complete',
    fetchedAt,
    sources: { users: 'ok', mfaRegistration: registration.state, roleAssignments: roles.state },
  });
}

export async function executeGraphSyncAction(
  action: M365SyncAction,
  context: GraphSyncActionContext,
): Promise<M365SyncActionResponse> {
  const fetchedAt = (context.now ?? (() => new Date()))();
  try {
    switch (action.type) {
      case 'm365.sync.users':
        return await syncUsers(action, context, fetchedAt);
      default: {
        const exhaustive: never = action as never;
        throw new Error(`Unhandled M365 sync action: ${JSON.stringify(exhaustive)}`);
      }
    }
  } catch (error) {
    return failureResponse(error);
  }
}
