import { randomInt } from 'node:crypto';
import type { M365WriteAction, WriteActionResult, WriteActionFailureCode } from '@breeze/shared/m365';
import { GraphClientError, type MicrosoftGraphClient } from './graphClient';
import type { OpaqueAccessToken } from './tokenClient';

export interface GraphWriteActionContext {
  accessToken: OpaqueAccessToken;
  graphClient: MicrosoftGraphClient;
}

const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*-_';
const ALL = LOWER + UPPER + DIGITS + SYMBOLS;

function pick(alphabet: string): string {
  // randomInt(alphabet.length) is always in [0, alphabet.length), so the
  // index is never out of range — the assertion just satisfies
  // noUncheckedIndexedAccess.
  return alphabet[randomInt(alphabet.length)]!;
}

/** 20 chars, at least one of each class, shuffled — satisfies default Entra
 *  password complexity without echoing any input. */
export function generateTemporaryPassword(): string {
  const required = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)];
  const rest = Array.from({ length: 16 }, () => pick(ALL));
  const chars = [...required, ...rest];
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    // i and j are always valid indices into chars (Fisher-Yates); the
    // assertions just satisfy noUncheckedIndexedAccess.
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

function mapGraphFailure(error: unknown, notFoundCode: WriteActionFailureCode = 'user_not_found'): WriteActionResult {
  if (error instanceof GraphClientError) {
    const code: WriteActionFailureCode =
      error.code === 'graph_not_found' ? notFoundCode
      : error.code === 'graph_throttled' ? 'graph_throttled'
      : error.code === 'graph_permission_missing' ? 'graph_permission_missing'
      : error.code === 'application_token_invalid' ? 'application_token_invalid'
      : error.code === 'graph_request_timeout' ? 'graph_request_timeout'
      : error.code === 'graph_transport_failed' ? 'graph_transport_failed'
      // The actions app never expects a licence-gated endpoint.
      : error.code === 'graph_license_required' ? 'graph_error'
      : 'graph_error';
    return error.retryAfterSeconds === undefined
      ? { success: false, errorCode: code }
      : { success: false, errorCode: code, retryAfterSeconds: error.retryAfterSeconds };
  }
  throw error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** A payload we cannot trust is treated as a Graph failure -> graph_error, never a write. */
function invalidPayload(): GraphClientError {
  return new GraphClientError('graph_response_invalid');
}

export async function resolveUserIdentifier(identifier: string, ctx: GraphWriteActionContext): Promise<string> {
  const resource = await ctx.graphClient.readResource({
    accessToken: ctx.accessToken,
    path: `/users/${encodeURIComponent(identifier)}`,
    select: ['id'],
  });
  const id = resource.id;
  if (typeof id !== 'string' || !id) throw new GraphClientError('graph_not_found');
  return id;
}

async function resolveUserId(action: { userIdentifier: string }, ctx: GraphWriteActionContext): Promise<string> {
  return resolveUserIdentifier(action.userIdentifier, ctx);
}

/**
 * Pre-read (spec §6.6 probe-before-write; fail closed): the user's current
 * licences, so remove/assign can skip no-op writes. Strictly validated — a
 * payload we cannot interpret must never be mistaken for "nothing assigned".
 * Returns skuId -> set of disabled plan ids.
 */
async function readAssignedLicenses(userId: string, ctx: GraphWriteActionContext): Promise<Map<string, Set<string>>> {
  const user = await ctx.graphClient.readResource({
    accessToken: ctx.accessToken,
    path: `/users/${encodeURIComponent(userId)}`,
    select: ['id', 'assignedLicenses'],
  });
  const licenses = user.assignedLicenses;
  if (!Array.isArray(licenses)) throw invalidPayload();
  const assigned = new Map<string, Set<string>>();
  for (const entry of licenses) {
    if (!isRecord(entry) || typeof entry.skuId !== 'string') throw invalidPayload();
    const plans = entry.disabledPlans;
    if (plans !== undefined && !isStringArray(plans)) throw invalidPayload();
    const set = assigned.get(entry.skuId) ?? new Set<string>();
    for (const plan of plans ?? []) set.add(plan);
    assigned.set(entry.skuId, set);
  }
  return assigned;
}

/**
 * Pre-read (spec §6.6 probe-before-write; fail closed): free seats per
 * subscribed SKU, so assign can refuse BEFORE calling assignLicense. A
 * malformed or truncated collection could hide the real answer, so it throws
 * instead of guessing.
 */
async function readFreeSeatSkuIds(ctx: GraphWriteActionContext): Promise<Set<string>> {
  const { items, truncated } = await ctx.graphClient.readCollection({
    accessToken: ctx.accessToken,
    path: '/subscribedSkus',
    query: { '$select': 'skuId,prepaidUnits,consumedUnits' },
    maxItems: 500,
    maxPages: 5,
  });
  if (truncated) throw invalidPayload();
  const free = new Set<string>();
  for (const item of items) {
    const prepaid = item.prepaidUnits;
    if (typeof item.skuId !== 'string'
      || !isRecord(prepaid)
      || typeof prepaid.enabled !== 'number'
      || typeof item.consumedUnits !== 'number') {
      throw invalidPayload();
    }
    if (prepaid.enabled - item.consumedUnits > 0) free.add(item.skuId);
  }
  return free;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((v) => b.has(v));
}

/**
 * Pre-read (spec §6.6 probe-before-write; fail closed): only directly-edited
 * groups are supported. Dynamic-membership and role-assignable groups are
 * refused BEFORE any membership call. An unreadable shape is a failure, not a
 * licence to write.
 */
async function groupIsDirectlyEditable(groupId: string, ctx: GraphWriteActionContext): Promise<boolean> {
  const group = await ctx.graphClient.readResource({
    accessToken: ctx.accessToken,
    path: `/groups/${encodeURIComponent(groupId)}`,
    select: ['id', 'groupTypes', 'isAssignableToRole'],
  });
  if (!isStringArray(group.groupTypes)) throw invalidPayload();
  return !group.groupTypes.includes('DynamicMembership') && group.isAssignableToRole !== true;
}

/**
 * Disambiguation read (spec §6.6; fail closed), used ONLY after a membership
 * POST was rejected: Graph answers 400 "already exist" for a duplicate member
 * but 400 is ambiguous, so confirm membership before calling it a no-op.
 * `userId` is a canonical GUID returned by resolveUserIdentifier, so splicing
 * it into $filter is safe. $filter on members needs advanced-query
 * (ConsistencyLevel: eventual + $count) — see
 * https://learn.microsoft.com/en-us/graph/aad-advanced-queries
 * Any doubt (absent, malformed, a failed read) reads as "not a member", so the
 * caller fails closed — except a cause the operator can act on (throttling, a
 * missing permission, a bad app token), which propagates with its own code,
 * and a non-Graph error, which is a bug and is never swallowed.
 */
const DISAMBIGUATION_CAUSES_KEPT = new Set(['graph_throttled', 'graph_permission_missing', 'application_token_invalid']);

async function isDirectMember(groupId: string, userId: string, ctx: GraphWriteActionContext): Promise<boolean> {
  try {
    const { items } = await ctx.graphClient.readCollection({
      accessToken: ctx.accessToken,
      path: `/groups/${encodeURIComponent(groupId)}/members`,
      query: { '$select': 'id', '$filter': `id eq '${userId}'`, '$count': 'true' },
      consistencyLevelEventual: true,
      maxItems: 1,
      maxPages: 1,
    });
    return items.some((item) => item.id === userId);
  } catch (error) {
    if (!(error instanceof GraphClientError) || DISAMBIGUATION_CAUSES_KEPT.has(error.code)) throw error;
    return false;
  }
}

/** Graph returns `{ dateTime: '2026-10-01T00:00:00.0000000', timeZone: 'UTC' }`. */
function parseGraphUtcInstant(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || typeof value.dateTime !== 'string' || value.timeZone !== 'UTC') throw invalidPayload();
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?$/.exec(value.dateTime);
  if (!match) throw invalidPayload();
  const date = new Date(`${match[1]}Z`);
  if (Number.isNaN(date.getTime())) throw invalidPayload();
  return date.toISOString();
}

/**
 * Graph's dateTimeTimeZone carries the zone in `timeZone`, so `dateTime` is
 * sent without an offset. The shared schema only admits `Z` instants
 * (z.string().datetime()), so dropping the `Z` is exact.
 */
function graphUtcDateTime(isoInstant: string): string {
  return isoInstant.replace(/Z$/, '');
}

const AUTO_REPLY_STATUSES =['disabled', 'alwaysEnabled', 'scheduled'] as const;
const EXTERNAL_AUDIENCES = ['none', 'contactsOnly', 'all'] as const;

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T {
  const hit = allowed.find((a) => a === value);
  if (hit === undefined) throw invalidPayload();
  return hit;
}

export async function executeGraphWriteAction(
  action: M365WriteAction,
  ctx: GraphWriteActionContext,
): Promise<WriteActionResult> {
  try {
    switch (action.type) {
      case 'm365.user.disable': {
        const userId = await resolveUserId(action, ctx);
        await ctx.graphClient.patch({
          accessToken: ctx.accessToken,
          path: `/users/${encodeURIComponent(userId)}`,
          body: { accountEnabled: false },
        });
        return { success: true, action: 'm365.user.disable', userId };
      }
      case 'm365.user.reset_password': {
        const userId = await resolveUserId(action, ctx);
        const temporaryPassword = generateTemporaryPassword();
        await ctx.graphClient.patch({
          accessToken: ctx.accessToken,
          path: `/users/${encodeURIComponent(userId)}`,
          body: { passwordProfile: { forceChangePasswordNextSignIn: true, password: temporaryPassword } },
        });
        return { success: true, action: 'm365.user.reset_password', userId, temporaryPassword, forceChangeNextSignIn: true };
      }
      case 'm365.user.revoke_sessions': {
        const userId = await resolveUserId(action, ctx);
        await ctx.graphClient.post({
          accessToken: ctx.accessToken,
          path: `/users/${encodeURIComponent(userId)}/revokeSignInSessions`,
          body: {},
        });
        return { success: true, action: 'm365.user.revoke_sessions', userId };
      }
      case 'm365.user.license.remove': {
        const userId = await resolveUserId(action, ctx);
        const assigned = await readAssignedLicenses(userId, ctx);
        const removedSkuIds = [...new Set(action.skuIds)].filter((sku) => assigned.has(sku));
        if (removedSkuIds.length === 0) {
          return { success: true, action: 'm365.user.license.remove', userId, removedSkuIds: [], noop: true };
        }
        await ctx.graphClient.post({
          accessToken: ctx.accessToken,
          path: `/users/${encodeURIComponent(userId)}/assignLicense`,
          body: { addLicenses: [], removeLicenses: removedSkuIds },
        });
        return { success: true, action: 'm365.user.license.remove', userId, removedSkuIds, noop: false };
      }
      case 'm365.user.license.assign': {
        const userId = await resolveUserId(action, ctx);
        const assigned = await readAssignedLicenses(userId, ctx);
        const requestedPlans = action.disabledPlanIds === undefined ? undefined : new Set(action.disabledPlanIds);
        const requested = [...new Set(action.skuIds)];
        const toAdd = requested.filter((sku) => {
          const current = assigned.get(sku);
          if (current === undefined) return true;
          return requestedPlans !== undefined && !sameSet(current, requestedPlans);
        });
        if (toAdd.length === 0) {
          return { success: true, action: 'm365.user.license.assign', userId, assignedSkuIds: [], noop: true };
        }
        // A SKU already assigned (with different plans) consumes no new seat.
        const needSeat = toAdd.filter((sku) => !assigned.has(sku));
        if (needSeat.length > 0) {
          const free = await readFreeSeatSkuIds(ctx);
          if (needSeat.some((sku) => !free.has(sku))) return { success: false, errorCode: 'license_unavailable' };
        }
        await ctx.graphClient.post({
          accessToken: ctx.accessToken,
          path: `/users/${encodeURIComponent(userId)}/assignLicense`,
          body: {
            addLicenses: toAdd.map((skuId) => ({ skuId, disabledPlans: action.disabledPlanIds ?? [] })),
            removeLicenses: [],
          },
        });
        return { success: true, action: 'm365.user.license.assign', userId, assignedSkuIds: toAdd, noop: false };
      }
      case 'm365.group.membership.remove': {
        const userId = await resolveUserId(action, ctx);
        const gate = await checkGroup(action.groupId, ctx);
        if (gate) return gate;
        try {
          await ctx.graphClient.del({
            accessToken: ctx.accessToken,
            path: `/groups/${encodeURIComponent(action.groupId)}/members/${encodeURIComponent(userId)}/$ref`,
          });
        } catch (error) {
          // 404 = already not a member = the desired end state. No membership
          // pre-read: an eventually consistent index cannot justify skipping a removal.
          if (error instanceof GraphClientError && error.code === 'graph_not_found') {
            return { success: true, action: 'm365.group.membership.remove', userId, groupId: action.groupId, noop: true };
          }
          throw error;
        }
        return { success: true, action: 'm365.group.membership.remove', userId, groupId: action.groupId, noop: false };
      }
      case 'm365.group.membership.add': {
        const userId = await resolveUserId(action, ctx);
        const gate = await checkGroup(action.groupId, ctx);
        if (gate) return gate;
        try {
          await ctx.graphClient.post({
            accessToken: ctx.accessToken,
            path: `/groups/${encodeURIComponent(action.groupId)}/members/$ref`,
            body: { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${userId}` },
          });
        } catch (error) {
          if (error instanceof GraphClientError && error.code === 'graph_provider_rejected') {
            if (await isDirectMember(action.groupId, userId, ctx)) {
              return { success: true, action: 'm365.group.membership.add', userId, groupId: action.groupId, noop: true };
            }
            return { success: false, errorCode: 'graph_error' };
          }
          throw error;
        }
        return { success: true, action: 'm365.group.membership.add', userId, groupId: action.groupId, noop: false };
      }
      case 'm365.intune.device.retire': {
        try {
          // RETIRE only: removes company data and leaves personal data. Full
          // device erasure is excluded from the catalog by design.
          await ctx.graphClient.post({
            accessToken: ctx.accessToken,
            path: `/deviceManagement/managedDevices/${encodeURIComponent(action.managedDeviceId)}/retire`,
            body: {},
          });
        } catch (error) {
          return mapGraphFailure(error, 'device_not_found');
        }
        return { success: true, action: 'm365.intune.device.retire', managedDeviceId: action.managedDeviceId };
      }
      case 'm365.user.create': {
        const temporaryPassword = generateTemporaryPassword();
        let created: Record<string, unknown> | null;
        try {
          // No pre-read and never retried: a second POST could mint a second object.
          created = await ctx.graphClient.post({
            accessToken: ctx.accessToken,
            path: '/users',
            body: {
              accountEnabled: true,
              displayName: action.displayName,
              mailNickname: action.mailNickname,
              userPrincipalName: action.userPrincipalName,
              usageLocation: action.usageLocation,
              passwordProfile: { forceChangePasswordNextSignIn: true, password: temporaryPassword },
            },
          });
        } catch (error) {
          if (error instanceof GraphClientError && error.code === 'graph_provider_rejected') {
            return { success: false, errorCode: await existingUserOutcome(action.userPrincipalName, ctx) };
          }
          throw error;
        }
        const userId = created?.id;
        if (typeof userId !== 'string' || !userId) return { success: false, errorCode: 'graph_error' };
        return {
          success: true,
          action: 'm365.user.create',
          userId,
          userPrincipalName: action.userPrincipalName,
          temporaryPassword,
          forceChangeNextSignIn: true,
        };
      }
      case 'm365.user.mailbox.auto_reply': {
        const userId = await resolveUserId(action, ctx);
        const setting: Record<string, unknown> = { status: action.status };
        if (action.externalAudience !== undefined) setting.externalAudience = action.externalAudience;
        if (action.internalReplyMessage !== undefined) setting.internalReplyMessage = action.internalReplyMessage;
        if (action.externalReplyMessage !== undefined) setting.externalReplyMessage = action.externalReplyMessage;
        if (action.scheduledStartDateTime !== undefined) {
          setting.scheduledStartDateTime = { dateTime: graphUtcDateTime(action.scheduledStartDateTime), timeZone: 'UTC' };
        }
        if (action.scheduledEndDateTime !== undefined) {
          setting.scheduledEndDateTime = { dateTime: graphUtcDateTime(action.scheduledEndDateTime), timeZone: 'UTC' };
        }
        await ctx.graphClient.patch({
          accessToken: ctx.accessToken,
          path: `/users/${encodeURIComponent(userId)}/mailboxSettings`,
          body: { automaticRepliesSetting: setting },
        });
        return { success: true, action: 'm365.user.mailbox.auto_reply', userId, status: action.status };
      }
      case 'm365.user.mailbox.auto_reply.state': {
        // Read-only probe. Only presence flags leave this function — never a message body.
        const userId = await resolveUserId(action, ctx);
        const settings = await ctx.graphClient.readResource({
          accessToken: ctx.accessToken,
          path: `/users/${encodeURIComponent(userId)}/mailboxSettings`,
          select: ['automaticRepliesSetting'],
        });
        const auto = settings.automaticRepliesSetting;
        if (!isRecord(auto)) throw invalidPayload();
        const present = (v: unknown) => typeof v === 'string' && v.length > 0;
        return {
          success: true,
          action: 'm365.user.mailbox.auto_reply.state',
          userId,
          status: oneOf(AUTO_REPLY_STATUSES, auto.status),
          externalAudience: oneOf(EXTERNAL_AUDIENCES, auto.externalAudience),
          hasInternalReplyMessage: present(auto.internalReplyMessage),
          hasExternalReplyMessage: present(auto.externalReplyMessage),
          scheduledStartDateTime: parseGraphUtcInstant(auto.scheduledStartDateTime),
          scheduledEndDateTime: parseGraphUtcInstant(auto.scheduledEndDateTime),
        };
      }
      default: {
        const exhaustive: never = action;
        throw new Error(`Unhandled M365 write action: ${JSON.stringify(exhaustive)}`);
      }
    }
  } catch (error) {
    return mapGraphFailure(error);
  }
}

/** Group gate for the membership arms: null = proceed, otherwise the terminal result. */
async function checkGroup(groupId: string, ctx: GraphWriteActionContext): Promise<WriteActionResult | null> {
  try {
    return (await groupIsDirectlyEditable(groupId, ctx))
      ? null
      : { success: false, errorCode: 'unsupported_group_type' };
  } catch (error) {
    // A missing group is not a missing user.
    return mapGraphFailure(error, 'graph_error');
  }
}

/**
 * After POST /users was rejected (400 is ambiguous): is there already a user
 * with this UPN? Found -> user_already_exists; anything else -> graph_error.
 */
async function existingUserOutcome(upn: string, ctx: GraphWriteActionContext): Promise<WriteActionFailureCode> {
  try {
    const existing = await ctx.graphClient.readResource({
      accessToken: ctx.accessToken,
      path: `/users/${encodeURIComponent(upn)}`,
      select: ['id'],
    });
    return typeof existing.id === 'string' && existing.id ? 'user_already_exists' : 'graph_error';
  } catch (error) {
    // The create itself was rejected; a failed follow-up read cannot change
    // that answer. A non-Graph error is a bug and is never swallowed.
    if (!(error instanceof GraphClientError)) throw error;
    return 'graph_error';
  }
}
