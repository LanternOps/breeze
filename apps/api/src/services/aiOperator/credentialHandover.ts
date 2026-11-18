/**
 * The created-account credential projection (Recipe Library W07 R2a Task 11;
 * D-R2-6, Amendment G8 and B1).
 *
 * R2 ADDS NO REVEAL SURFACE. The temporary credential of an account the
 * onboarding recipe created lives in exactly one place — the sealed
 * `action_intents.result` of the `m365_create_user` child intent — and is
 * revealed once through the shipped `POST /action-intents/:id/reveal-secret`.
 * This module only PROJECTS what the task page and the completion record need
 * to say about it.
 *
 * NEVER UNSEALS, NEVER SELECTS THE VALUE. The query projects booleans derived
 * in SQL from jsonb KEY PRESENCE — the same rule as `routes/ai.ts`'s
 * tempPasswordState — so the ciphertext never reaches application memory. The
 * key names come from `resultSecrets.ts`'s constants; this file never spells
 * them. The only other read of `result` is the non-secret `userId` key, in a
 * join predicate that binds the create intent to THIS account.
 *
 * THE RULES MIRROR THE SHIPPED REVEAL ROUTE (routes/actionIntents.ts):
 *   - `available` needs a sealed key on a `completed` intent whose
 *     `executedAt` is no more than REVEAL_WINDOW_DAYS ago (the route 404s a
 *     non-completed intent, and 410s — and burns — one past the window or
 *     with no `executedAt`, so those project `not_applicable` / `expired`).
 *   - A sealed key wins over a marker, as in `routes/ai.ts`.
 *   - The route admits only the intent's REQUESTER (who must still hold the
 *     tool's permission, a live check no projection can make). E4 mints every
 *     plan child AS the plan approver (D-E4-2), so the requester IS the create
 *     approval's approver. The projection names that person only when the
 *     intent's requester and the approval row's approver agree: naming anyone
 *     else would send a technician to a 403. A requester-less intent (the
 *     route's approvals:decide fallback) names no one.
 *   - A seal-failed marker means the credential was dropped at seal time and
 *     never stored: `unretrievable`, not `expired` — the remedy is the same
 *     password reset, but the reason differs and the UI must not lie.
 *   - Google is `not_applicable` this wave (D-R2-3): the technician set that
 *     password by hand, so there is no sealed credential.
 *
 * LINKAGE (B1): account (provider `m365`) → the child intent at the
 * `create_accounts` step whose action is `m365_create_user` and whose result
 * `userId` equals the account's immutable `external_id` → its operation row
 * (`intent_id`) → the plan approval at that operation's `(plan_revision,
 * step)` → its approver's `users` row. The approval at `createPlanRevision` is
 * `superseded` after `resolve_accounts`' bump, which keeps `approved_by_user_id`
 * (B7), so the join holds for the life of the task.
 *
 * DB CONTEXT. Runs on the CALLER's ambient context, with explicit `org_id`
 * (and `task_id`) predicates on every table: the route (`GET /tasks/:id`,
 * Task 14) calls it inside its request context (RLS applies), and the
 * completion record (Task 13) calls it inside its own
 * `runOutsideDbContext(() => withSystemDbAccessContext(...))` loader. With no
 * context at all it THROWS rather than read through a bare pool (which under
 * forced RLS would silently return nothing).
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db, hasDbAccessContext } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import { aiOperatorTaskTargetAccounts } from '../../db/schema/aiOperatorTaskGraph';
import { aiOperatorOperations, aiOperatorTasks } from '../../db/schema/aiOperatorTasks';
import { aiOperatorPlanApprovals } from '../../db/schema/aiOperatorPlanApprovals';
import { users } from '../../db/schema/users';
import {
  REVEAL_WINDOW_DAYS,
  TEMP_PASSWORD_ENC_KEY,
  TEMP_PASSWORD_EXPIRED_KEY,
  TEMP_PASSWORD_LEGACY_KEY,
  TEMP_PASSWORD_REVEALED_KEY,
  TEMP_PASSWORD_SEAL_FAILED_KEY,
} from '../actionIntents/resultSecrets';

export const CREDENTIAL_STATES = ['available', 'revealed', 'expired', 'unretrievable', 'not_applicable'] as const;
export type CredentialState = (typeof CREDENTIAL_STATES)[number];

export interface CreatedAccountView {
  provider: 'm365' | 'google';
  /** The frozen UPN / primary email. DISPLAY ONLY. */
  principalLabel: string;
  /** The immutable Entra object id / Google user id. */
  externalId: string;
  credentialState: CredentialState;
  /** The intent whose sealed result holds it. Null when not_applicable. */
  intentId: string | null;
  /** WHO may reveal it — the create approval's approver, who is the intent's
   *  requester (D-R2-6). Null unless `available`. */
  revealableByUserId: string | null;
  revealableByName: string | null;
  /** When the reveal window closes. Null unless `available`. */
  revealExpiresAt: string | null;
}

/** Recipe data this projection keys on (R2a B1). */
const ONBOARDING_WORKFLOW_KEY = 'identity_onboarding';
const CREATE_STEP_KEY = 'create_accounts';
const CREATE_TOOL = 'm365_create_user';
/** The non-secret key of `m365.user.create`'s structured result. */
const CREATED_USER_ID_KEY = 'userId';

const REVEAL_WINDOW_MS = REVEAL_WINDOW_DAYS * 24 * 60 * 60 * 1000;
/** Accounts are unique per (task, provider); the cap only bounds join fan-out. */
const READ_LIMIT = 20;

/** The row the query returns. No field for `result`, by construction. */
interface CreatedAccountRow {
  provider: string;
  principalLabel: string;
  externalId: string;
  intentId: string | null;
  intentStatus: string | null;
  executedAt: Date | null;
  requestedByUserId: string | null;
  approverUserId: string | null;
  approverName: string | null;
  hasSealedCredential: boolean;
  hasRevealedMarker: boolean;
  hasExpiredMarker: boolean;
  hasSealFailedMarker: boolean;
}

function deriveState(row: CreatedAccountRow, now: Date): CredentialState {
  if (!row.intentId) return 'not_applicable';
  if (row.hasSealedCredential) {
    if (row.intentStatus !== 'completed') return 'not_applicable';
    if (!row.executedAt || now.getTime() - row.executedAt.getTime() > REVEAL_WINDOW_MS) return 'expired';
    return 'available';
  }
  if (row.hasRevealedMarker) return 'revealed';
  if (row.hasExpiredMarker) return 'expired';
  if (row.hasSealFailedMarker) return 'unretrievable';
  return 'not_applicable';
}

function toView(row: CreatedAccountRow, now: Date): CreatedAccountView {
  const credentialState = deriveState(row, now);
  const available = credentialState === 'available';
  const revealer = available && row.requestedByUserId !== null && row.requestedByUserId === row.approverUserId
    ? row.requestedByUserId
    : null;
  return {
    provider: row.provider === 'google' ? 'google' : 'm365',
    principalLabel: row.principalLabel,
    externalId: row.externalId,
    credentialState,
    intentId: credentialState === 'not_applicable' ? null : row.intentId,
    revealableByUserId: revealer,
    revealableByName: revealer ? row.approverName ?? null : null,
    revealExpiresAt: available && row.executedAt
      ? new Date(row.executedAt.getTime() + REVEAL_WINDOW_MS).toISOString()
      : null,
  };
}

/**
 * Every account this onboarding task created or resolved, with its credential
 * state. `[]` for any non-onboarding task. Ordered by provider ascending, one
 * view per provider, so the task page does not reshuffle between polls.
 */
export async function listCreatedAccountsForTask(
  orgId: string,
  taskId: string,
  opts: { now?: Date } = {},
): Promise<CreatedAccountView[]> {
  if (!hasDbAccessContext()) {
    throw new Error('[aiOperator] listCreatedAccountsForTask needs a db access context (request or system)');
  }
  const now = opts.now ?? new Date();
  const result = actionIntents.result;

  const rows = await db
    .select({
      provider: aiOperatorTaskTargetAccounts.provider,
      principalLabel: aiOperatorTaskTargetAccounts.principalLabel,
      externalId: aiOperatorTaskTargetAccounts.externalId,
      intentId: actionIntents.id,
      intentStatus: actionIntents.status,
      executedAt: actionIntents.executedAt,
      requestedByUserId: actionIntents.requestedByUserId,
      approverUserId: aiOperatorPlanApprovals.approvedByUserId,
      approverName: users.name,
      // KEY PRESENCE ONLY — booleans, never the value (routes/ai.ts's rule).
      hasSealedCredential: sql<boolean>`coalesce(${result} ?| array[${TEMP_PASSWORD_ENC_KEY}::text, ${TEMP_PASSWORD_LEGACY_KEY}::text], false)`,
      hasRevealedMarker: sql<boolean>`coalesce(${result} ? ${TEMP_PASSWORD_REVEALED_KEY}::text, false)`,
      hasExpiredMarker: sql<boolean>`coalesce(${result} ? ${TEMP_PASSWORD_EXPIRED_KEY}::text, false)`,
      hasSealFailedMarker: sql<boolean>`coalesce(${result} ? ${TEMP_PASSWORD_SEAL_FAILED_KEY}::text, false)`,
    })
    .from(aiOperatorTaskTargetAccounts)
    .innerJoin(aiOperatorTasks, and(
      eq(aiOperatorTasks.id, aiOperatorTaskTargetAccounts.taskId),
      eq(aiOperatorTasks.orgId, aiOperatorTaskTargetAccounts.orgId),
    ))
    .leftJoin(actionIntents, and(
      eq(actionIntents.orgId, aiOperatorTaskTargetAccounts.orgId),
      eq(actionIntents.taskId, aiOperatorTaskTargetAccounts.taskId),
      eq(aiOperatorTaskTargetAccounts.provider, 'm365'),
      eq(actionIntents.taskStepKey, CREATE_STEP_KEY),
      eq(actionIntents.actionName, CREATE_TOOL),
      sql`${result} ->> ${CREATED_USER_ID_KEY}::text = ${aiOperatorTaskTargetAccounts.externalId}`,
    ))
    .leftJoin(aiOperatorOperations, and(
      eq(aiOperatorOperations.orgId, actionIntents.orgId),
      eq(aiOperatorOperations.taskId, actionIntents.taskId),
      eq(aiOperatorOperations.intentId, actionIntents.id),
    ))
    .leftJoin(aiOperatorPlanApprovals, and(
      eq(aiOperatorPlanApprovals.orgId, aiOperatorOperations.orgId),
      eq(aiOperatorPlanApprovals.taskId, aiOperatorOperations.taskId),
      eq(aiOperatorPlanApprovals.planRevision, aiOperatorOperations.planRevision),
      eq(aiOperatorPlanApprovals.stepKey, aiOperatorOperations.taskStepKey),
    ))
    .leftJoin(users, eq(users.id, aiOperatorPlanApprovals.approvedByUserId))
    .where(and(
      eq(aiOperatorTaskTargetAccounts.orgId, orgId),
      eq(aiOperatorTaskTargetAccounts.taskId, taskId),
      eq(aiOperatorTasks.workflowKey, ONBOARDING_WORKFLOW_KEY),
    ))
    .orderBy(asc(aiOperatorTaskTargetAccounts.provider), sql`${actionIntents.executedAt} DESC NULLS LAST`, desc(actionIntents.createdAt))
    .limit(READ_LIMIT) as CreatedAccountRow[];

  // One view per provider (the first, i.e. the newest-executed create intent),
  // re-sorted here so the order never depends on the driver.
  const byProvider = new Map<string, CreatedAccountView>();
  for (const row of rows) {
    if (!byProvider.has(row.provider)) byProvider.set(row.provider, toView(row, now));
  }
  return [...byProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}
