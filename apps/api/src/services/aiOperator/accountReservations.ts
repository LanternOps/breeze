/**
 * Per-provider-account reservations (#9981).
 *
 * A task that will act on a Microsoft 365 / Google Workspace account reserves
 * it, keyed on the provider identity (`provider`, immutable `external_id`)
 * inside the org — NOT on the contact. Two contact rows that resolve to one
 * account therefore contend for the same reservation, and the second
 * admission is refused instead of starting a second, concurrent offboarding
 * of the same account.
 *
 * LIFECYCLE (read the migration header, 2027-01-15-130000, for the SQL):
 *  - written by `reserveTaskAccount`, which `freezeTargetAccount` calls, so an
 *    account is never frozen onto a task without being reserved;
 *  - held while the task is live, and while it is terminal with outcome
 *    `unknown_effect` (an action it sent may still land);
 *  - released by the `ai_operator_tasks_release_account_reservations` trigger
 *    on any other terminal, by `releaseSettledAccountReservations` (the
 *    reconciler) once nothing of a terminal task can still land, or by a
 *    person through `releaseTaskAccountReservations`.
 *  - NO time-based expiry. An operation whose result is `unknown` stays
 *    unknown; only a person who checked the provider can say it is safe.
 *
 * CONCURRENCY. `lockAndCheckAccountReservations` takes one transaction-scoped
 * advisory lock per account, in SORTED order, then reads the active
 * reservations. Every caller that reserves takes the same locks in the same
 * order before it writes, so two writers of overlapping account sets cannot
 * deadlock and cannot both pass the check. The partial unique index
 * `ai_operator_account_reservations_active_uq` is the backstop: a writer that
 * skipped the check aborts its transaction (`reserveTaskAccount` throws), it
 * never holds an account another task holds.
 *
 * Lock order across the module: org admission lock → per-(recipe, contact)
 * lock → these account locks. The account locks are taken last and nothing
 * that holds one waits on an earlier lock.
 */
import { and, eq, ne, sql, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiOperatorAccountReservations } from '../../db/schema/aiOperatorAccountReservations';
import { aiOperatorTasks } from '../../db/schema/aiOperatorTasks';
import type { AiOperatorAccountProvider } from '../../db/schema/aiOperatorTaskGraph';
import { isTerminalTaskState } from './taskTransitions';

export interface AccountKey {
  provider: AiOperatorAccountProvider;
  /** Immutable Entra object id / Google user id. Never the UPN. */
  externalId: string;
}

/** Matches the column's CHECK and `targetService`'s bound. */
const MAX_EXTERNAL_ID_CHARS = 255;
const MAX_PRINCIPAL_LABEL_CHARS = 320;

type ExecHandle = Pick<typeof db, 'execute'>;
type RowHandle = Pick<typeof db, 'insert' | 'update' | 'select'>;

/** Deduplicated and in the one global order every locker uses. */
export function sortAccountKeys(keys: readonly AccountKey[]): AccountKey[] {
  const seen = new Map<string, AccountKey>();
  for (const k of keys) {
    const externalId = k.externalId.slice(0, MAX_EXTERNAL_ID_CHARS);
    seen.set(`${k.provider}\u0000${externalId}`, { provider: k.provider, externalId });
  }
  // Code-unit order, never locale order: two pods must agree byte for byte.
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, k]) => k);
}

function lockKey(orgId: string, k: AccountKey): string {
  return `ai_operator_account:${orgId}:${k.provider}:${k.externalId}`;
}

/** One active reservation that blocks the caller. */
export interface AccountReservationConflict {
  taskId: string;
  /** The org that holds it; differs from the caller's when it was merged away. */
  orgId: string;
  provider: AiOperatorAccountProvider;
  externalId: string;
  principalLabel: string;
  taskState: string;
  taskOutcome: string | null;
  /** True when the holder is in an organization merged into the caller's. */
  fromMergedOrg: boolean;
}

/**
 * Take the per-account locks (sorted) and return the first active reservation
 * of any of these accounts held by another task, or null.
 *
 * Reads the caller's org AND every org merged into it (transitively, via
 * `org_merge_events`): a merge leaves the loser's tasks and their
 * reservations in the loser org, and a stopped task there may still have an
 * effect in flight on an account the survivor now owns. Runs on the caller's
 * handle — admission and the coordinator are in system scope, which is what
 * lets the merged org be read.
 */
export async function lockAndCheckAccountReservations(
  dbh: ExecHandle,
  orgId: string,
  keys: readonly AccountKey[],
  opts: { excludeTaskId?: string } = {},
): Promise<AccountReservationConflict | null> {
  const sorted = sortAccountKeys(keys);
  if (sorted.length === 0) return null;
  for (const k of sorted) {
    await dbh.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(orgId, k)}, 0))`);
  }
  const match = sql.join(
    sorted.map((k) => sql`(r.provider = ${k.provider} AND r.external_id = ${k.externalId})`),
    sql` OR `,
  );
  const exclude: SQL = opts.excludeTaskId ? sql`AND r.task_id <> ${opts.excludeTaskId}::uuid` : sql``;
  const raw = await dbh.execute(sql`
    WITH RECURSIVE scope(org_id) AS (
      SELECT ${orgId}::uuid
      UNION
      SELECT e.loser_org_id FROM org_merge_events e JOIN scope s ON e.survivor_org_id = s.org_id
    )
    SELECT r.task_id, r.org_id, r.provider, r.external_id, r.principal_label, t.state, t.outcome
      FROM ai_operator_account_reservations r
      JOIN ai_operator_tasks t ON t.id = r.task_id AND t.org_id = r.org_id
     WHERE r.released_at IS NULL
       AND r.org_id IN (SELECT org_id FROM scope)
       AND (${match})
       ${exclude}
     ORDER BY (r.org_id = ${orgId}::uuid) DESC, r.reserved_at, r.task_id
     LIMIT 1
  `);
  const rows = ((raw as { rows?: unknown[] }).rows ?? (raw as unknown[])) as Array<{
    task_id: string; org_id: string; provider: AiOperatorAccountProvider; external_id: string;
    principal_label: string; state: string; outcome: string | null;
  }>;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row) return null;
  return {
    taskId: row.task_id,
    orgId: row.org_id,
    provider: row.provider,
    externalId: row.external_id,
    principalLabel: row.principal_label,
    taskState: row.state,
    taskOutcome: row.outcome,
    fromMergedOrg: row.org_id !== orgId,
  };
}

const PROVIDER_NAMES: Record<AiOperatorAccountProvider, string> = { m365: 'Microsoft 365', google: 'Google Workspace' };

/** The refusal text: which account, which task holds it, and why it is still held. */
export function describeReservationConflict(c: AccountReservationConflict): string {
  const account = `the ${PROVIDER_NAMES[c.provider]} account ${c.principalLabel}`;
  const where = c.fromMergedOrg ? ` in an organization that was merged into this one (${c.orgId})` : '';
  const why = isTerminalTaskState(c.taskState)
    ? `it ended ${c.taskState} while an action it sent had not reported a result, so that action may still land. `
      + 'Confirm the result in the provider, then release the account from that task'
    : `that task is ${c.taskState}`;
  return `${account} is reserved by task ${c.taskId}${where}: ${why}.`;
}

/** Thrown when a writer reserved without `lockAndCheckAccountReservations` and lost. Aborts the transaction. */
export class AccountReservedError extends Error {
  constructor(readonly taskId: string, readonly holderTaskId: string, readonly key: AccountKey) {
    super(`[aiOperator] account ${key.provider}:${key.externalId} is reserved by task ${holderTaskId}; task ${taskId} cannot reserve it`);
    this.name = 'AccountReservedError';
  }
}

/**
 * Reserve one account for one task, on the caller's handle. Idempotent for the
 * same (task, account). A different account for the same (task, provider)
 * supersedes the old reservation — the re-freeze `freezeTargetAccount` allows.
 *
 * The caller must have run `lockAndCheckAccountReservations` for this account
 * in this transaction. If it did not and another task holds the account, the
 * insert finds the active row and this THROWS, so the caller's transaction
 * rolls back rather than leaving a frozen, unreserved account.
 */
export async function reserveTaskAccount(
  dbh: RowHandle,
  input: { orgId: string; taskId: string; provider: AiOperatorAccountProvider; externalId: string; principalLabel: string },
): Promise<void> {
  const externalId = input.externalId.slice(0, MAX_EXTERNAL_ID_CHARS);
  const now = new Date();
  await dbh
    .update(aiOperatorAccountReservations)
    .set({ releasedAt: now, releaseReason: 'superseded', updatedAt: now })
    .where(and(
      eq(aiOperatorAccountReservations.orgId, input.orgId),
      eq(aiOperatorAccountReservations.taskId, input.taskId),
      eq(aiOperatorAccountReservations.provider, input.provider),
      ne(aiOperatorAccountReservations.externalId, externalId),
      sql`${aiOperatorAccountReservations.releasedAt} IS NULL`,
    ));
  const inserted = await dbh
    .insert(aiOperatorAccountReservations)
    .values({
      orgId: input.orgId,
      taskId: input.taskId,
      provider: input.provider,
      externalId,
      principalLabel: input.principalLabel.slice(0, MAX_PRINCIPAL_LABEL_CHARS) || externalId,
    })
    .onConflictDoNothing({
      target: [aiOperatorAccountReservations.orgId, aiOperatorAccountReservations.provider, aiOperatorAccountReservations.externalId],
      where: sql`released_at IS NULL`,
    })
    .returning({ id: aiOperatorAccountReservations.id });
  if (inserted.length === 1) return;
  const [holder] = await dbh
    .select({ taskId: aiOperatorAccountReservations.taskId })
    .from(aiOperatorAccountReservations)
    .where(and(
      eq(aiOperatorAccountReservations.orgId, input.orgId),
      eq(aiOperatorAccountReservations.provider, input.provider),
      eq(aiOperatorAccountReservations.externalId, externalId),
      sql`${aiOperatorAccountReservations.releasedAt} IS NULL`,
    ))
    .limit(1);
  if (holder?.taskId === input.taskId) return;
  throw new AccountReservedError(input.taskId, holder?.taskId ?? '(unknown)', { provider: input.provider, externalId });
}

/** Rows released per reconciler pass. */
export const RESERVATION_RELEASE_SCAN_LIMIT = 50;

/**
 * Reconciler: release the reservations of TERMINAL tasks that have nothing
 * left that can land — no operation `pending`/`unknown` that was dispatched
 * or carries an execution reference (the predicate `settleStoppingTask` uses
 * to decide `unknown_effect`). An operation that never dispatched cannot run
 * any more: the dispatch claim refuses a task that is not live.
 *
 * This is how an `unknown_effect` handoff gets its account back once the late
 * result lands (the reconciler's set 4 writes it onto the operation). It also
 * catches any terminal task the trigger did not release, whatever its outcome.
 * An operation left `unknown` past the chase horizon keeps its reservation:
 * only `releaseTaskAccountReservations` (a person) frees it.
 */
export async function releaseSettledAccountReservations(): Promise<number> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const raw = await db.execute(sql`
      UPDATE ai_operator_account_reservations r
         SET released_at = now(), release_reason = 'effects_settled', updated_at = now()
       WHERE r.id IN (
         SELECT r2.id
           FROM ai_operator_account_reservations r2
           JOIN ai_operator_tasks t ON t.id = r2.task_id AND t.org_id = r2.org_id
          WHERE r2.released_at IS NULL
            AND t.state IN ('completed', 'partial', 'handed_off', 'cancelled', 'failed', 'expired')
            AND NOT EXISTS (
              SELECT 1 FROM ai_operator_operations o
               WHERE o.org_id = t.org_id AND o.task_id = t.id
                 AND o.result_state IN ('pending', 'unknown')
                 AND (o.dispatch_state = 'dispatched' OR o.execution_ref_id IS NOT NULL))
          ORDER BY r2.reserved_at
          LIMIT ${RESERVATION_RELEASE_SCAN_LIMIT}
          FOR UPDATE OF r2 SKIP LOCKED)
         AND r.released_at IS NULL
      RETURNING r.id
    `);
    const rows = ((raw as { rows?: unknown[] }).rows ?? (raw as unknown[])) as unknown[];
    return Array.isArray(rows) ? rows.length : 0;
  }));
}

export type ReleaseTaskReservationsResult =
  | { ok: true; released: number }
  | { ok: false; reason: 'task_not_found' | 'task_live'; detail: string };

/**
 * A person confirmed the provider and releases a TERMINAL task's accounts.
 * Refused while the task is live: a live task is still acting, and the way to
 * free its accounts is to stop it. Runs on the caller's handle and RLS
 * context (the route's), org-predicated.
 */
export async function releaseTaskAccountReservations(input: {
  orgId: string;
  taskId: string;
  userId: string | null;
  note: string | null;
}): Promise<ReleaseTaskReservationsResult> {
  const [task] = await db
    .select({ id: aiOperatorTasks.id, state: aiOperatorTasks.state })
    .from(aiOperatorTasks)
    .where(and(eq(aiOperatorTasks.orgId, input.orgId), eq(aiOperatorTasks.id, input.taskId)))
    .limit(1)
    .for('update');
  if (!task) return { ok: false, reason: 'task_not_found', detail: 'task not found' };
  if (!isTerminalTaskState(task.state)) {
    return { ok: false, reason: 'task_live', detail: `task ${input.taskId} is ${task.state}; stop it to release its accounts` };
  }
  const now = new Date();
  const released = await db
    .update(aiOperatorAccountReservations)
    .set({
      releasedAt: now,
      releaseReason: 'released_by_user',
      releasedByUserId: input.userId,
      releaseNote: input.note ? input.note.slice(0, 1000) : null,
      updatedAt: now,
    })
    .where(and(
      eq(aiOperatorAccountReservations.orgId, input.orgId),
      eq(aiOperatorAccountReservations.taskId, input.taskId),
      sql`${aiOperatorAccountReservations.releasedAt} IS NULL`,
    ))
    .returning({ id: aiOperatorAccountReservations.id });
  return { ok: true, released: released.length };
}
