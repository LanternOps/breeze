import {
  M365_READ_ACTION_FIELDS,
  m365SyncFailureCodeSchema,
  type M365SyncAction,
  type M365SyncActionResponse,
  type M365SyncActionResult,
  type M365SyncSourceState,
} from '@breeze/shared/m365';
import type { ExecutorSyncConfig } from '../config';
import type { SigninEventsLimiter } from '../signinEventsLimiter';
import type { SigninLimiter } from '../signinLimiter';
import { SyncContinuationError, type SyncContinuationCodec } from '../syncContinuation';
import {
  GraphClientError,
  type GraphSyncLimits,
  type GraphSyncPageSet,
  type MicrosoftGraphClient,
} from './graphClient';
import { project } from './readActions';
import {
  isUnlicensedSigninEventsError,
  signinEventsFilter,
  signinEventsTruncated,
  resolveSigninEventsWindow,
  SIGNIN_EVENTS_PATH,
} from './signinEvents';
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
  /** #5784 W05. /auditLogs/signIns has its OWN bucket — see signinEventsLimiter.ts. */
  signinEventsLimiter: SigninEventsLimiter;
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
   * `known` is false when the role-assignment enumeration itself failed or
   * was truncated, OR when any individual group's own member-page fetch
   * failed or was truncated — in every one of those cases we cannot tell
   * WHICH users are affected without the missing data, so adminRoles must be
   * null (unknown) for everyone rather than [] (definitely no assignment)
   * for whichever users happened to be enumerated so far.
   *
   * `known` stays true only when the top-level enumeration AND every group
   * we actually expanded were each read completely — the coarser "expansion
   * CAPPED at 50 distinct groups" case still leaves `known: true`, because
   * every group we did expand was read in full; `state` alone reports that
   * some groups beyond the cap were never looked at.
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
  // A truncated or failed group membership page means we cannot tell which
  // users it would have named — merging what we DID get would silently turn
  // "unknown" into "definitely not an admin" for those users. Once ANY
  // expanded group is incomplete, adminRoles becomes unknown for everyone
  // (see the RoleFacts.known doc comment): there is no way to narrow the
  // blast radius to only the affected users without the missing data.
  let groupMembershipIncomplete = false;
  const membersByGroup = new Map<string, string[]>();
  for (const groupId of expandable) {
    try {
      const members = await context.graphClient.readSyncCollection({
        accessToken: context.accessToken,
        path: `/groups/${encodeURIComponent(groupId)}/members`,
        query: { '$select': 'id', '$top': '999' },
        limits: limitsFor(context, context.limits.maxItemsUsers, { maxPages: 5 }),
      });
      if (members.stopReason !== 'complete') {
        state = 'error';
        groupMembershipIncomplete = true;
      }
      membersByGroup.set(
        groupId,
        members.items.map((member) => member.id).filter((id): id is string => typeof id === 'string'),
      );
    } catch (error) {
      // A non-group principal (service principal, deleted object) 404s. That is
      // information, not a failure — the group simply has no members to merge.
      if (!(error instanceof GraphClientError && error.code === 'graph_not_found')) {
        state = 'error';
        groupMembershipIncomplete = true;
      }
    }
  }
  if (groupMembershipIncomplete) return { state, known: false, byUserId };
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

const DEVICES_SELECT = M365_READ_ACTION_FIELDS['m365.sync.intune_devices'].join(',');
const CA_RETRY = { maxAttempts: 3, cumulativeBudgetMs: 60_000, fixedBackoffMs: 2_000 } as const;
const SECURE_SCORE_TOP_BACKFILL = 90;
const SECURE_SCORE_TOP_INCREMENTAL = 3;
const SECURE_SCORE_MAX_CONTROLS = 500;

// --- m365.sync.signin_activity ----------------------------------------------

async function syncSigninActivity(
  action: Extract<M365SyncAction, { type: 'm365.sync.signin_activity' }>,
  context: GraphSyncActionContext,
  fetchedAt: Date,
): Promise<M365SyncActionResponse> {
  // A bad continuation must fail loudly (tenant replay attempt or an expiry) —
  // silently restarting would hide both.
  const startUrl = action.continuation === undefined
    ? undefined
    : context.continuations.open({
      tenantId: context.tenantId, action: action.type, continuation: action.continuation,
    });

  let pageSet: GraphSyncPageSet;
  try {
    pageSet = await context.graphClient.readSyncCollection({
      accessToken: context.accessToken,
      path: '/users',
      query: { '$select': 'id,signInActivity', '$top': '500' },
      ...(startUrl === undefined ? {} : { startUrl }),
      limits: limitsFor(context, context.limits.maxItemsUsers, {
        maxPages: context.limits.signinPagesPerCall,
      }),
      beforePage: () => context.signinLimiter.tryTake(),
    });
  } catch (error) {
    // Graph answers 403 for signInActivity on a tenant without Entra ID P1.
    if (error instanceof GraphClientError
      && (error.code === 'graph_permission_missing' || error.code === 'graph_license_required')) {
      return succeed(action, [], {
        truncated: false, fetchedAt, sources: { signInActivity: 'unlicensed' },
      });
    }
    throw error;
  }

  const items = pageSet.items.flatMap((user) => {
    if (typeof user.id !== 'string') return [];
    const activity = user.signInActivity;
    const last = isRecord(activity) && typeof activity.lastSuccessfulSignInDateTime === 'string'
      ? activity.lastSuccessfulSignInDateTime
      : null;
    // lastSignInDateTime counts FAILED interactive attempts and is never projected.
    return [{ id: user.id, lastSuccessfulSignInAt: last }];
  });

  const resumeLink = pageSet.nextLink ?? (pageSet.stopReason === 'paused' ? startUrl : undefined);
  const continuation = resumeLink === undefined
    ? undefined
    : context.continuations.seal({ tenantId: context.tenantId, action: action.type, nextLink: resumeLink });

  return succeed(action, items, {
    truncated: pageSet.stopReason === 'max_items',
    fetchedAt,
    sources: { signInActivity: pageSet.stopReason === 'paused' ? 'throttled' : 'ok' },
    ...(continuation === undefined ? {} : { continuation }),
  });
}

// --- m365.sync.intune_devices ------------------------------------------------

async function syncIntuneDevices(
  action: Extract<M365SyncAction, { type: 'm365.sync.intune_devices' }>,
  context: GraphSyncActionContext,
  fetchedAt: Date,
): Promise<M365SyncActionResponse> {
  const pageSet = await context.graphClient.readSyncCollection({
    accessToken: context.accessToken,
    path: '/deviceManagement/managedDevices',
    query: { '$select': DEVICES_SELECT, '$top': '999' },
    limits: limitsFor(context, context.limits.maxItemsDevices),
  });
  return succeed(action, pageSet.items, {
    truncated: pageSet.stopReason !== 'complete',
    fetchedAt,
    sources: { managedDevices: 'ok' },
  });
}

// --- m365.sync.ca_policies -----------------------------------------------

async function syncCaPolicies(
  action: Extract<M365SyncAction, { type: 'm365.sync.ca_policies' }>,
  context: GraphSyncActionContext,
  fetchedAt: Date,
): Promise<M365SyncActionResponse> {
  // No $select: conditions/grantControls/sessionControls are whole objects and
  // Graph's CA endpoint is 1 req/s per tenant with NO Retry-After on 429, so a
  // fixed backoff replaces header-driven waiting (spec §4.1).
  const pageSet = await context.graphClient.readSyncCollection({
    accessToken: context.accessToken,
    path: '/identity/conditionalAccess/policies',
    limits: limitsFor(context, context.limits.maxItemsCaPolicies, { retry: { ...CA_RETRY } }),
  });
  return succeed(action, pageSet.items, {
    truncated: pageSet.stopReason !== 'complete',
    fetchedAt,
    sources: { policies: 'ok' },
  });
}

// --- m365.sync.skus --------------------------------------------------------

async function syncSkus(
  action: Extract<M365SyncAction, { type: 'm365.sync.skus' }>,
  context: GraphSyncActionContext,
  fetchedAt: Date,
): Promise<M365SyncActionResponse> {
  const pageSet = await context.graphClient.readSyncCollection({
    accessToken: context.accessToken,
    path: '/subscribedSkus',   // rejects $top
    limits: limitsFor(context, context.limits.maxItemsSkus, { maxPages: 5 }),
  });
  const items = pageSet.items.map((sku) => {
    const prepaid = sku.prepaidUnits;
    return {
      ...sku,
      prepaidUnits: isRecord(prepaid)
        ? { enabled: prepaid.enabled ?? null, suspended: prepaid.suspended ?? null, warning: prepaid.warning ?? null }
        : null,
    };
  });
  return succeed(action, items, {
    truncated: pageSet.stopReason !== 'complete',
    fetchedAt,
    sources: { subscribedSkus: 'ok' },
  });
}

// --- m365.sync.secure_score ------------------------------------------------

async function syncSecureScore(
  action: Extract<M365SyncAction, { type: 'm365.sync.secure_score' }>,
  context: GraphSyncActionContext,
  fetchedAt: Date,
): Promise<M365SyncActionResponse> {
  const top = action.backfill === true ? SECURE_SCORE_TOP_BACKFILL : SECURE_SCORE_TOP_INCREMENTAL;
  const scores = await context.graphClient.readSyncCollection({
    accessToken: context.accessToken,
    path: '/security/secureScores',
    query: { '$top': String(top) },
    limits: limitsFor(context, top, { maxPages: 5 }),
  });

  let profileState: M365SyncSourceState = 'ok';
  const profiles = new Map<string, { title: string | null; maxScore: number | null }>();
  try {
    const profileSet = await context.graphClient.readSyncCollection({
      accessToken: context.accessToken,
      path: '/security/secureScoreControlProfiles',
      query: { '$select': 'id,title,maxScore,controlCategory' },
      limits: limitsFor(context, SECURE_SCORE_MAX_CONTROLS),
    });
    if (profileSet.stopReason !== 'complete') profileState = 'error';
    for (const profile of profileSet.items) {
      if (typeof profile.id !== 'string') continue;
      profiles.set(profile.id, {
        title: typeof profile.title === 'string' ? profile.title : null,
        maxScore: typeof profile.maxScore === 'number' ? profile.maxScore : null,
      });
    }
  } catch (error) {
    profileState = sourceStateFor(error);
  }

  const items = scores.items.map((score) => ({
    ...score,
    controlScores: Array.isArray(score.controlScores)
      ? score.controlScores.flatMap((control) => {
        if (!isRecord(control) || typeof control.controlName !== 'string') return [];
        const profile = profiles.get(control.controlName);
        return [{
          controlName: control.controlName,
          title: profile?.title ?? null,
          score: typeof control.score === 'number' ? control.score : null,
          maxScore: profile?.maxScore ?? null,
          implementationStatus: typeof control.implementationStatus === 'string'
            ? control.implementationStatus
            : null,
        }];
      })
      : [],
  }));

  return succeed(action, items, {
    truncated: scores.stopReason !== 'complete',
    fetchedAt,
    sources: { secureScores: 'ok', controlProfiles: profileState },
  });
}

// --- m365.sync.signin_events (#5784 W05) -----------------------------------

async function syncSigninEvents(
  action: Extract<M365SyncAction, { type: 'm365.sync.signin_events' }>,
  context: GraphSyncActionContext,
  fetchedAt: Date,
): Promise<M365SyncActionResponse> {
  // A bad continuation must fail loudly (tenant replay attempt or an expiry) —
  // silently restarting would hide both.
  const startUrl = action.continuation === undefined
    ? undefined
    : context.continuations.open({
      tenantId: context.tenantId, action: action.type, continuation: action.continuation,
    });

  const window = resolveSigninEventsWindow(action, fetchedAt);

  let pageSet: GraphSyncPageSet;
  try {
    pageSet = await context.graphClient.readSyncCollection({
      accessToken: context.accessToken,
      path: SIGNIN_EVENTS_PATH,
      query: {
        '$filter': signinEventsFilter(window),
        // Ascending: a continuation must resume where the last page stopped,
        // and Graph's default ordering on this endpoint is not guaranteed.
        '$orderby': 'createdDateTime',
        '$top': '1000',
      },
      ...(startUrl === undefined ? {} : { startUrl }),
      limits: limitsFor(context, context.limits.maxItemsSigninEvents),
      beforePage: () => context.signinEventsLimiter.tryTake(),
    });
  } catch (error) {
    // No Entra ID P1: a COMPLETE, zero-item success, not a retryable failure.
    if (isUnlicensedSigninEventsError(error)) {
      return succeed(action, [], {
        truncated: false, fetchedAt, sources: { signinEvents: 'unlicensed' },
      });
    }
    throw error;
  }

  const resumeLink = pageSet.nextLink ?? (pageSet.stopReason === 'paused' ? startUrl : undefined);
  const continuation = resumeLink === undefined
    ? undefined
    : context.continuations.seal({ tenantId: context.tenantId, action: action.type, nextLink: resumeLink });

  return succeed(action, pageSet.items, {
    truncated: signinEventsTruncated(pageSet),
    fetchedAt,
    sources: { signinEvents: pageSet.stopReason === 'paused' ? 'throttled' : 'ok' },
    ...(continuation === undefined ? {} : { continuation }),
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
      case 'm365.sync.signin_activity':
        return await syncSigninActivity(action, context, fetchedAt);
      case 'm365.sync.intune_devices':
        return await syncIntuneDevices(action, context, fetchedAt);
      case 'm365.sync.ca_policies':
        return await syncCaPolicies(action, context, fetchedAt);
      case 'm365.sync.skus':
        return await syncSkus(action, context, fetchedAt);
      case 'm365.sync.secure_score':
        return await syncSecureScore(action, context, fetchedAt);
      case 'm365.sync.signin_events':
        return await syncSigninEvents(action, context, fetchedAt);
      default: {
        const exhaustive: never = action;
        throw new Error(`Unhandled M365 sync action: ${JSON.stringify(exhaustive)}`);
      }
    }
  } catch (error) {
    return failureResponse(error);
  }
}
