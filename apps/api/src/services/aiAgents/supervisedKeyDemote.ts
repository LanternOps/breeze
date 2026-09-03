// apps/api/src/services/aiAgents/supervisedKeyDemote.ts
/**
 * P2-5 (#4192, Task A2-6) — the DEMOTE executor, the mirror of
 * `supervisedKeyGrant.ts`.
 *
 * The one and only writer that REMOVES a colon key from an organization's
 * `ai_agents.actAssets.supervisedActionKeys`. Two events reach it, and they
 * are the two ways an unattended operation proves it should not have been
 * unattended:
 *
 *   - an ATTEMPTED failure of a released intent (`intentReleaseWorker.ts` —
 *     the terminal write stamped `executed_at`, so the provider-side call
 *     really happened and really failed);
 *   - a fix-watch `recurred` verdict (`fixWatch.ts` — the fix did not hold).
 *
 * Three properties make this safe to run unattended, and all three are the
 * reason it exists as its own module rather than as a second half of
 * `supervisedKeyGrant.ts`:
 *
 * 1. **ALWAYS ON.** Unlike the promote executor it never consults
 *    `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED`. Flipping the flag off stops
 *    new grants; it must never strand an existing one on an agent whose last
 *    attempt failed.
 *
 * 2. **It rides the transaction that recorded the negative evidence.** Both
 *    callers hand it the executor of a SAVEPOINT nested inside the
 *    transaction that just wrote the `failed` / `recurred` row, so on the
 *    happy path the revoke and the evidence that justifies it commit
 *    together, while a revoke failure rolls back to that savepoint and is
 *    Sentry-captured rather than unwinding a terminal state (an already-
 *    executed action in the release worker; a recurrence verdict a human
 *    needs to see in `fixWatch`). That is what
 *    the `database` parameter is for — the same shape `insertOpEvidence` and
 *    `createIntentFixWatchRow` already use, and for the same reason: a
 *    statement issued through the AMBIENT `db` proxy inside a savepoint goes
 *    to the OUTER scope, where postgres-js records its failure and rethrows
 *    it at scope end even if the caller caught it, aborting the terminal CAS
 *    of an action that already ran.
 *
 * 3. **Its import closure stays clean.** `fixWatch.ts` is the only real
 *    dependency of `fixWatchWorker`, a `global`-placement worker
 *    (`services/workerRegistry.ts`) that
 *    `workerEntrypointClosure.contract.test.ts` forbids from reaching
 *    `routes/agentWs.ts` / `services/agentCommandAwait.ts`. Putting the
 *    revoke in `supervisedKeyGrant.ts` would import that whole graph into
 *    `fixWatch.ts`: the promote executor needs `agentService.withAgentRowLocked`,
 *    `agentService.ts` imports `actionIntents/policyDecidable`, and that
 *    reaches `aiTools.ts` and thence the route graph. Verified, not assumed —
 *    the same reasoning `graduationService.ts`'s header records for
 *    `policyDecidableKeys.ts`.
 *
 * Tenancy: the whole executor runs under a system context (the partner
 * baseline row is invisible to an org-scoped reader), so — per this repo's
 * invariant — every statement predicates on `org_id` / `partner_id`
 * explicitly even though RLS passes unconditionally there. `agentId` is never
 * trusted on its own: it is re-pinned through the organization's OWN partner
 * before it is allowed to name a `kind`.
 *
 * Leak rules: the audit row and the notification carry identifiers only —
 * the agent name, the op key, ids, a reason enum. Never a tool result, an
 * alert message, or any model-authored text.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { AiAgentRecipients } from '@breeze/shared';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../../db';
// Direct module imports, NOT the ../../db/schema barrel — same reason
// graduationService.ts and effectivePolicy.ts give: this module is reachable
// from the intent-release path AND from the fix-watch worker, and pulling the
// barrel would force every partial-mock unit test of those paths to stub the
// entire schema surface.
import { aiAgentGraduation } from '../../db/schema/aiAgentGraduation';
import { aiAgentRuns, aiAgents } from '../../db/schema/aiAgents';
import { organizations } from '../../db/schema/orgs';
import { captureException } from '../sentry';
import { createAuditLogAsync } from '../auditService';
import { ANONYMOUS_ACTOR_ID } from '../auditEvents';
import { createNotification } from '../userNotifications';
import { mergeAgentPolicies, normalizeAgentPolicy } from './effectivePolicy';
import { withGraduationLock } from './graduationService';
import { resolveRecipientUserIds } from './recipients';

/** Which disqualifying signal revoked the key. Persisted as `demote_reason`. */
export type AiAgentDemoteReason = 'attempted_failure' | 'recurrence';

/**
 * The executor the caller's transaction is running on. Defaults to the
 * ambient `db` proxy; both callers pass their SAVEPOINT's `tx` so a failure
 * here rolls the revoke back to that savepoint instead of aborting the
 * terminal state the savepoint is nested in. Mirrors `fixWatch.ts`'s
 * `WatchDatabase`.
 */
export type DemoteDatabase = Pick<typeof db, 'select' | 'update' | 'insert' | 'execute'>;

export interface DemoteSupervisedKeyInput {
  orgId: string;
  /** The EFFECTIVE agent id — the PARTNER baseline row, what evidence and
   *  graduation rows are keyed by. */
  agentId: string;
  opKey: string;
  reason: AiAgentDemoteReason;
  runId: string | null;
  watchId: string | null;
  intentId: string | null;
}

export interface DemoteSupervisedKeyResult {
  /** True only when a key was actually removed from the ORG row. */
  revoked: boolean;
  /** The ORG row the key was (or would have been) revoked from, when one exists. */
  orgAgentId: string | null;
}

const NOTHING_TO_REVOKE: DemoteSupervisedKeyResult = { revoked: false, orgAgentId: null };

/** Join the ambient system context, or open one. Mirrors `graduationService.ts`. */
async function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, 'aiAgents.supervisedKeyDemote'));
}

/**
 * Removes `opKey` from the ORG row's `supervisedActionKeys`, in a SAVEPOINT
 * of the SAME transaction as the negative evidence insert and under the same
 * `withGraduationLock` that serializes the promote executor and the daily
 * refresh on this `(org, agent, op_key)` tuple.
 *
 * Never touches `enabled`, `mode`, or the PARTNER row — the partner list is a
 * CEILING (C3), and narrowing it is a partner-level policy decision no
 * automated signal from one org may make. A key held only by that ceiling
 * therefore has nothing to revoke: the effective grant for an org with no
 * override is already `[]`, so `{ revoked: false }` is returned and NOTHING
 * is written — no graduation row, no audit, no notification. Recording a
 * demotion for a key that was never live would put a `demoted` state (and a
 * `demoted_at` window clamp) on a tuple that never graduated.
 *
 * Notification is the CALLER's job, strictly AFTER the transaction commits —
 * see `notifyDemotion`.
 *
 * Ordering is load-bearing. The tuple's advisory lock is taken first and held
 * for the rest of the transaction, then the ORG row's own `SELECT … FOR
 * UPDATE`. That is the same order `authorizeSupervisedKey` uses (advisory
 * lock, then row locks), which is what makes a promote/demote deadlock
 * structurally impossible rather than merely unlikely. The row lock — not the
 * advisory lock — is also what excludes a concurrent operator `PATCH`, since
 * `withAgentRowLocked` (`agentService.ts`) locks the very same row before its
 * own read-modify-write of this jsonb column.
 */
export async function demoteSupervisedKey(
  input: DemoteSupervisedKeyInput,
  database: DemoteDatabase = db,
): Promise<DemoteSupervisedKeyResult> {
  const { orgId, agentId, opKey, reason, runId, watchId, intentId } = input;

  return inSystemDbContext(async () => {
    // (1) The organization's OWN partner. `agentId` arrives from an evidence
    // row / a watch row and is never trusted to name a partner by itself: a
    // baseline belonging to some other partner must not be able to select
    // which `kind` gets revoked in THIS org.
    const [org] = await database
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) return NOTHING_TO_REVOKE;

    // (2) The baseline row, pinned through that partner, for its `kind` —
    // the only link between the effective agent id and the org's override row
    // (there is no FK between them; `(org_id, kind)` is the pairing every
    // resolver uses).
    const [baseline] = await database
      .select({ kind: aiAgents.kind })
      .from(aiAgents)
      .where(and(
        eq(aiAgents.id, agentId),
        eq(aiAgents.partnerId, org.partnerId),
        isNull(aiAgents.orgId),
        isNull(aiAgents.disabledAt),
      ))
      .limit(1);
    if (!baseline) return NOTHING_TO_REVOKE;

    return withGraduationLock(orgId, agentId, opKey, async () => {
      // (3) The ORG override row, locked. No row at all means the effective
      // grant is `[]` (C3) — there is nothing to revoke and nothing to record.
      const [orgRow] = await database
        .select()
        .from(aiAgents)
        .where(and(
          eq(aiAgents.orgId, orgId),
          eq(aiAgents.kind, baseline.kind),
          isNull(aiAgents.disabledAt),
        ))
        .limit(1)
        .for('update');
      if (!orgRow) return NOTHING_TO_REVOKE;

      const stored = normalizeAgentPolicy(orgRow);
      const current = stored.actAssets.supervisedActionKeys ?? [];
      if (!current.includes(opKey)) return { revoked: false, orgAgentId: orgRow.id };

      const demotedAt = new Date();
      // ONLY `act_assets` and `updated_at`. Not `enabled`, not `mode`, not
      // `last_updated_by` — no human did this, and stamping a stale actor
      // onto the row would misattribute the next operator's audit trail.
      await database
        .update(aiAgents)
        .set({
          actAssets: {
            ...stored.actAssets,
            supervisedActionKeys: current.filter((key) => key !== opKey),
          },
          updatedAt: demotedAt,
        })
        .where(eq(aiAgents.id, orgRow.id));

      // Identifiers only. `createAuditLogAsync`, not `createAuditLog`: it
      // writes on its own connection outside this transaction and NEVER
      // rejects (it queues for retry, then Sentry-captures), so an audit
      // hiccup can never be the reason an agent keeps unattended authority
      // its last attempt disproved. The promote executor's throwing variant
      // is right there for the opposite reason — refusing to GRANT is the
      // safe direction, refusing to REVOKE is not.
      await createAuditLogAsync({
        orgId,
        actorType: 'system',
        actorId: ANONYMOUS_ACTOR_ID,
        action: 'ai.agent.supervised_key.revoked',
        resourceType: 'ai_agent',
        resourceId: orgRow.id,
        details: { agentId, orgAgentId: orgRow.id, opKey, reason, runId, watchId, intentId },
        result: 'success',
      });

      await database
        .insert(aiAgentGraduation)
        .values({
          orgId,
          agentId,
          opKey,
          state: 'demoted',
          // The evidence window's lower bound becomes `demoted_at`
          // (`graduationService.windowLowerBound`), so a `first_verified_at`
          // earned BEFORE the demotion is no longer inside the window it
          // claims to describe. Cleared for the same reason the promote
          // executor clears `demoted_at`: a stale bound is read back as a
          // fact by the next refresh and by any operator looking at the row.
          firstVerifiedAt: null,
          demotedAt,
          demoteReason: reason,
          demoteRunId: runId,
          demoteWatchId: watchId,
          updatedAt: demotedAt,
        })
        .onConflictDoUpdate({
          target: [aiAgentGraduation.orgId, aiAgentGraduation.agentId, aiAgentGraduation.opKey],
          set: {
            state: 'demoted',
            firstVerifiedAt: null,
            demotedAt,
            demoteReason: reason,
            demoteRunId: runId,
            demoteWatchId: watchId,
            updatedAt: demotedAt,
          },
          // `promoted_at` / `promoted_intent_id` are deliberately PRESERVED:
          // they are the provenance of the approval that granted the key, and
          // a demotion does not un-happen it. `evaluateEligibility` derives
          // `promoted` from the live grant, never from those columns, so a
          // kept promotion timestamp cannot make a revoked key read as live.
        });

      return { revoked: true, orgAgentId: orgRow.id };
    }, database);
  });
}

export interface NotifyDemotionInput {
  orgId: string;
  /** The EFFECTIVE agent id — whose name and recipients the notice uses. */
  agentId: string;
  /** The ORG row the key was revoked from — the dedupe key's subject. */
  orgAgentId: string;
  opKey: string;
  reason: AiAgentDemoteReason;
  runId: string | null;
  watchId: string | null;
}

/** The one sentence that differs between the two triggers. Fixed strings —
 *  never a tool result, an error message, or a model-authored rationale. */
const DEMOTE_REASON_CLAUSE: Record<AiAgentDemoteReason, string> = {
  attempted_failure: 'its last attempt failed.',
  recurrence: 'the alert it fixed recurred.',
};

/**
 * Tells the agent's recipients that a key stopped running unattended.
 * Modelled on `fixWatch.ts`'s `sendRecurrenceNotifications`: recipients come
 * from the RUN's immutable policy snapshot (the baseline agent row's own
 * `recipients` column is the PARTNER's and silently drops everyone an
 * organization added through its override), priority `high`, and the copy
 * names the agent and the op key and nothing else.
 *
 * MUST be called strictly AFTER the demote transaction commits — a
 * notification for a revoke that then rolls back is a false alarm an operator
 * cannot distinguish from a real one. Callers wrap it: a failure here is
 * logged, never allowed to unwind a committed revoke.
 *
 * **An unreadable run no longer suppresses the notice (#4582, spec §4.5 /
 * P2-5 Task 16).** The run's snapshot is the PREFERRED recipient source, not a
 * precondition: it is the policy the run actually executed under, so it names
 * exactly the people who were on the hook for the operation being graded. When
 * it cannot be read the fallback is the org's EFFECTIVE recipients — the
 * partner baseline's `recipients` merged with the org override's, through the
 * canonical `mergeAgentPolicies` so the union rule can never drift from the one
 * every other reader sees. The baseline row's own column alone would NOT do: it
 * is the PARTNER's list and silently drops everyone the organization added.
 *
 * The previous stand-down was the bug: the demote transaction has already
 * COMMITTED by the time this runs, so returning early leaves an organization
 * stripped of unattended authority with nobody told. An empty recipient set is
 * still a legitimate outcome; an unattempted resolution is not.
 *
 * Reachability, stated precisely because the dropped branch was justified as
 * unreachable once already: `runId === null` cannot be produced by either
 * caller today (`ai_agent_fix_watches.run_id` is NOT NULL, and the release
 * worker returns before building an input when `requesting_agent_run_id` is
 * absent), so that arm is a contract guarantee for this function's exported
 * `string | null` signature. The arm that IS reachable is a run row that no
 * longer resolves — `ai_agent_runs` is org-cascade registered, so an erasure
 * racing a fix-watch phase-2 job hits exactly this path.
 *
 * `resolveRecipientUserIds` re-derives live membership against THIS org in
 * either case, so the fallback cannot widen the audience beyond people who
 * currently have access to the org the notice describes.
 *
 * The three ways this can still end without a page — no agent row, no
 * resolvable recipient, a throw — are all Sentry-captured rather than logged
 * to a console nobody reads in production. A committed revoke that notifies
 * nobody must be visible however it happens; only the ROUTE differs from the
 * bug this closed.
 */
export async function notifyDemotion(input: NotifyDemotionInput): Promise<void> {
  const { orgId, agentId, orgAgentId, opKey, reason, runId, watchId } = input;

  await inSystemDbContext(async () => {
    // The FULL baseline row, not just its name: `kind` pairs it with the org
    // override (there is no FK between them), and its policy columns are the
    // partner half of the run-less fallback below. One read either way.
    const [agentRow] = await db
      .select()
      .from(aiAgents)
      .where(eq(aiAgents.id, agentId))
      .limit(1);
    if (!agentRow) {
      // Nothing to build a notice FROM — no name, no recipients — so this one
      // really cannot notify. It is read by primary key, the same id the
      // caller resolved moments earlier, so a miss is a genuine anomaly and
      // gets a Sentry report rather than the console line it used to get.
      // Identifiers only, per this module's leak rules.
      captureException(
        new Error(
          `[supervisedKeyDemote] agent ${agentId} no longer exists; the revoke of "${opKey}" `
          + `on org agent ${orgAgentId} notified NOBODY`,
        ),
        undefined,
        { org_id: orgId },
      );
      return;
    }

    const runSnapshot = runId
      ? (await db
        .select({ policySnapshot: aiAgentRuns.policySnapshot })
        .from(aiAgentRuns)
        .where(and(eq(aiAgentRuns.id, runId), eq(aiAgentRuns.orgId, orgId)))
        .limit(1))[0]
      : undefined;

    let recipients: Partial<AiAgentRecipients>;
    if (runSnapshot) {
      recipients = runSnapshot.policySnapshot?.effective?.recipients ?? {};
    } else {
      // NOT a skip (#4582). The org override row is read by `(org_id, kind)`
      // — the same pairing the demote executor used to find the row it
      // revoked from — and merged through the canonical tighten-only merge,
      // whose `recipients` rule is a UNION of both layers. A missing override
      // degrades to the partner's own list rather than to silence.
      const [orgAgentRow] = await db
        .select()
        .from(aiAgents)
        .where(and(
          eq(aiAgents.orgId, orgId),
          eq(aiAgents.kind, agentRow.kind),
          isNull(aiAgents.disabledAt),
        ))
        .limit(1);
      recipients = mergeAgentPolicies(
        normalizeAgentPolicy(agentRow),
        orgAgentRow ? normalizeAgentPolicy(orgAgentRow) : null,
        { allowedModels: null },
      ).effective.recipients;
      // Not a failure — the notice still goes out — but the recipient list
      // just came from the live policy rather than the run's immutable
      // snapshot, and the missing run row is itself worth a look.
      captureException(
        new Error(
          `[supervisedKeyDemote] no readable run (run ${runId ?? 'none'}, watch ${watchId ?? 'none'}) `
          + `for the revoke of "${opKey}" on org agent ${orgAgentId}; `
          + 'used the effective-policy recipients instead',
        ),
        undefined,
        { org_id: orgId },
      );
    }

    const userIds = await resolveRecipientUserIds(
      { orgId: agentRow.orgId, partnerId: agentRow.partnerId, recipients },
      orgId,
    );
    if (userIds.length === 0) {
      // The outcome #4582 is ultimately about, reached by the one route this
      // function cannot fix: the recipients resolved to nobody. Legitimate on
      // its face (memberships lapse), but an act-mode agent is only allowed to
      // start with a resolvable recipient (`hasResolvableAgentRecipient`), so
      // a granted-then-revoked key with zero is worth an operator's attention.
      captureException(
        new Error(
          `[supervisedKeyDemote] the revoke of "${opKey}" on org agent ${orgAgentId} `
          + 'resolved to ZERO recipients; nobody was notified',
        ),
        undefined,
        { org_id: orgId },
      );
    }

    // One notice per (org row, key, episode). N sibling watches of one run
    // that all revoke the same key collapse into one page; a second, genuinely
    // distinct episode carries a different run id. `<runId ?? watchId>` is
    // what the P2-5 plan specified: with no run the WATCH is the episode.
    //
    // Null — no dedupe key at all — when neither identifies the episode. A
    // literal placeholder would be worse than nothing: `(user_id, dedupe_key)`
    // is a partial unique index with no time bound, so a fixed suffix would
    // collapse every FUTURE demotion of this tuple into the first one. With no
    // episode there are no siblings to collapse. `runId`/`watchId` ride in
    // `metadata` either way, so the notice stays traceable.
    const episodeId = runId ?? watchId;
    // The run page would 404 without a readable run, so the link degrades with
    // the recipient source, to the page whose state actually changed.
    const link = runSnapshot ? `/ai-agents/runs/${runId}` : '/settings/ai-agents';

    for (const userId of userIds) {
      await createNotification({
        userId,
        orgId,
        type: 'ai',
        title: `Unattended approval revoked: ${agentRow.name}`,
        message:
          `${agentRow.name} no longer runs "${opKey}" without approval — `
          + DEMOTE_REASON_CLAUSE[reason],
        link,
        priority: 'high',
        metadata: { agentId, orgAgentId, opKey, reason, runId, watchId },
        dedupeKey: episodeId ? `graduation-demote-${orgAgentId}-${opKey}-${episodeId}` : null,
      });
    }
  });
}
