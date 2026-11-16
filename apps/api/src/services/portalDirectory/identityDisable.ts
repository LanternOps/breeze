/**
 * The shared identity writer (portal registration W8 #11385, plan Task 3;
 * D1, D2, D3, D8g, D9, D12, D13; OD3). W9 (SCIM) reuses it.
 *
 *  - {@link disablePortalIdentity} adds ONE blocker to an identity, runs the
 *    spec §5.11 account rule, bumps `auth_epoch` on the first blocker, applies
 *    the run's action and audits — one system transaction — then purges the
 *    browser and add-in sessions after commit.
 *  - {@link restorePortalIdentity} is the ONLY writer that clears blockers
 *    (MSP Restore, D9).
 *  - {@link removeDisabledPortalIdentity} deletes one identity row disabled by
 *    a directory blocker (OD3: a person deleted and recreated in the directory
 *    has a new subject; the old disabled row would otherwise block linking it).
 *
 * LOCK ORDER (D3, D8g), every writer here: the `(org, source)` advisory lock,
 * then the account `FOR UPDATE`, then the identity `FOR UPDATE`. Each opens
 * its own `withSystemDbAccessContext` and refuses to run inside a held context
 * (request callers go through `runOutsideDbContext`), so its transaction
 * commits on its own, the after-commit purge sees committed state, and a
 * route's catch of a refusal never poisons the request transaction.
 *
 * Account columns are written here directly (not with orgPortalUsers.ts's
 * `stateSet`): the epoch rule differs — an identity disable bumps the epoch on
 * the FIRST blocker whatever the account transition says (D2) — and the
 * writer census reads each writer's own `disabledBy` write.
 */
import { and, count, desc, eq, gte, isNull, lt, ne, sql } from 'drizzle-orm';
import { db, hasDbAccessContext, withSystemDbAccessContext } from '../../db';
import { auditLogs, portalDirectoryActions, portalUserIdentities, portalUsers } from '../../db/schema';
import type { PortalAccountDisabledBy } from '../../db/schema/portal';
import { purgePortalSessionsForUsers } from '../../routes/portal/helpers';
import { ANONYMOUS_ACTOR_ID } from '../auditEvents';
import { markRequestAuditWritten } from '../auditRequestTracking';
import { purgeClientAiSessionsForUsers } from '../clientAiSessionStore';
import { resolvePortalAccessPolicy } from '../portalAccessPolicy';
import {
  isPasswordEligible,
  passwordUsableFor,
  planPortalAccountTransition,
  type PortalAccountFacts,
} from '../portalAccountState';
import { lockIdentityForAccount, type LockedPortalIdentity } from '../portalUserIdentities';
import { getRedis } from '../redis';
import type {
  DirectorySource,
  DisableIdentityInput,
  DisableIdentityResult,
  IdentityBlocker,
} from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIRECTORY_BLOCKERS: ReadonlySet<IdentityBlocker> = new Set<IdentityBlocker>(['entra_directory', 'google_directory']);
/** Purges of applied actions are retried for this long (OD2); the epoch already ended the sessions. */
export const PURGE_RETRY_WINDOW_MS = 24 * 3600_000;
const PURGE_RETRY_BATCH = 500;

export const AUDIT_IDENTITY_DISABLE = 'portal.directory.identity.disable';
export const AUDIT_IDENTITY_RESTORE = 'organization.portal_user.identity.restore';
export const AUDIT_IDENTITY_REMOVE = 'organization.portal_user.identity.remove';
/** W9 (#11386, plan D10): a SCIM `active: true` lifted the `scim` blocker. */
export const AUDIT_SCIM_USER_REACTIVATE = 'portal.scim.user.reactivate';
const AUDIT_PORTAL_USER_UPDATE = 'organization.portal_user.update';

export type PortalDirectoryIdentityErrorCode =
  | 'PORTAL_IDENTITY_NOT_FOUND'
  | 'PORTAL_IDENTITY_NOT_DISABLED'
  | 'PORTAL_IDENTITY_NOT_DIRECTORY_DISABLED'
  | 'PORTAL_ACCOUNT_MSP_DISABLED_CONFIRM'
  // The run store's Apply / Dismiss (runDecisions.ts, D7 / D8d / D8e).
  | 'PORTAL_DIRECTORY_RUN_NOT_FOUND'
  | 'PORTAL_DIRECTORY_RUN_NOT_HELD'
  | 'PORTAL_DIRECTORY_RUN_STALE'
  | 'PORTAL_DIRECTORY_ENFORCEMENT_OFF';

/** A refusal of Restore / remove / Apply / Dismiss; a route maps `code` + `httpStatus` as is. */
export class PortalDirectoryIdentityError extends Error {
  constructor(
    readonly code: PortalDirectoryIdentityErrorCode,
    readonly httpStatus: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'PortalDirectoryIdentityError';
  }
}

const notFound = () => new PortalDirectoryIdentityError('PORTAL_IDENTITY_NOT_FOUND', 404, 'Sign-in method not found.');

/** The directory a blocker belongs to, or null for `scim` / `msp`. */
export function directorySourceOfBlocker(blocker: IdentityBlocker): DirectorySource | null {
  if (blocker === 'entra_directory') return 'entra';
  if (blocker === 'google_directory') return 'google';
  return null;
}

/**
 * D8g: serializes capture, evaluation, apply, dismiss and Restore per
 * `(org, source)`. Taken before any row lock, inside the caller's transaction.
 */
export async function lockPortalDirectorySource(orgId: string, source: DirectorySource): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`portal-directory:${orgId}:${source}`}))`);
}

/**
 * D2, the account rule — pure, shared with the run store's preview. After the
 * identity is disabled, the account goes too only when nothing else signs in:
 * no other enabled identity and no usable password. An already-disabled
 * account is never touched (its `disabled_by` stays), and keeps no password
 * access. `keepsPassword` tags a leaver whose password still signs in (OD4).
 */
export function previewAccountEffect(facts: { otherUsableIdentities: number; passwordUsable: boolean; status: string }): {
  effect: 'identity' | 'identity_and_account';
  keepsPassword: boolean;
} {
  if (facts.status === 'disabled') return { effect: 'identity', keepsPassword: false };
  if (facts.otherUsableIdentities > 0 || facts.passwordUsable) {
    return { effect: 'identity', keepsPassword: facts.passwordUsable };
  }
  return { effect: 'identity_and_account', keepsPassword: false };
}

export function assertNoHeldContext(operation: string): void {
  if (hasDbAccessContext()) {
    throw new Error(
      `${operation} opens its own system-scope transaction and must not run inside a held DB context — `
      + 'call it through runOutsideDbContext',
    );
  }
}

interface LockedAccount {
  id: string;
  status: string;
  browserAccess: string;
  authMethod: string;
  passwordHash: string | null;
  disabledBy: PortalAccountDisabledBy | null;
}

interface LockedPair {
  account: LockedAccount;
  identity: LockedPortalIdentity;
  subject: string;
}

/** The identity's owner, unlocked (to learn the account and provider before the lock order starts). */
async function readIdentityOwner(orgId: string, identityId: string, portalUserId?: string) {
  const [row] = await db
    .select({
      portalUserId: portalUserIdentities.portalUserId,
      provider: portalUserIdentities.provider,
      subject: portalUserIdentities.subject,
      entraTenantId: portalUserIdentities.entraTenantId,
    })
    .from(portalUserIdentities)
    .where(and(
      eq(portalUserIdentities.id, identityId),
      eq(portalUserIdentities.orgId, orgId),
      ...(portalUserId ? [eq(portalUserIdentities.portalUserId, portalUserId)] : []),
    ))
    .limit(1);
  return row ?? null;
}

/** D3: the account `FOR UPDATE`, then the identity `FOR UPDATE`; null when either moved or vanished. */
async function lockAccountThenIdentity(orgId: string, portalUserId: string, identityId: string, subject: string): Promise<LockedPair | null> {
  const [account] = await db
    .select({
      id: portalUsers.id,
      status: portalUsers.status,
      browserAccess: portalUsers.browserAccess,
      authMethod: portalUsers.authMethod,
      passwordHash: portalUsers.passwordHash,
      disabledBy: portalUsers.disabledBy,
    })
    .from(portalUsers)
    .where(and(eq(portalUsers.id, portalUserId), eq(portalUsers.orgId, orgId)))
    .for('update')
    .limit(1);
  if (!account) return null;
  const identity = await lockIdentityForAccount(db, identityId);
  if (!identity || identity.orgId !== orgId || identity.portalUserId !== account.id) return null;
  return { account, identity, subject };
}

/** Hash + password-eligible + the org's effective `password_mode = 'allowed'` (D3). Reads the policy only when it can matter. */
async function passwordUsable(orgId: string, account: LockedAccount): Promise<boolean> {
  if (!account.passwordHash || !isPasswordEligible(account)) return false;
  const policy = await resolvePortalAccessPolicy(orgId);
  return passwordUsableFor({ hasPasswordHash: true, authMethod: account.authMethod }, policy.effective.passwordMode.value);
}

async function insertAudit(row: typeof auditLogs.$inferInsert): Promise<void> {
  await db.insert(auditLogs).values(row);
}

// ---------------------------------------------------------------------------
// Disable
// ---------------------------------------------------------------------------

type DisableCommitted = {
  result: DisableIdentityResult;
  /** The epoch moved: purge after commit. */
  purge: boolean;
};

/**
 * Plan Task 3 rules 1–10, in one system transaction:
 *  1. the advisory lock (D8g) when `actionId` is set;
 *  2. the account `FOR UPDATE`, then the identity `FOR UPDATE`;
 *  3. skips that write nothing: `not_found`, `already_blocked` (this blocker is
 *     there), `chain_changed` (`expect.directoryChain` differs), `rearmed` (a
 *     directory blocker on an identity an MSP restored), `action_not_pending`
 *     (the action is no longer `held` / `pending`), `observation_changed` (a
 *     newer run evaluated the identity since), and `expect.verifySource`'s
 *     failure (D8d: connection, proof or org — run last, under the locks);
 *  4. append the blocker; `disabled_at` / `disabled_reason` keep the first;
 *  5–6. count the other enabled identities under the lock and apply the rule
 *     ({@link previewAccountEffect});
 *  7. `auth_epoch + 1` on the first blocker (and on any later blocker whose
 *     account rule disables the account: a real transition ends sessions);
 *  8. `directory_deprovision` when the effect includes the account;
 *  9. the action `applied`;
 *  10. the `portal.directory.identity.disable` audit row.
 * After commit both session stores are purged and the action stamped
 * `sessions_purged_at`. A purge failure is logged (ids only) and left for
 * {@link retryPendingPurges}; the epoch already ended the sessions.
 */
export async function disablePortalIdentity(input: DisableIdentityInput): Promise<DisableIdentityResult> {
  assertNoHeldContext('disablePortalIdentity');
  const source = directorySourceOfBlocker(input.blocker);
  if (input.actionId !== undefined && source === null) {
    throw new Error('disablePortalIdentity: a run action needs a directory blocker');
  }
  if (!UUID_RE.test(input.orgId) || !UUID_RE.test(input.identityId) || (input.actionId !== undefined && !UUID_RE.test(input.actionId))) {
    return { kind: 'skipped', reason: 'not_found' };
  }
  const now = input.now ?? new Date();

  const committed = await withSystemDbAccessContext(
    () => disableInTransaction(input, source, now),
    'portalDirectory.disableIdentity',
  );

  if (committed.purge) {
    await purgeAfterCommit(committed.result.kind === 'skipped' ? null : committed.result.portalUserId, input.actionId ?? null, now);
  }
  return committed.result;
}

async function disableInTransaction(input: DisableIdentityInput, source: DirectorySource | null, now: Date): Promise<DisableCommitted> {
  const skipped = (reason: Extract<DisableIdentityResult, { kind: 'skipped' }>['reason']): DisableCommitted =>
    ({ result: { kind: 'skipped', reason }, purge: false });

  if (input.actionId !== undefined && source) await lockPortalDirectorySource(input.orgId, source);

  const owner = await readIdentityOwner(input.orgId, input.identityId);
  if (!owner) return skipped('not_found');
  const locked = await lockAccountThenIdentity(input.orgId, owner.portalUserId, input.identityId, owner.subject);
  if (!locked) return skipped('not_found');
  const { account, identity } = locked;

  if (identity.disabledBlockers.includes(input.blocker)) return skipped('already_blocked');
  if (input.expect && identity.directoryChain !== input.expect.directoryChain) return skipped('chain_changed');
  if (DIRECTORY_BLOCKERS.has(input.blocker) && identity.directoryRearmSince !== null) return skipped('rearmed');

  let runId: string | null = null;
  if (input.actionId !== undefined) {
    const [action] = await db
      .select({
        id: portalDirectoryActions.id,
        identityId: portalDirectoryActions.identityId,
        runId: portalDirectoryActions.runId,
        status: portalDirectoryActions.status,
      })
      .from(portalDirectoryActions)
      .where(and(eq(portalDirectoryActions.id, input.actionId), eq(portalDirectoryActions.orgId, input.orgId)))
      .for('update')
      .limit(1);
    // `held` (a held run, MSP-applied) or `pending` (an auto-apply run) await
    // application; any other status was decided meanwhile.
    if (!action || (action.status !== 'held' && action.status !== 'pending')) return skipped('action_not_pending');
    if (action.identityId !== identity.id) {
      throw new Error('disablePortalIdentity: the action belongs to another identity');
    }
    // D8d: the observation the action was planned from is still the latest one.
    if (identity.directoryLastRunId !== action.runId) return skipped('observation_changed');
    runId = action.runId;
  }

  // D8d: the directory itself (connection incarnation, proof or binding, org), under the locks above.
  if (input.expect?.verifySource) {
    const failure = await input.expect.verifySource();
    if (failure) return skipped(failure);
  }

  // 4. The blocker. The first blocker's time and reason stay (D1).
  const firstBlocker = identity.disabledAt === null;
  await db
    .update(portalUserIdentities)
    .set({
      disabledBlockers: [...identity.disabledBlockers, input.blocker],
      disabledAt: identity.disabledAt ?? now,
      disabledReason: identity.disabledReason ?? input.reason,
    })
    .where(and(eq(portalUserIdentities.id, identity.id), eq(portalUserIdentities.orgId, input.orgId)));

  // 5–6. The account rule, under the account lock: a concurrent disable of the
  // account's other identity has committed (it held this lock) and counts.
  const [counted] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(portalUserIdentities)
    .where(and(
      eq(portalUserIdentities.portalUserId, account.id),
      ne(portalUserIdentities.id, identity.id),
      isNull(portalUserIdentities.disabledAt),
    ));
  const usablePassword = account.status === 'disabled' ? false : await passwordUsable(input.orgId, account);
  const preview = previewAccountEffect({
    otherUsableIdentities: Number(counted?.n ?? 0),
    passwordUsable: usablePassword,
    status: account.status,
  });

  // 7–8. Epoch and account state.
  const facts: PortalAccountFacts = {
    status: account.status,
    browserAccess: account.browserAccess,
    authMethod: account.authMethod,
    hasPasswordHash: Boolean(account.passwordHash),
    hasExternalIdentity: true,
    disabledBy: account.disabledBy,
  };
  // W9 (D6): a SCIM blocker attributes the account disable to 'scim'.
  const accountWriter = input.blocker === 'scim' ? 'scim_deprovision' : 'directory_deprovision';
  const target = preview.effect === 'identity_and_account' ? planPortalAccountTransition(facts, accountWriter) : null;
  const bumpEpoch = firstBlocker || Boolean(target?.bumpEpoch);
  if (bumpEpoch || target) {
    await db
      .update(portalUsers)
      .set({
        ...(target ? { status: target.status, browserAccess: target.browserAccess, disabledBy: target.disabledBy } : {}),
        ...(bumpEpoch ? { authEpoch: sql`${portalUsers.authEpoch} + 1` } : {}),
        updatedAt: now,
      })
      .where(and(eq(portalUsers.id, account.id), eq(portalUsers.orgId, input.orgId)));
  }
  const accountDisabled = target !== null && account.status !== 'disabled';

  // 9. The action. Nothing to purge ⇒ stamped now, so the recovery sweep skips it.
  if (input.actionId !== undefined) {
    await db
      .update(portalDirectoryActions)
      .set({ status: 'applied', appliedAt: now, ...(bumpEpoch ? {} : { sessionsPurgedAt: now }) })
      .where(and(eq(portalDirectoryActions.id, input.actionId), eq(portalDirectoryActions.orgId, input.orgId)));
  }

  // 10. Audit, in the action's transaction (D12): a crash cannot apply without auditing.
  await insertAudit({
    orgId: input.orgId,
    actorType: 'system',
    actorId: ANONYMOUS_ACTOR_ID,
    action: AUDIT_IDENTITY_DISABLE,
    resourceType: 'portal_user',
    resourceId: account.id,
    details: {
      ...(input.auditDetails ?? {}),
      identityId: identity.id,
      provider: identity.provider,
      blocker: input.blocker,
      reason: input.reason,
      runId,
      accountDisabled,
      keepsPassword: preview.keepsPassword,
    },
    result: 'success',
  });

  const result: DisableIdentityResult = firstBlocker
    ? { kind: 'disabled', portalUserId: account.id, accountDisabled, keepsPassword: preview.keepsPassword }
    : { kind: 'blocker_added', portalUserId: account.id, accountDisabled };
  return { result, purge: bumpEpoch };
}

/** Both session stores; throws on the first failure so the caller leaves the stamp unset. */
async function purgeSessions(portalUserId: string): Promise<void> {
  await purgePortalSessionsForUsers([portalUserId]);
  const redis = getRedis();
  if (redis) await purgeClientAiSessionsForUsers(redis, [portalUserId]);
}

async function stampPurged(actionId: string, now: Date): Promise<void> {
  await withSystemDbAccessContext(
    () => db.update(portalDirectoryActions).set({ sessionsPurgedAt: now }).where(eq(portalDirectoryActions.id, actionId)),
    'portalDirectory.stampPurged',
  );
}

async function purgeAfterCommit(portalUserId: string | null, actionId: string | null, now: Date): Promise<void> {
  if (!portalUserId) return;
  try {
    await purgeSessions(portalUserId);
    if (actionId) await stampPurged(actionId, now);
  } catch (err) {
    // Ids only (no subject, email or name). The epoch already ended the sessions.
    console.error('[portal-directory] session purge after disable failed; the recovery sweep retries it', {
      portalUserId,
      actionId,
      error: err instanceof Error ? err.name : 'unknown',
    });
  }
}

/**
 * The recovery sweep's purge leg (D10): applied actions whose purge did not
 * finish, applied within the last 24 h. Returns how many it finished.
 */
export async function retryPendingPurges(now: Date): Promise<number> {
  assertNoHeldContext('retryPendingPurges');
  const since = new Date(now.getTime() - PURGE_RETRY_WINDOW_MS);
  const pending = await withSystemDbAccessContext(
    () => db
      .select({ id: portalDirectoryActions.id, portalUserId: portalDirectoryActions.portalUserId })
      .from(portalDirectoryActions)
      .where(and(
        eq(portalDirectoryActions.status, 'applied'),
        isNull(portalDirectoryActions.sessionsPurgedAt),
        gte(portalDirectoryActions.appliedAt, since),
      ))
      .orderBy(portalDirectoryActions.appliedAt)
      .limit(PURGE_RETRY_BATCH),
    'portalDirectory.pendingPurges',
  );
  // Applied actions that left the window unpurged are no longer retried (the
  // epoch bump already ended their sessions). A count only: no ids, no people.
  const [aged] = await withSystemDbAccessContext(
    () => db
      .select({ agedOut: count() })
      .from(portalDirectoryActions)
      .where(and(
        eq(portalDirectoryActions.status, 'applied'),
        isNull(portalDirectoryActions.sessionsPurgedAt),
        lt(portalDirectoryActions.appliedAt, since),
      )),
    'portalDirectory.agedOutPurges',
  );
  const agedOut = Number(aged?.agedOut ?? 0);
  if (agedOut > 0) {
    console.warn('[portal-directory] applied actions aged out of the purge retry window unpurged', { agedOut });
  }
  let finished = 0;
  for (const action of pending) {
    try {
      await purgeSessions(action.portalUserId);
      await stampPurged(action.id, now);
      finished += 1;
    } catch (err) {
      console.error('[portal-directory] session purge retry failed', {
        actionId: action.id,
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
  }
  return finished;
}

// ---------------------------------------------------------------------------
// Restore (D9) and remove (OD3)
// ---------------------------------------------------------------------------

export interface RestorePortalIdentityInput {
  orgId: string;
  portalUserId: string;
  identityId: string;
  reactivateAccount: boolean;
  confirmMspDisabled: boolean;
  actorUserId: string;
  now?: Date;
}

export interface RestorePortalIdentityResult {
  accountStatus: 'active' | 'invited' | 'disabled';
  blockersCleared: IdentityBlocker[];
}

/** Restore / remove: the identity's owner, the source lock, then the D3 lock order. Throws NOT_FOUND. */
async function lockForMspAction(orgId: string, portalUserId: string, identityId: string): Promise<LockedPair & { entraTenantId: string | null }> {
  const owner = await readIdentityOwner(orgId, identityId, portalUserId);
  if (!owner) throw notFound();
  await lockPortalDirectorySource(orgId, owner.provider);
  const locked = await lockAccountThenIdentity(orgId, portalUserId, identityId, owner.subject);
  if (!locked) throw notFound();
  return { ...locked, entraTenantId: owner.entraTenantId };
}

function assertMspIds(input: { orgId: string; portalUserId: string; identityId: string; actorUserId: string }): void {
  if (![input.orgId, input.portalUserId, input.identityId].every((id) => UUID_RE.test(id))) throw notFound();
  if (!UUID_RE.test(input.actorUserId)) throw new Error('portal directory MSP action: invalid actor id');
}

/**
 * D9, one transaction under the D3 lock order:
 *  1. clear every blocker and `disabled_*`;
 *  2. `directory_rearm_since = now`, absence cleared — the directory cannot
 *     re-disable the person until a NEWER snapshot shows them enabled;
 *  3. the identity's latest applied action → `restored`;
 *  4. with `reactivateAccount` and a disabled account, `msp_reactivate` (the
 *     restored identity is a usable credential, so the account goes active);
 *  5. an account disabled by the MSP is reactivated only with
 *     `confirmMspDisabled` too (409 `PORTAL_ACCOUNT_MSP_DISABLED_CONFIRM`);
 *     without `reactivateAccount` the identity is restored and the account
 *     left as it is;
 *  6. audit `organization.portal_user.identity.restore`, plus the existing
 *     `organization.portal_user.update` on reactivation.
 * No purge: nothing here ends a session.
 */
export async function restorePortalIdentity(input: RestorePortalIdentityInput): Promise<RestorePortalIdentityResult> {
  assertNoHeldContext('restorePortalIdentity');
  assertMspIds(input);
  const now = input.now ?? new Date();

  const result = await withSystemDbAccessContext(async () => {
    const { account, identity } = await lockForMspAction(input.orgId, input.portalUserId, input.identityId);
    if (identity.disabledAt === null) {
      throw new PortalDirectoryIdentityError('PORTAL_IDENTITY_NOT_DISABLED', 409, 'This sign-in method is not disabled.');
    }
    const reactivating = input.reactivateAccount && account.status === 'disabled';
    if (reactivating && account.disabledBy === 'msp' && !input.confirmMspDisabled) {
      throw new PortalDirectoryIdentityError(
        'PORTAL_ACCOUNT_MSP_DISABLED_CONFIRM',
        409,
        'Your team disabled this portal account. Confirm that you want to reactivate it.',
      );
    }
    const blockersCleared = [...identity.disabledBlockers];

    await db
      .update(portalUserIdentities)
      .set({
        disabledAt: null,
        disabledReason: null,
        disabledBlockers: [],
        directoryRearmSince: now,
        directoryAbsentRuns: 0,
        directoryAbsentSince: null,
      })
      .where(and(eq(portalUserIdentities.id, identity.id), eq(portalUserIdentities.orgId, input.orgId)));

    const [latestApplied] = await db
      .select({ id: portalDirectoryActions.id })
      .from(portalDirectoryActions)
      .where(and(
        eq(portalDirectoryActions.identityId, identity.id),
        eq(portalDirectoryActions.orgId, input.orgId),
        eq(portalDirectoryActions.status, 'applied'),
      ))
      .orderBy(desc(portalDirectoryActions.appliedAt))
      .limit(1);
    if (latestApplied) {
      await db
        .update(portalDirectoryActions)
        .set({ status: 'restored', restoredAt: now, restoredByUserId: input.actorUserId })
        .where(eq(portalDirectoryActions.id, latestApplied.id));
    }

    let accountStatus = account.status as RestorePortalIdentityResult['accountStatus'];
    if (reactivating) {
      const target = planPortalAccountTransition({
        status: account.status,
        browserAccess: account.browserAccess,
        authMethod: account.authMethod,
        hasPasswordHash: Boolean(account.passwordHash),
        hasExternalIdentity: true,
        // The identity restored above is enabled in this transaction.
        hasUsableExternalIdentity: true,
        passwordUsable: await passwordUsable(input.orgId, account),
        disabledBy: account.disabledBy,
      }, 'msp_reactivate');
      await db
        .update(portalUsers)
        .set({
          status: target.status,
          browserAccess: target.browserAccess,
          disabledBy: target.disabledBy,
          ...(target.bumpEpoch ? { authEpoch: sql`${portalUsers.authEpoch} + 1` } : {}),
          updatedAt: now,
        })
        .where(and(eq(portalUsers.id, account.id), eq(portalUsers.orgId, input.orgId)));
      accountStatus = target.status;
      await insertAudit({
        orgId: input.orgId,
        actorType: 'user',
        actorId: input.actorUserId,
        action: AUDIT_PORTAL_USER_UPDATE,
        resourceType: 'portal_user',
        resourceId: account.id,
        details: { changedFields: ['status'], status: target.status, via: 'identity_restore' },
        result: 'success',
      });
    }

    await insertAudit({
      orgId: input.orgId,
      actorType: 'user',
      actorId: input.actorUserId,
      action: AUDIT_IDENTITY_RESTORE,
      resourceType: 'portal_user',
      resourceId: account.id,
      details: { identityId: identity.id, blockersCleared, reactivated: reactivating },
      result: 'success',
    });
    return { accountStatus, blockersCleared };
  }, 'portalDirectory.restoreIdentity');

  markRequestAuditWritten();
  return result;
}

export interface RemoveDisabledPortalIdentityInput {
  orgId: string;
  portalUserId: string;
  identityId: string;
  actorUserId: string;
}

/**
 * OD3: delete ONE identity row disabled by a directory blocker
 * (`entra_directory` / `google_directory`), under the D3 lock order. Anything
 * else — enabled, or disabled only by `scim` / `msp` — is 409
 * `PORTAL_IDENTITY_NOT_DIRECTORY_DISABLED`. The MSP sees the identity's
 * directory state in the panel before choosing this. Its directory actions
 * cascade with it (the audit log keeps every applied disable, D12). For Entra,
 * the W3 D4 fence clears the account's legacy `entra_*` columns when they
 * name the removed identity. When it was the account's last identity and the
 * account is identity-method, the account becomes a credential-less
 * password-method row so the MSP can re-invite it (see below). Audits
 * `organization.portal_user.identity.remove` with `authMethodReset`.
 */
export async function removeDisabledPortalIdentity(
  input: RemoveDisabledPortalIdentityInput,
): Promise<{ identityId: string; provider: DirectorySource; blockers: IdentityBlocker[] }> {
  assertNoHeldContext('removeDisabledPortalIdentity');
  assertMspIds(input);
  const now = new Date();

  const result = await withSystemDbAccessContext(async () => {
    const { account, identity, subject, entraTenantId } = await lockForMspAction(input.orgId, input.portalUserId, input.identityId);
    if (identity.disabledAt === null || !identity.disabledBlockers.some((b) => DIRECTORY_BLOCKERS.has(b))) {
      throw new PortalDirectoryIdentityError(
        'PORTAL_IDENTITY_NOT_DIRECTORY_DISABLED',
        409,
        'Only a sign-in method disabled by the customer\'s directory can be removed.',
      );
    }
    const blockers = [...identity.disabledBlockers];

    if (identity.provider === 'entra' && entraTenantId) {
      await db
        .update(portalUsers)
        .set({ entraTenantId: null, entraOid: null, updatedAt: now })
        .where(and(
          eq(portalUsers.id, account.id),
          eq(portalUsers.orgId, input.orgId),
          eq(portalUsers.entraTenantId, entraTenantId),
          eq(portalUsers.entraOid, subject),
        ));
    }
    await db
      .delete(portalUserIdentities)
      .where(and(eq(portalUserIdentities.id, identity.id), eq(portalUserIdentities.orgId, input.orgId)));

    // The account's LAST sign-in method gone: an identity-method account
    // (auth_method 'entra' / 'google') would otherwise be a dead end — every
    // invite writer refuses a non-password row (identity_managed), sign-in has
    // no method left, and the person's new directory account cannot link. It
    // becomes a credential-less password-method row, the shape the invite
    // writers target: the MSP reactivates it (→ invited) and invites, and the
    // invite-bound sign-in links the new identity (OD3). Any hash on the
    // non-password row was never a credential and is cleared so the flip cannot
    // make it one. The epoch is bumped because the credential model changed.
    // Locked: the account row is held FOR UPDATE above (D3).
    const [remaining] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(portalUserIdentities)
      .where(and(eq(portalUserIdentities.portalUserId, account.id), eq(portalUserIdentities.orgId, input.orgId)));
    // Never on an `active` row: a credential-less active password row is the
    // legacy shape self-service reset accepts, so an (unreachable today)
    // active identity-method account is left as it is rather than handed one.
    const authMethodReset = (remaining?.n ?? 0) === 0 && !isPasswordEligible(account) && account.status !== 'active';
    if (authMethodReset) {
      await db
        .update(portalUsers)
        .set({ authMethod: 'password', passwordHash: null, authEpoch: sql`${portalUsers.authEpoch} + 1`, updatedAt: now })
        .where(and(eq(portalUsers.id, account.id), eq(portalUsers.orgId, input.orgId)));
    }

    await insertAudit({
      orgId: input.orgId,
      actorType: 'user',
      actorId: input.actorUserId,
      action: AUDIT_IDENTITY_REMOVE,
      resourceType: 'portal_user',
      resourceId: account.id,
      details: { identityId: identity.id, provider: identity.provider, blockers, authMethodReset },
      result: 'success',
    });
    return { identityId: identity.id, provider: identity.provider, blockers };
  }, 'portalDirectory.removeIdentity');

  markRequestAuditWritten();
  return result;
}

// ---------------------------------------------------------------------------
// W9: lifting the SCIM blocker (plan D6)
// ---------------------------------------------------------------------------

export interface LiftScimIdentityBlockerInput {
  orgId: string;
  identityId: string;
  /** The SCIM token the request authenticated with (audit only). */
  scimTokenId: string;
  now?: Date;
}

export type LiftScimIdentityBlockerResult =
  | { kind: 'not_found' }
  | { kind: 'not_blocked'; portalUserId: string }
  | { kind: 'lifted'; portalUserId: string; identityEnabled: boolean; accountReactivated: boolean };

/**
 * A SCIM `active: true` (W9 D6), in one system transaction under the W8 lock
 * order — the `(org, 'entra')` advisory lock, the account `FOR UPDATE`, the
 * identity `FOR UPDATE` — so it serializes with directory capture / apply and
 * with MSP Restore:
 *  1. remove ONLY the `scim` blocker (no-op `not_blocked` without it). A
 *     directory or MSP blocker is never touched; `disabled_at` /
 *     `disabled_reason` (the first blocker's) clear only when none remains;
 *  2. when the identity is now enabled AND the account is `disabled` with
 *     `disabled_by = 'scim'`, `scim_reactivate` (active, epoch bumped). An
 *     account disabled by the MSP or a directory is left as it is (spec
 *     precedence: an MSP disable beats a SCIM activate);
 *  3. audit `portal.scim.user.reactivate`.
 * No purge: nothing here ends a session.
 */
export async function liftScimIdentityBlocker(input: LiftScimIdentityBlockerInput): Promise<LiftScimIdentityBlockerResult> {
  assertNoHeldContext('liftScimIdentityBlocker');
  if (!UUID_RE.test(input.orgId) || !UUID_RE.test(input.identityId)) return { kind: 'not_found' };
  const now = input.now ?? new Date();

  return withSystemDbAccessContext(async (): Promise<LiftScimIdentityBlockerResult> => {
    await lockPortalDirectorySource(input.orgId, 'entra');
    const owner = await readIdentityOwner(input.orgId, input.identityId);
    // SCIM manages Entra identities only.
    if (!owner || owner.provider !== 'entra') return { kind: 'not_found' };
    const locked = await lockAccountThenIdentity(input.orgId, owner.portalUserId, input.identityId, owner.subject);
    if (!locked) return { kind: 'not_found' };
    const { account, identity } = locked;
    if (!identity.disabledBlockers.includes('scim')) return { kind: 'not_blocked', portalUserId: account.id };

    const remainingBlockers = identity.disabledBlockers.filter((b) => b !== 'scim');
    const identityEnabled = remainingBlockers.length === 0;
    await db
      .update(portalUserIdentities)
      .set(identityEnabled
        ? { disabledBlockers: [], disabledAt: null, disabledReason: null }
        : { disabledBlockers: remainingBlockers })
      .where(and(eq(portalUserIdentities.id, identity.id), eq(portalUserIdentities.orgId, input.orgId)));

    let accountReactivated = false;
    if (identityEnabled && account.status === 'disabled' && account.disabledBy === 'scim') {
      const target = planPortalAccountTransition({
        status: account.status,
        browserAccess: account.browserAccess,
        authMethod: account.authMethod,
        hasPasswordHash: Boolean(account.passwordHash),
        hasExternalIdentity: true,
        // The identity enabled above, in this transaction.
        hasUsableExternalIdentity: true,
        passwordUsable: false,
        disabledBy: account.disabledBy,
      }, 'scim_reactivate');
      await db
        .update(portalUsers)
        .set({
          status: target.status,
          browserAccess: target.browserAccess,
          disabledBy: target.disabledBy,
          ...(target.bumpEpoch ? { authEpoch: sql`${portalUsers.authEpoch} + 1` } : {}),
          updatedAt: now,
        })
        .where(and(eq(portalUsers.id, account.id), eq(portalUsers.orgId, input.orgId)));
      accountReactivated = true;
    }

    await insertAudit({
      orgId: input.orgId,
      actorType: 'system',
      actorId: ANONYMOUS_ACTOR_ID,
      action: AUDIT_SCIM_USER_REACTIVATE,
      resourceType: 'portal_user',
      resourceId: account.id,
      details: { identityId: identity.id, scimTokenId: input.scimTokenId, identityEnabled, accountReactivated, remainingBlockers },
      result: 'success',
    });
    return { kind: 'lifted', portalUserId: account.id, identityEnabled, accountReactivated };
  }, 'portalScim.liftBlocker');
}
