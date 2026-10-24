/**
 * The completion record (Recipe Library spec §6.6, §5.5; W06 R1a Task 12).
 *
 * BOUNDED TEXT, NEVER JSONB ("the completion record is bounded `text`, not
 * jsonb, so it survives export"). Assembled from ROWS — target labels, the
 * approval and its effects, the operations, the checklist items and who ticked
 * them, the verification verdict, the run spend. The model's only contribution
 * is the narrative paragraph: last, labelled, and the first thing cut.
 *
 * Sections, in order: Targets, Effects, Human work, Not independently
 * verifiable, Unresolved, Cost, Narrative. Truncation order when over
 * `COMPLETION_RECORD_MAX_CHARS`: the narrative, then the effect lines, then
 * the rest — the Unresolved section is never the part that gets cut, because
 * it is the list a technician must act on.
 *
 * Labels are FROZEN labels (target and principal labels as admitted), so a
 * rename after the fact cannot rewrite what was done. Secret-shaped substrings
 * are redacted from every line as a last line of defence; no operation result
 * body is ever rendered, only its state.
 *
 * Posted as an INTERNAL comment through a direct `ticket_comments` insert
 * authored by the AI Operator — the same path E3's reminders use, because
 * `addTicketComment` requires a user principal and the Operator is not one.
 * Idempotent through a guarded stamp on the `document` step row, in the
 * caller's leased transaction.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiOperatorTasks } from '../../db/schema/aiOperatorTasks';
import { aiOperatorTaskSteps, aiOperatorTaskTargetAccounts, aiOperatorTaskTargets } from '../../db/schema/aiOperatorTaskGraph';
import { aiOperatorPlanApprovalEffects, aiOperatorPlanApprovals } from '../../db/schema/aiOperatorPlanApprovals';
import { aiOperatorOperations } from '../../db/schema/aiOperatorTasks';
import { ticketChecklistItems } from '../../db/schema/ticketChecklists';
import { ticketComments } from '../../db/schema/portal';
import { users } from '../../db/schema/users';
import { planEffectOperationKey } from './planApproval';
import { readTaskSpentCents } from './taskLimitsLoader';
import { OPERATOR_TASK_ACTOR, type HumanWorkDbHandle } from './humanWorkService';
import { assertTicketNotMerged } from '../ticketMerge/errors';
import { lockTicketForWrite } from '../ticketRowLock';

export const COMPLETION_RECORD_MAX_CHARS = 12_000;
const NARRATIVE_MAX_CHARS = 2_000;
const UNRESOLVED_MAX_CHARS = 6_000;
const TRUNCATED_MARKER = '… truncated';

export interface CompletionRecordInput { orgId: string; taskId: string; recipeKey: string }
export interface CompletionRecord { text: string; truncated: boolean }

export class CompletionRecordNoTicketError extends Error {
  constructor(taskId: string) {
    super(`[aiOperator] completion record for task ${taskId} has no ticket in its organization to post to`);
    this.name = 'CompletionRecordNoTicketError';
  }
}

export interface CompletionRecordEffect {
  ordinal: number;
  provider: string;
  toolName: string;
  rendering: string;
  outcome: 'succeeded' | 'noop' | 'failed' | 'refused' | 'pending' | 'unknown' | 'not_started';
  verification: 'verified' | 'not_verified' | 'unobservable' | 'none';
  subsumedBy?: string;
}

export interface CompletionRecordData {
  recipeKey: string;
  targets: Array<{ kind: string; label: string; detached: boolean }>;
  accounts: Array<{ provider: string; principalLabel: string }>;
  approverName: string | null;
  effects: CompletionRecordEffect[];
  humanWork: Array<{ label: string; done: boolean; completedBy: string | null; completedAt: string | null }>;
  verification: { result: string; detail: string } | null;
  discoveryFlags: Array<{ code: string; subject: string; detail: string }>;
  costCents: number;
  narrative: string | null;
}

/**
 * A field that mentions anything secret-shaped is withheld WHOLE, not
 * partially masked: "set password to hunter2" with only the keyword masked
 * would still print the value.
 */
/**
 * Keywords bounded by LETTERS, not `\b`: `_` and digits count as separators, so
 * `client_secret=`, `db_password=` and `passwords:` match, while a keyword that
 * is only the start of a longer word ("Passmore", "Secretaries") does not.
 */
const SECRET_WORDS = /-----BEGIN|(?<![a-z])(pass(word|wd|phrase|code)?s?|pwd|secrets?|credentials?|service[ _]?account[ _]?keys?|vault[ _]?refs?|private[ _]?keys?|api[ _]?keys?|access[ _]?tokens?|refresh[ _]?tokens?|tokens?|pins?|otps?|recovery[ _]?(code|key)s?|bearer)(?![a-z])/i;
/** camelCase field names (`clientSecret`, `refreshToken`), which a word boundary misses. */
const SECRET_CAMEL = /[a-z](Secret|Password|Passwd|Token|ApiKey|PrivateKey)s?(?![a-z])|(?<![A-Za-z])(secret|password|passwd|token)s?[A-Z]/;
/**
 * Value shapes, keyword or not: a JWT, cloud key prefixes, or a long
 * high-entropy run. The run excludes `-`, so a GUID (hyphenated groups of at
 * most 12) never matches — group and object ids are ordinary record content.
 */
const SECRET_SHAPES = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|\b(AKIA|ASIA)[A-Z0-9]{16}\b|\bAIza[0-9A-Za-z_-]{30,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{40,}/;
/** GUIDs are removed before the shape test, so ids stay readable and `-` can stay in the long-run shape. */
const GUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const SECRETISH = { test: (s: string) => SECRET_WORDS.test(s) || SECRET_CAMEL.test(s) || SECRET_SHAPES.test(s.replace(GUID, ' ')) };

function clean(s: string, max = 500): string {
  const flat = s.replace(/[\r\n]+/g, ' ').trim();
  return (SECRETISH.test(flat) ? '[redacted]' : flat).slice(0, max);
}

/**
 * The verification detail, cleaned per problem so one secret-shaped leftover
 * does not withhold the list. Backstop: if the WHOLE detail is secret-shaped
 * but no single problem is (a match spanning the separator), withhold it all.
 * No current pattern admits `; `, so this guards future patterns, not today's.
 */
function verificationDetail(detail: string): string {
  const parts = detail.split('; ').map((part) => clean(part, 300));
  const flat = detail.replace(/[\r\n]+/g, ' ');
  if (SECRETISH.test(flat) && !parts.includes('[redacted]')) return '[redacted]';
  return parts.join('; ').slice(0, 800);
}

function outcomeText(e: CompletionRecordEffect): string {
  switch (e.outcome) {
    case 'noop': return 'succeeded (no-op, already in the desired state)';
    case 'not_started': return 'not started';
    default: return e.outcome;
  }
}

function verificationText(e: CompletionRecordEffect): string {
  switch (e.verification) {
    case 'verified': return 'verified';
    case 'unobservable': return 'not independently verifiable';
    case 'not_verified': return 'NOT verified';
    default: return 'no verification';
  }
}

/** PURE. The whole record from already-loaded rows. */
export function renderCompletionRecord(data: CompletionRecordData): CompletionRecord {
  const header = `# AI Operator completion record (${clean(data.recipeKey, 64)})`;

  const targets = ['## Targets',
    ...data.targets.map((t) => `- ${clean(t.kind, 16)}: ${clean(t.label, 255)}${t.detached ? ' (detached)' : ''}`),
    ...data.accounts.map((a) => `- ${clean(a.provider, 16)} account: ${clean(a.principalLabel, 255)}`)];
  if (targets.length === 1) targets.push('- (none)');

  const approver = data.approverName ? `approved by ${clean(data.approverName, 120)}` : 'no approver recorded';
  const effectLines = data.effects.map((e) =>
    `- #${e.ordinal} ${clean(e.provider, 16)} ${clean(e.toolName, 64)} — ${outcomeText(e)}, ${verificationText(e)}, ${approver}: ${clean(e.rendering, 200)}`);
  const effects = ['## Effects', ...(effectLines.length > 0 ? effectLines : ['- (no automated effects)'])];

  const humanWork = ['## Human work',
    ...(data.humanWork.length > 0
      ? data.humanWork.map((h) => `- [${h.done ? 'x' : ' '}] ${clean(h.label, 300)}`
        + (h.done ? ` — completed by ${clean(h.completedBy ?? 'unknown user', 120)}${h.completedAt ? ` at ${h.completedAt}` : ''}` : ''))
      : ['- (none)'])];

  const unverifiable = ['## Not independently verifiable',
    ...data.effects.filter((e) => e.verification === 'unobservable').map((e) =>
      `- ${clean(e.toolName, 64)}: dispatched, not independently verifiable`
        + (e.subsumedBy ? `; superseded by the verified ${clean(e.subsumedBy, 64)}` : '; no subsuming check was confirmed'))];
  if (unverifiable.length === 1) unverifiable.push('- (none)');

  const unresolvedItems = [
    ...data.humanWork.filter((h) => !h.done).map((h) => `- Not done by hand yet: ${clean(h.label, 300)}`),
    ...data.effects.filter((e) => e.outcome !== 'succeeded' && e.outcome !== 'noop')
      .map((e) => `- ${clean(e.toolName, 64)} (#${e.ordinal}): ${outcomeText(e)}`),
    ...data.effects.filter((e) => (e.outcome === 'succeeded') && e.verification === 'not_verified')
      .map((e) => `- ${clean(e.toolName, 64)} (#${e.ordinal}): ran but was not verified`),
    ...(data.verification && data.verification.result !== 'passed'
      // Cleaned PER PROBLEM: one secret-shaped leftover withholds that one, not
      // the whole list a technician has to act on.
      ? [`- Final verification ${clean(data.verification.result, 32)}: ${
        verificationDetail(data.verification.detail)}`] : []),
    ...data.discoveryFlags.map((f) => `- Discovery: ${clean(f.code, 64)} (${clean(f.subject, 120)}): ${clean(f.detail, 300)}`),
  ];
  let unresolvedText = ['## Unresolved', ...(unresolvedItems.length > 0 ? unresolvedItems : ['- (nothing)'])].join('\n');
  if (unresolvedText.length > UNRESOLVED_MAX_CHARS) unresolvedText = `${unresolvedText.slice(0, UNRESOLVED_MAX_CHARS - TRUNCATED_MARKER.length - 1)}\n${TRUNCATED_MARKER}`;

  const cost = ['## Cost', `- AI reasoning spend for this task: $${(Math.max(0, data.costCents) / 100).toFixed(2)}`];
  const narrativeBody = data.narrative ? clean(data.narrative, NARRATIVE_MAX_CHARS) : '(no narrative)';
  const narrativeHead = '## Narrative (written by the AI Operator; the sections above are from records)';

  // Assemble with the truncation order: narrative, then effect lines, then the rest.
  let truncated = false;
  const fixedTail = (narr: string) => [cost.join('\n'), `${narrativeHead}\n${narr}`].join('\n\n');
  let effectsBlock = effects.join('\n');
  let restBlocks = [targets.join('\n'), humanWork.join('\n'), unverifiable.join('\n')];
  const assemble = (narr: string) => [header, restBlocks[0], effectsBlock, restBlocks[1], restBlocks[2], unresolvedText, fixedTail(narr)].join('\n\n');

  let narrative = narrativeBody;
  let text = assemble(narrative);
  if (text.length > COMPLETION_RECORD_MAX_CHARS) {
    truncated = true;
    const over = text.length - COMPLETION_RECORD_MAX_CHARS;
    narrative = narrative.length > over + TRUNCATED_MARKER.length + 1
      ? `${narrative.slice(0, narrative.length - over - TRUNCATED_MARKER.length - 1)} ${TRUNCATED_MARKER}`
      : TRUNCATED_MARKER;
    text = assemble(narrative);
  }
  if (text.length > COMPLETION_RECORD_MAX_CHARS) {
    const budget = Math.max(0, effectsBlock.length - (text.length - COMPLETION_RECORD_MAX_CHARS) - TRUNCATED_MARKER.length - 1);
    effectsBlock = `${effectsBlock.slice(0, budget)}\n${TRUNCATED_MARKER}`;
    text = assemble(narrative);
  }
  if (text.length > COMPLETION_RECORD_MAX_CHARS) {
    restBlocks = restBlocks.map((b) => {
      const allowed = Math.max(40, Math.floor(b.length / 2));
      return b.length > allowed ? `${b.slice(0, allowed)}\n${TRUNCATED_MARKER}` : b;
    });
    text = assemble(narrative);
  }
  if (text.length > COMPLETION_RECORD_MAX_CHARS) {
    // Unreachable with the caps above; never exceed the bound regardless.
    text = `${text.slice(0, COMPLETION_RECORD_MAX_CHARS - TRUNCATED_MARKER.length - 1)}\n${TRUNCATED_MARKER}`;
  }
  return { text, truncated };
}

/** I/O. Load every row the record is built from, in system scope, each read org-predicated. */
export async function loadCompletionData(input: CompletionRecordInput): Promise<CompletionRecordData & { ticketId: string | null }> {
  const { orgId, taskId } = input;
  const costCents = await readTaskSpentCents(orgId, taskId);
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [task] = await db
      .select({ revision: aiOperatorTasks.revision, checkpoint: aiOperatorTasks.checkpoint })
      .from(aiOperatorTasks)
      .where(and(eq(aiOperatorTasks.orgId, orgId), eq(aiOperatorTasks.id, taskId)))
      .limit(1);
    if (!task) throw new Error(`[aiOperator] completion record: task ${taskId} not found in org ${orgId}`);

    const targetRows = await db
      .select({ kind: aiOperatorTaskTargets.targetKind, label: aiOperatorTaskTargets.targetLabel, detachedAt: aiOperatorTaskTargets.detachedAt, ticketId: aiOperatorTaskTargets.ticketId })
      .from(aiOperatorTaskTargets)
      .where(and(eq(aiOperatorTaskTargets.orgId, orgId), eq(aiOperatorTaskTargets.taskId, taskId)))
      .orderBy(asc(aiOperatorTaskTargets.targetOrdinal));
    const accountRows = await db
      .select({ provider: aiOperatorTaskTargetAccounts.provider, principalLabel: aiOperatorTaskTargetAccounts.principalLabel })
      .from(aiOperatorTaskTargetAccounts)
      .where(and(eq(aiOperatorTaskTargetAccounts.orgId, orgId), eq(aiOperatorTaskTargetAccounts.taskId, taskId)));

    const [approval] = await db
      .select({ id: aiOperatorPlanApprovals.id, stepKey: aiOperatorPlanApprovals.stepKey, approvedBy: aiOperatorPlanApprovals.approvedByUserId })
      .from(aiOperatorPlanApprovals)
      .where(and(eq(aiOperatorPlanApprovals.orgId, orgId), eq(aiOperatorPlanApprovals.taskId, taskId), eq(aiOperatorPlanApprovals.planRevision, task.revision)))
      .limit(1);
    const effectRows = approval ? await db
      .select({
        ordinal: aiOperatorPlanApprovalEffects.ordinal, provider: aiOperatorPlanApprovalEffects.provider,
        toolName: aiOperatorPlanApprovalEffects.toolName, targetId: aiOperatorPlanApprovalEffects.targetId,
        rendering: aiOperatorPlanApprovalEffects.rendering,
      })
      .from(aiOperatorPlanApprovalEffects)
      .where(and(eq(aiOperatorPlanApprovalEffects.orgId, orgId), eq(aiOperatorPlanApprovalEffects.approvalId, approval.id)))
      .orderBy(asc(aiOperatorPlanApprovalEffects.ordinal)) : [];
    const keys = effectRows.map((e) => planEffectOperationKey({
      stepKey: approval!.stepKey, planRevision: task.revision, toolName: e.toolName, targetId: e.targetId, ordinal: e.ordinal,
    }));
    const ops = keys.length === 0 ? [] : await db
      .select({ operationKey: aiOperatorOperations.operationKey, resultState: aiOperatorOperations.resultState, result: aiOperatorOperations.result })
      .from(aiOperatorOperations)
      .where(and(eq(aiOperatorOperations.orgId, orgId), eq(aiOperatorOperations.taskId, taskId), inArray(aiOperatorOperations.operationKey, keys)));
    const opByKey = new Map(ops.map((o) => [o.operationKey, o]));

    const itemRows = await db
      .select({
        index: aiOperatorTaskSteps.attemptOrdinal, stepKey: aiOperatorTaskSteps.stepKey,
        label: ticketChecklistItems.label, tickedAt: ticketChecklistItems.doneAt, tickedBy: ticketChecklistItems.doneByUserId,
      })
      .from(aiOperatorTaskSteps)
      .innerJoin(ticketChecklistItems, and(
        eq(ticketChecklistItems.id, aiOperatorTaskSteps.checklistItemId),
        eq(ticketChecklistItems.orgId, aiOperatorTaskSteps.orgId),
      ))
      .where(and(eq(aiOperatorTaskSteps.orgId, orgId), eq(aiOperatorTaskSteps.taskId, taskId), eq(aiOperatorTaskSteps.stepKind, 'human_work')))
      .orderBy(asc(aiOperatorTaskSteps.createdAt), asc(aiOperatorTaskSteps.attemptOrdinal));

    const userIds = [...new Set([approval?.approvedBy, ...itemRows.map((r) => r.tickedBy)].filter((v): v is string => !!v))];
    const names = new Map<string, string>();
    if (userIds.length > 0) {
      const rows = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, userIds));
      for (const r of rows) names.set(r.id, r.name ?? r.email ?? r.id);
    }

    const [review] = await db
      .select({ checkpoint: aiOperatorTaskSteps.checkpoint })
      .from(aiOperatorTaskSteps)
      .where(and(eq(aiOperatorTaskSteps.orgId, orgId), eq(aiOperatorTaskSteps.taskId, taskId), eq(aiOperatorTaskSteps.stepKey, 'review')))
      .limit(1);
    const [discover] = await db
      .select({ checkpoint: aiOperatorTaskSteps.checkpoint })
      .from(aiOperatorTaskSteps)
      .where(and(eq(aiOperatorTaskSteps.orgId, orgId), eq(aiOperatorTaskSteps.taskId, taskId), eq(aiOperatorTaskSteps.stepKey, 'discover')))
      .limit(1);
    const reviewOutput = (review?.checkpoint as { reviewOutput?: { summary?: unknown } } | null)?.reviewOutput;
    const snapshotFacts = (discover?.checkpoint as { planningSnapshot?: { facts?: { flags?: unknown } } } | null)?.planningSnapshot?.facts;
    const flags = Array.isArray(snapshotFacts?.flags) ? snapshotFacts!.flags as Array<Record<string, unknown>> : [];
    const lastVerification = (task.checkpoint as { lastVerification?: { result?: unknown; detail?: unknown } | null } | null)?.lastVerification;

    const effects: CompletionRecordEffect[] = effectRows.map((e, i) => {
      const op = opByKey.get(keys[i]!);
      const result = (op?.result ?? {}) as { noop?: unknown; verified?: { ok?: unknown; unobservable?: unknown; subsumedBy?: unknown } };
      const outcome: CompletionRecordEffect['outcome'] = !op ? 'not_started'
        : result.noop === true ? 'noop'
          : (['succeeded', 'failed', 'refused', 'pending', 'unknown'] as const).find((s) => s === op.resultState) ?? 'unknown';
      const verification: CompletionRecordEffect['verification'] = result.verified?.unobservable === true ? 'unobservable'
        : result.verified?.ok === true || result.noop === true ? 'verified'
          : result.verified?.ok === false ? 'not_verified' : 'none';
      return {
        ordinal: e.ordinal, provider: e.provider, toolName: e.toolName, rendering: e.rendering, outcome, verification,
        ...(typeof result.verified?.subsumedBy === 'string' ? { subsumedBy: result.verified.subsumedBy } : {}),
      };
    });

    return {
      recipeKey: input.recipeKey,
      targets: targetRows.map((t) => ({ kind: t.kind, label: t.label, detached: t.detachedAt !== null })),
      accounts: accountRows.map((a) => ({ provider: a.provider, principalLabel: a.principalLabel })),
      approverName: approval?.approvedBy ? names.get(approval.approvedBy) ?? approval.approvedBy : null,
      effects,
      humanWork: itemRows.map((r) => ({
        label: r.label, done: r.tickedAt !== null,
        completedBy: r.tickedBy ? names.get(r.tickedBy) ?? r.tickedBy : null,
        completedAt: r.tickedAt ? r.tickedAt.toISOString() : null,
      })),
      verification: lastVerification && typeof lastVerification.result === 'string'
        ? { result: lastVerification.result, detail: typeof lastVerification.detail === 'string' ? lastVerification.detail : '' }
        : null,
      discoveryFlags: flags.map((f) => ({ code: String(f.code ?? ''), subject: String(f.subject ?? ''), detail: String(f.detail ?? '') })),
      costCents,
      narrative: typeof reviewOutput?.summary === 'string' ? reviewOutput.summary : null,
      ticketId: targetRows.find((t) => t.kind === 'ticket' && t.ticketId)?.ticketId ?? null,
    };
  }));
}

export async function buildCompletionRecord(input: CompletionRecordInput): Promise<CompletionRecord & { ticketId: string | null }> {
  const data = await loadCompletionData(input);
  return { ...renderCompletionRecord(data), ticketId: data.ticketId };
}

/**
 * Post the record ONCE, in the caller's leased transaction: a guarded stamp on
 * the `document` step row (`checkpoint.completionCommentPosted` absent) wins
 * or the comment is not written. A replay after a crash finds the stamp and
 * posts nothing.
 */
export async function postCompletionRecord(
  dbh: HumanWorkDbHandle,
  input: { orgId: string; taskId: string; ticketId: string | null; stepId: string; text: string },
): Promise<{ posted: boolean; commentId: string | null }> {
  if (!input.ticketId) throw new CompletionRecordNoTicketError(input.taskId);
  // The ticket must be THIS task's org's ticket. The pointer comes from the
  // task's own live ticket target, and a ticket org-move detaches that target,
  // but this write runs in system scope, so the binding is re-proven here
  // under the ticket lock rather than assumed.
  const ticket = await lockTicketForWrite(dbh, input.ticketId);
  if (!ticket || ticket.orgId !== input.orgId) throw new CompletionRecordNoTicketError(input.taskId);
  // A merged tombstone is read-only (#8972 W1). The ticket id was read before
  // this lock; a merge that committed in between re-pointed the task's target
  // to the survivor, so refusing (before the stamp) lets the coordinator's
  // retry rebuild the record against the survivor.
  assertTicketNotMerged(ticket);
  const stamped = await dbh
    .update(aiOperatorTaskSteps)
    .set({
      checkpoint: sql`${aiOperatorTaskSteps.checkpoint} || '{"completionCommentPosted": true}'::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(aiOperatorTaskSteps.id, input.stepId),
      eq(aiOperatorTaskSteps.orgId, input.orgId),
      eq(aiOperatorTaskSteps.taskId, input.taskId),
      isNull(sql`${aiOperatorTaskSteps.checkpoint} ->> 'completionCommentPosted'`),
    ))
    .returning({ id: aiOperatorTaskSteps.id });
  if (stamped.length === 0) return { posted: false, commentId: null };
  const [comment] = await dbh
    .insert(ticketComments)
    .values({
      ticketId: input.ticketId,
      userId: null,
      portalUserId: null,
      authorName: OPERATOR_TASK_ACTOR.name,
      authorType: 'ai_agent',
      originPrincipalKind: 'ai_agent',
      commentType: 'internal',
      isPublic: false,
      content: input.text,
    })
    .returning({ id: ticketComments.id });
  return { posted: true, commentId: comment?.id ?? null };
}
