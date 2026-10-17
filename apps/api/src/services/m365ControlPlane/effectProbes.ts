/**
 * Read-side verification probes for the M365 identity write catalog
 * (Operator Recipe Library spec §6.6, wave M1 #6170).
 *
 * "There is no executor-side dedup store and Graph takes no idempotency key.
 * Every effect is therefore probe → write → probe." This module is the probe:
 * one typed observation per write action id.
 *
 * Contract:
 *   - Probes are READ-ONLY. A probe never mutates anything.
 *   - `unknown` is the only answer when observation fails (a refusal, a
 *     throttle, a missing field, an unresolvable target). `unsatisfied` means
 *     "we looked and it is not done" and invites a retry, so it is only ever
 *     returned from a successful read that shows the opposite state.
 *   - Seven probes read through the `customer-graph-read` connection
 *     (executeM365ReadActionByOrg, ambient db context). The auto-reply probe
 *     cannot — that profile holds no MailboxSettings.Read, and adding it would
 *     force a second re-consent (spec §7.2) — so it runs the actions
 *     executor's read-only `m365.user.mailbox.auto_reply.state` arm. It is the
 *     one probe that consumes the WRITE budget and writes an `action_executed`
 *     audit row (outcome `ok` = the read succeeded, not that the reply matched).
 *
 * Keep this module free of `services/aiOperator/` imports: the operator's
 * effect-probe registry adapts it (aiOperator/effectProbes/m365.ts), not the
 * other way round.
 */
import type {
  M365InteractiveReadAction,
  M365MutatingAction,
  M365WriteActionId,
} from '@breeze/shared/m365';
import { executeM365ReadActionByOrg, type M365ReadActionServiceResult } from './readActionService';
import { executeM365WriteActionByOrg } from './writeActionService';

export type M365EffectProbeState = 'satisfied' | 'unsatisfied' | 'unknown';

export interface M365EffectProbeResult {
  state: M365EffectProbeState;
  /** ISO-8601 instant of the observation. */
  observedAt: string;
  detail: string;
}

export interface M365EffectProbeContext {
  orgId: string;
  /** When the write was (or is about to be) requested. */
  effectRequestedAt: Date;
  /**
   * `pre` decides whether to skip the write, so a pre-write `satisfied` must
   * rest on evidence that cannot also mean "wrong target" or "stale index";
   * `post` verifies. Required: a caller cannot forget which question it asks.
   */
  phase: 'pre' | 'post';
  actorId?: string;
}

const MAX_DETAIL_CHARS = 500;

type ProbeFn = (args: M365MutatingAction, ctx: M365EffectProbeContext, now: () => Date) => Promise<M365EffectProbeResult>;

function result(state: M365EffectProbeState, detail: string, now: () => Date): M365EffectProbeResult {
  return { state, observedAt: now().toISOString(), detail: detail.slice(0, MAX_DETAIL_CHARS) };
}

function read(ctx: M365EffectProbeContext, action: M365InteractiveReadAction): Promise<M365ReadActionServiceResult> {
  return executeM365ReadActionByOrg(ctx.orgId, action, ctx.actorId ? { actorId: ctx.actorId } : undefined);
}

function cannotObserve(what: string, outcome: Extract<M365ReadActionServiceResult, { ok: false }>): string {
  return `${what} could not be read (${outcome.code}), so the effect cannot be observed`;
}

/** The user resource, or the reason it could not be observed. */
async function readUser(
  ctx: M365EffectProbeContext,
  userIdOrUpn: string,
): Promise<{ user: Record<string, unknown> } | { failure: Extract<M365ReadActionServiceResult, { ok: false }> } | { notResource: true }> {
  const outcome = await read(ctx, { type: 'm365.user.get', userIdOrUpn });
  if (!outcome.ok) return { failure: outcome };
  if (outcome.kind !== 'resource') return { notResource: true };
  return { user: outcome.resource };
}

/** skuId -> disabled plan ids, or null when the projection is absent or malformed. */
function assignedLicenses(user: Record<string, unknown>): Map<string, Set<string>> | null {
  const raw = user.assignedLicenses;
  if (!Array.isArray(raw)) return null;
  const map = new Map<string, Set<string>>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || typeof (entry as { skuId?: unknown }).skuId !== 'string') return null;
    const plans = (entry as { disabledPlans?: unknown }).disabledPlans;
    if (plans !== undefined && !(Array.isArray(plans) && plans.every((p) => typeof p === 'string'))) return null;
    map.set((entry as { skuId: string }).skuId, new Set((plans as string[] | undefined) ?? []));
  }
  return map;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((v) => b.has(v));
}

/** Graph reports signInSessionsValidFromDateTime at whole-second precision. */
function wholeSecond(date: Date): number {
  return Math.floor(date.getTime() / 1000) * 1000;
}

const probeDisable: ProbeFn = async (args, ctx, now) => {
  if (args.type !== 'm365.user.disable') throw new Error('unreachable');
  const u = await readUser(ctx, args.userIdentifier);
  if ('failure' in u) return result('unknown', cannotObserve('The user', u.failure), now);
  if ('notResource' in u) return result('unknown', 'The user read returned an unexpected shape', now);
  if (u.user.accountEnabled === false) return result('satisfied', 'accountEnabled is false: sign-in is blocked', now);
  if (u.user.accountEnabled === true) return result('unsatisfied', 'accountEnabled is still true: sign-in is allowed', now);
  return result('unknown', 'accountEnabled was not returned, so the sign-in state cannot be observed', now);
};

const probeResetPassword: ProbeFn = async (_args, _ctx, now) => result(
  'unknown',
  'a password reset has no observable end state; verification is the operator receiving the credential',
  now,
);

const probeRevokeSessions: ProbeFn = async (args, ctx, now) => {
  if (args.type !== 'm365.user.revoke_sessions') throw new Error('unreachable');
  const u = await readUser(ctx, args.userIdentifier);
  if ('failure' in u) return result('unknown', cannotObserve('The user', u.failure), now);
  if ('notResource' in u) return result('unknown', 'The user read returned an unexpected shape', now);
  // Graph exposes no "sessions are gone" fact — only the instant before which
  // refresh tokens and session cookies are invalid. It must be at or after the
  // second the revoke was requested.
  const raw = u.user.signInSessionsValidFromDateTime;
  const cutoff = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  if (Number.isNaN(cutoff)) {
    return result('unsatisfied', 'signInSessionsValidFromDateTime was not returned, so no revoke is observable', now);
  }
  const requested = new Date(wholeSecond(ctx.effectRequestedAt)).toISOString();
  return cutoff >= wholeSecond(ctx.effectRequestedAt)
    ? result('satisfied', `signInSessionsValidFromDateTime ${String(raw)} is at or after the revoke request (${requested})`, now)
    : result('unsatisfied', `signInSessionsValidFromDateTime ${String(raw)} is before the revoke request (${requested})`, now);
};

const probeLicenseRemove: ProbeFn = async (args, ctx, now) => {
  if (args.type !== 'm365.user.license.remove') throw new Error('unreachable');
  const u = await readUser(ctx, args.userIdentifier);
  if ('failure' in u) return result('unknown', cannotObserve('The user', u.failure), now);
  if ('notResource' in u) return result('unknown', 'The user read returned an unexpected shape', now);
  const assigned = assignedLicenses(u.user);
  if (!assigned) return result('unknown', 'assignedLicenses was absent or malformed', now);
  const still = args.skuIds.filter((sku) => assigned.has(sku));
  return still.length === 0
    ? result('satisfied', `none of the ${args.skuIds.length} requested licence(s) is assigned`, now)
    : result('unsatisfied', `still assigned: ${still.join(', ')}`, now);
};

const probeLicenseAssign: ProbeFn = async (args, ctx, now) => {
  if (args.type !== 'm365.user.license.assign') throw new Error('unreachable');
  const u = await readUser(ctx, args.userIdentifier);
  if ('failure' in u) return result('unknown', cannotObserve('The user', u.failure), now);
  if ('notResource' in u) return result('unknown', 'The user read returned an unexpected shape', now);
  const assigned = assignedLicenses(u.user);
  if (!assigned) return result('unknown', 'assignedLicenses was absent or malformed', now);
  const wantedPlans = args.disabledPlanIds === undefined ? null : new Set(args.disabledPlanIds);
  const notDone = args.skuIds.filter((sku) => {
    const plans = assigned.get(sku);
    if (!plans) return true;
    return wantedPlans !== null && !sameSet(plans, wantedPlans);
  });
  return notDone.length === 0
    ? result('satisfied', `every requested licence (${args.skuIds.length}) is assigned as requested`, now)
    : result('unsatisfied', `not assigned as requested: ${notDone.join(', ')}`, now);
};

/** Shared by the two membership probes: resolve the user id, then read the targeted membership. */
async function observeMembership(
  ctx: M365EffectProbeContext,
  groupId: string,
  userIdentifier: string,
): Promise<{ member: boolean } | { unknown: string }> {
  const u = await readUser(ctx, userIdentifier);
  if ('failure' in u) return { unknown: cannotObserve('The user', u.failure) };
  if ('notResource' in u || typeof u.user.id !== 'string') return { unknown: 'The user id could not be resolved' };
  const userId = u.user.id;
  const outcome = await read(ctx, { type: 'm365.group.member.get', groupId, userId });
  if (!outcome.ok) return { unknown: cannotObserve('The group membership', outcome) };
  if (outcome.kind !== 'collection') return { unknown: 'The membership read returned an unexpected shape' };
  return { member: outcome.items.some((item) => item.id === userId) };
}

// Graph's membership index behind $filter is eventually consistent (seconds).
const EVENTUAL = 'observed through an eventually consistent membership index';

// Before the write, a lagging index could report the desired state the
// tenant does not hold, and a pre-write `satisfied` would skip the write.
// Both membership writes are idempotent (DELETE 404 / POST 400 are no-ops),
// so the pre-write answer is `unknown` and the write itself decides.
const PRE_WRITE_MEMBERSHIP = 'membership is not judged before the write: the index is eventually consistent and the write is idempotent';

const probeGroupRemove: ProbeFn = async (args, ctx, now) => {
  if (args.type !== 'm365.group.membership.remove') throw new Error('unreachable');
  const seen = await observeMembership(ctx, args.groupId, args.userIdentifier);
  if ('unknown' in seen) return result('unknown', seen.unknown, now);
  if (seen.member) return result('unsatisfied', `the user is still a direct member of the group (${EVENTUAL})`, now);
  return ctx.phase === 'pre'
    ? result('unknown', PRE_WRITE_MEMBERSHIP, now)
    : result('satisfied', `the user is not a direct member of the group (${EVENTUAL})`, now);
};

const probeGroupAdd: ProbeFn = async (args, ctx, now) => {
  if (args.type !== 'm365.group.membership.add') throw new Error('unreachable');
  const seen = await observeMembership(ctx, args.groupId, args.userIdentifier);
  if ('unknown' in seen) return result('unknown', seen.unknown, now);
  if (!seen.member) return result('unsatisfied', `the user is not yet a direct member of the group (${EVENTUAL})`, now);
  return ctx.phase === 'pre'
    ? result('unknown', PRE_WRITE_MEMBERSHIP, now)
    : result('satisfied', `the user is a direct member of the group (${EVENTUAL})`, now);
};

const RETIRED_STATES = new Set(['retirePending', 'retireIssued']);
const NOT_RETIRED_STATES = new Set(['managed', 'retireFailed', 'retireCanceled']);

const probeIntuneRetire: ProbeFn = async (args, ctx, now) => {
  if (args.type !== 'm365.intune.device.retire') throw new Error('unreachable');
  const outcome = await read(ctx, { type: 'm365.intune.device.get', deviceId: args.managedDeviceId });
  if (!outcome.ok) {
    if (outcome.code !== 'graph_not_found') return result('unknown', cannotObserve('The managed device', outcome), now);
    // After the retire, a missing record is the evidence: Intune deletes the
    // managedDevice once the device unenrols. Before it, a wrong or foreign
    // id 404s the same way, so it proves nothing and must not skip the write.
    return ctx.phase === 'pre'
      ? result('unknown', 'the managed device was not found before the retire; the retire itself will report a wrong id', now)
      : result('satisfied', 'the managed device record no longer exists (retired and unenrolled)', now);
  }
  if (outcome.kind !== 'resource') return result('unknown', 'The device read returned an unexpected shape', now);
  const state = outcome.resource.managementState;
  if (typeof state === 'string' && RETIRED_STATES.has(state)) {
    return result('satisfied', `managementState is ${state}: the retire was accepted and awaits device check-in`, now);
  }
  if (typeof state === 'string' && NOT_RETIRED_STATES.has(state)) {
    return result('unsatisfied', `managementState is ${state}: the device is not retired`, now);
  }
  return result('unknown', 'the managed device exists but its managementState was not recognised', now);
};

const probeCreateUser: ProbeFn = async (args, ctx, now) => {
  if (args.type !== 'm365.user.create') throw new Error('unreachable');
  const u = await readUser(ctx, args.userPrincipalName);
  if ('failure' in u) {
    return u.failure.code === 'graph_not_found'
      ? result('unsatisfied', 'no user exists with the requested sign-in name', now)
      : result('unknown', cannotObserve('The user', u.failure), now);
  }
  if ('notResource' in u || typeof u.user.id !== 'string') return result('unknown', 'The user read returned an unexpected shape', now);
  return result('satisfied', 'a user exists with the requested sign-in name', now);
};

const probeAutoReply: ProbeFn = async (args, ctx, now) => {
  if (args.type !== 'm365.user.mailbox.auto_reply') throw new Error('unreachable');
  const outcome = await executeM365WriteActionByOrg(
    ctx.orgId,
    { type: 'm365.user.mailbox.auto_reply.state', userIdentifier: args.userIdentifier },
    ctx.actorId ? { actorId: ctx.actorId } : undefined,
  );
  if (!outcome.ok) return result('unknown', `The automatic-reply setting could not be read (${outcome.code})`, now);
  const state = outcome.result;
  if (!state.success || state.action !== 'm365.user.mailbox.auto_reply.state') {
    return result('unknown', 'The automatic-reply read returned an unexpected shape', now);
  }
  if (state.status !== args.status) {
    return result('unsatisfied', `automatic replies are ${state.status}, not ${args.status}`, now);
  }
  if (args.externalAudience !== undefined && state.externalAudience !== args.externalAudience) {
    return result('unsatisfied', `external audience is ${state.externalAudience}, not ${args.externalAudience}`, now);
  }
  for (const [field, wanted, seen] of [
    ['scheduledStartDateTime', args.scheduledStartDateTime, state.scheduledStartDateTime],
    ['scheduledEndDateTime', args.scheduledEndDateTime, state.scheduledEndDateTime],
  ] as const) {
    if (wanted !== undefined && (seen === null || Date.parse(seen) !== Date.parse(wanted))) {
      return result('unsatisfied', `${field} is ${seen ?? 'unset'}, not ${wanted}`, now);
    }
  }
  if ((args.internalReplyMessage !== undefined && !state.hasInternalReplyMessage)
    || (args.externalReplyMessage !== undefined && !state.hasExternalReplyMessage)) {
    return result('unsatisfied', 'a requested reply message is not set', now);
  }
  // Message bodies are never read back (they may quote customer mail), so a
  // requested body cannot be confirmed. Before the write that is not enough to
  // skip it (rewriting the same reply is harmless); after it, the write's own
  // success plus the matching state is the evidence, and the detail says so.
  const bodyRequested = args.internalReplyMessage !== undefined || args.externalReplyMessage !== undefined;
  if (bodyRequested && ctx.phase === 'pre') {
    return result('unknown', 'automatic replies match, but a requested message body cannot be read back before the write', now);
  }
  return result(
    'satisfied',
    `automatic replies are ${state.status}${bodyRequested ? '; message presence matches (message bodies are not compared)' : ''}`,
    now,
  );
};

/** Total over the write ids: tsc fails the moment the catalog grows without a probe. */
const PROBES: Record<M365WriteActionId, ProbeFn> = {
  'm365.user.disable': probeDisable,
  'm365.user.reset_password': probeResetPassword,
  'm365.user.revoke_sessions': probeRevokeSessions,
  'm365.user.license.remove': probeLicenseRemove,
  'm365.user.license.assign': probeLicenseAssign,
  'm365.group.membership.remove': probeGroupRemove,
  'm365.group.membership.add': probeGroupAdd,
  'm365.intune.device.retire': probeIntuneRetire,
  'm365.user.create': probeCreateUser,
  'm365.user.mailbox.auto_reply': probeAutoReply,
};

export async function probeM365Effect(
  actionId: M365WriteActionId,
  args: M365MutatingAction,
  ctx: M365EffectProbeContext,
  now: () => Date = () => new Date(),
): Promise<M365EffectProbeResult> {
  if (args.type !== actionId) {
    throw new Error(`probeM365Effect: action id ${actionId} does not match args.type ${args.type}`);
  }
  return PROBES[actionId](args, ctx, now);
}
