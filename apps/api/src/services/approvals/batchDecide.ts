import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { isInteractiveUserSession, type AuthContext } from '../../middleware/auth';
import { approvalRequests } from '../../db/schema/approvals';
import { actionIntents, type ActionIntent } from '../../db/schema/actionIntents';
import { isAgentIntentDecideAuthorized } from '../actionIntents/intentApprovers';
import {
  assertApprovalAssurance,
  StepUpRequiredError,
  ReauthRequiredError,
  type AssuranceDecision,
} from '../authenticatorAssurance';
import { decideApprovalRequest, type DecideApprovalResult } from './decideApprovalRequest';
import { APPROVAL_BATCH_MAX, type ApprovalProof, type RiskTier } from '@breeze/shared';

/**
 * P2-2 (#4189): decide MANY approval cards with ONE assertion ceremony.
 *
 * A scheduled sweep proposes one intent — and therefore one approval card —
 * per device, so a fleet-wide finding lands in the approver's inbox as N
 * identical cards. Deciding them one at a time means N WebAuthn / Secure
 * Enclave ceremonies for what is, to the human, a single decision.
 *
 * The safety of collapsing those N ceremonies into one rests entirely on the
 * HOMOGENEITY rule below: the set must be one decision. Every row must be
 *   - still `pending`,
 *   - fanned out to the deciding user,
 *   - linked to a SUPERVISED, AGENT-ORIGINATED intent (`approvalScope ===
 *     'supervised'` AND `requestingAgentRunId != null`), and
 *   - in the same `(orgId, actionToolName, normalized action)` group.
 * Anything else fails the WHOLE batch with 422 and decides nothing — never a
 * partial decide off a set the approver may have misread. Four-eyes cards are
 * excluded structurally (they are never `supervised`), so the two-person rule
 * can never be satisfied by a batch tap.
 *
 * What is NOT collapsed: every row still runs the full per-row decide core
 * (`decideApprovalRequest`) — live agent-decide authority, digest binding,
 * the approval CAS, the intent fan-in, the release lease, events. Only the
 * assurance LADDER is hoisted, because the challenge it consumes is
 * single-use. A row that fails its own gates (409 on a lost race, 410 on
 * expiry, 403 on lost authority) does not stop the others; its result is
 * reported alongside theirs.
 */

/** Hard cap on one batch. Matches the inbox page size (`PENDING_PAGE_MAX`),
 *  so "select everything on this page" is always expressible in one call.
 *  Re-exported under the historical local name — the value itself lives in
 *  `@breeze/shared`'s `APPROVAL_BATCH_MAX` so the web inbox's client-side
 *  guard (#4460) can import the exact same number instead of a copy that
 *  could drift. */
export const BATCH_MAX = APPROVAL_BATCH_MAX;

/**
 * The `approvalId` namespace ONE ceremony is minted and verified under, so the
 * challenge is bound to the exact set AND direction it was issued for — a
 * challenge taken for "approve these 12" can never be replayed to deny them,
 * nor to decide a 13th card that was not in the signed set.
 *
 * Order- and duplicate-insensitive (sorted, de-duplicated) so the client's
 * selection order cannot change the key between
 * `POST /batch/assertion-challenge` and `POST /batch/decide`.
 *
 * Note this value is only ever a Redis key namespace: `assertApprovalAssurance`
 * passes `approvalId` straight through to `approval-assertion:<id>:<userId>` /
 * `mobile-assertion:<id>:<userId>` and never loads an approval row by it, so a
 * synthetic id here is safe by construction rather than by convention.
 */
export function batchAssertionKey(ids: string[], decision: 'approved' | 'denied'): string {
  const canonical = [...new Set(ids)].sort().join(',');
  return `batch-${decision}-${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/** One loaded, validated batch member. */
export interface BatchRow {
  approval: typeof approvalRequests.$inferSelect;
  intent: ActionIntent;
}

export type BatchLoadResult =
  | { ok: true; ids: string[]; rows: BatchRow[]; maxRiskTier: RiskTier }
  | { ok: false; httpStatus: number; body: Record<string, unknown> };

export type BatchRowResult = { id: string; httpStatus: number; body: Record<string, unknown> };

export type DecideApprovalBatchResult =
  | { ok: true; results: BatchRowResult[] }
  | { ok: false; httpStatus: number; body: Record<string, unknown> };

const RISK_TIER_ORDER: RiskTier[] = ['low', 'medium', 'high', 'critical'];

/**
 * The multiplexed tools' `action` discriminator (`manage_services:restart`,
 * `manage_patches:install`, …), lower-cased and trimmed so a purely cosmetic
 * difference in how two intents spelled the same action does not split an
 * otherwise identical set. Null for a tool that is not action-multiplexed —
 * which is itself a group of its own, so a set that mixes "has an action" with
 * "has none" is heterogeneous.
 *
 * Deliberately the same projection `serialize` emits as `action`: the group the
 * server enforces is the group the approver saw on the cards.
 */
function normalizedAction(row: typeof approvalRequests.$inferSelect): string | null {
  const args = row.actionArguments as Record<string, unknown> | null;
  const action = args?.action;
  return typeof action === 'string' ? action.trim().toLowerCase() : null;
}

/** `(orgId, actionToolName, normalized action)` — the whole homogeneity key.
 *  NUL-separated so no value can forge a boundary. */
function groupKey(row: BatchRow): string {
  return [
    row.intent.orgId,
    row.approval.actionToolName,
    normalizedAction(row.approval) ?? '',
  ].join('\u0000');
}

/**
 * Load and validate the batch server-side. NOTHING here trusts the client's
 * claim about what these ids are: the rows and their linked intents are read
 * fresh, and every rule is re-derived from them.
 *
 * System-scoped for the same reason the inbox join is: `action_intents` is
 * org-scoped (Shape 1) and the caller's ambient request context is not
 * guaranteed to see it (a partner approver has no `organization_users` row).
 * The tenancy gate is the `approvalRequests.userId` predicate — a row that is
 * not the caller's is simply not returned, and lands in `offending`
 * indistinguishably from an id that does not exist at all.
 *
 * Expiry is deliberately NOT part of homogeneity: an expired-but-still-pending
 * row is a normal per-row outcome (410 from the decide core), not a reason to
 * refuse the whole set.
 */
export async function loadHomogeneousBatch(
  userId: string,
  approvalRequestIds: string[],
): Promise<BatchLoadResult> {
  // De-duplicate but keep the caller's order, so results come back in the
  // order the cards were selected.
  const ids = [...new Set(approvalRequestIds)];
  if (ids.length === 0) {
    return { ok: false, httpStatus: 400, body: { error: 'batch_empty' } };
  }
  if (ids.length > BATCH_MAX) {
    return { ok: false, httpStatus: 400, body: { error: 'batch_too_large', max: BATCH_MAX } };
  }

  const loaded = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ approval: approvalRequests, intent: actionIntents })
        .from(approvalRequests)
        .leftJoin(actionIntents, eq(approvalRequests.intentId, actionIntents.id))
        .where(and(eq(approvalRequests.userId, userId), inArray(approvalRequests.id, ids))),
    ),
  );

  const byId = new Map(loaded.map((r) => [r.approval.id, r]));
  const offending: string[] = [];
  const rows: BatchRow[] = [];
  for (const id of ids) {
    const found = byId.get(id);
    const intent = found?.intent ?? null;
    if (
      !found ||
      found.approval.status !== 'pending' ||
      !intent ||
      intent.approvalScope !== 'supervised' ||
      intent.requestingAgentRunId == null ||
      // Live authorization, the SAME rule every other read surface applies
      // (`isIntentRowLiveAuthorized` in routes/approvals.ts), specialised to
      // the one shape a batch member can have. Row ownership alone is a
      // durable bearer capability: the row was fanned out to a user who held
      // action-and-target authority at creation time, and nothing else
      // re-checks that they STILL do. Ordered here — before the caller can
      // reach `POST /batch/assertion-challenge`'s minting or the decide
      // ceremony — for exactly the reason the single-card challenge route
      // orders its own check ahead of the challenge: a caller who can no
      // longer act on a row must never mint (and burn) a challenge against it.
      //
      // Two halves, both from that shared rule:
      //   - the intent must still be `pending_approval` (a settled intent is
      //     nobody's to decide), and
      //   - `isAgentIntentDecideAuthorized` must still hold — the decider's
      //     current RBAC over the tool AND reach over the intent's concrete
      //     target, re-derived, never `approvals:decide` and never requester
      //     identity (which is NULL for an agent intent).
      // The decide core re-runs this per row anyway; doing it here too is the
      // same defence-in-depth double-check the single-card challenge + decide
      // pair already performs, and it is what makes the CHALLENGE route safe.
      intent.status !== 'pending_approval' ||
      !(await isAgentIntentDecideAuthorized(userId, intent))
    ) {
      offending.push(id);
      continue;
    }
    rows.push({ approval: found.approval, intent });
  }

  // One group, decided by the FIRST eligible row — every row outside it is
  // reported so the client can deselect precisely.
  const anchor = rows[0];
  if (anchor) {
    const anchorKey = groupKey(anchor);
    for (const row of rows) {
      if (groupKey(row) !== anchorKey) offending.push(row.approval.id);
    }
  }

  if (offending.length > 0) {
    return {
      ok: false,
      httpStatus: 422,
      // Reported in the caller's own id order, so the response lines up with
      // the selection the approver made.
      body: {
        error: 'batch_not_homogeneous',
        offending: ids.filter((id) => offending.includes(id)),
      },
    };
  }

  // The ceremony runs at the HIGHEST tier present, so one low-risk card can
  // never dilute the floor. An unrecognised tier ranks as `critical`, not as
  // "below low" — `indexOf` returns -1 for it, and letting that lose the max
  // would be the one direction that fails OPEN.
  const coerceTier = (tier: string): RiskTier =>
    RISK_TIER_ORDER.includes(tier as RiskTier) ? (tier as RiskTier) : 'critical';
  const maxRiskTier = rows.reduce<RiskTier>((acc, row) => {
    const tier = coerceTier(row.approval.riskTier);
    return RISK_TIER_ORDER.indexOf(tier) > RISK_TIER_ORDER.indexOf(acc) ? tier : acc;
  }, 'low');

  return { ok: true, ids, rows, maxRiskTier };
}

export interface DecideApprovalBatchInput {
  approvalRequestIds: string[];
  decision: 'approved' | 'denied';
  reason?: string;
  proof?: ApprovalProof;
}

export async function decideApprovalBatch(
  auth: AuthContext,
  input: DecideApprovalBatchInput,
): Promise<DecideApprovalBatchResult> {
  // Same allowlist-of-one the single-card core asserts, applied before a row is
  // even loaded — batching must not become the one decide surface a non-human
  // principal can reach.
  if (!isInteractiveUserSession(auth)) {
    return { ok: false, httpStatus: 403, body: { error: 'human_decision_required' } };
  }

  const loaded = await loadHomogeneousBatch(auth.user.id, input.approvalRequestIds);
  if (!loaded.ok) return loaded;

  // ONE ceremony for the whole set, at the HIGHEST risk tier present — a
  // single low-risk card can never dilute the floor the batch has to clear.
  //
  // `reauthVerified` is intentionally not plumbed here: a critical (L4) card
  // therefore cannot clear the ladder in a batch and the whole set 401s
  // `reauth_required`, which is the fail-closed direction. Critical cards are
  // decided one at a time, where the re-auth is collected per decision.
  let assurance: AssuranceDecision;
  try {
    assurance = await assertApprovalAssurance({
      approvalId: batchAssertionKey(loaded.ids, input.decision),
      userId: auth.user.id,
      riskTier: loaded.maxRiskTier,
      proof: input.proof,
      partnerId: auth.partnerId ?? null,
      decision: input.decision,
    });
  } catch (err) {
    if (err instanceof StepUpRequiredError) {
      return {
        ok: false,
        httpStatus: 403,
        body: { error: 'step_up_required', requiredLevel: err.requiredLevel },
      };
    }
    if (err instanceof ReauthRequiredError) {
      return { ok: false, httpStatus: 401, body: { error: 'reauth_required' } };
    }
    console.error('[approvals] batch assertion verification failed:', err);
    return { ok: false, httpStatus: 401, body: { error: 'assertion_failed' } };
  }

  // Sequential on purpose: each row opens its own decide transaction that takes
  // a `FOR UPDATE` lock on the linked intent, and running them concurrently
  // would multiply this one request's hold on the pool for no latency win worth
  // the deadlock surface (#1105 / the lock-order fix in the decide core).
  const results: BatchRowResult[] = [];
  for (const row of loaded.rows) {
    // Per-row ERROR BOUNDARY. The decide core only try/catches its own decide
    // transaction — its pre-fetch, linked-intent load,
    // `isAgentIntentDecideAuthorized`, `resolveIntentApprovers` and
    // `resolveTargetDevices` can all throw straight out of it. Bare, one such
    // throw on row N would propagate out of this function and discard the
    // response for every row that ALREADY COMMITTED its decision, leaving the
    // caller unable to tell what landed. Catching here reports that row with
    // the same `decide_failed` shape the core returns for its own transaction
    // failures and keeps going — the rows are independent, first-wins
    // transactions, so one failing does not invalidate the others.
    let outcome: DecideApprovalResult;
    try {
      outcome = await decideApprovalRequest({
        auth,
        id: row.approval.id,
        status: input.decision,
        reason: input.reason,
        // The proof is NOT re-presented per row — its challenge was consumed by
        // the batch ceremony above, and the decision it produced is what every
        // row records.
        preverifiedAssurance: assurance,
      });
    } catch (err) {
      console.error(`[approvals] batch decide failed for approval ${row.approval.id}:`, err);
      outcome = { httpStatus: 500, body: { error: 'decide_failed', retryable: true } };
    }
    results.push({ id: row.approval.id, httpStatus: outcome.httpStatus, body: outcome.body });
  }

  return { ok: true, results };
}
