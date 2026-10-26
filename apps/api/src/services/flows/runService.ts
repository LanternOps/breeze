/**
 * Tool catalog W04 (#5219), plan Task A9 — creating, starting, cancelling and
 * reading flow runs.
 *
 *  - `createFlowRun` is the ONE insert path for every trigger (manual,
 *    schedule, event). `triggered_via` and `pre_approvals_honored` are
 *    DERIVED here from the trigger kind (Decision 4); no caller can pass them,
 *    and `flow_runs_pre_approvals_chk` / `flow_runs_via_matches_kind_chk`
 *    repeat the rule in SQL. It runs in a fresh SYSTEM transaction with
 *    explicit owner predicates (the trigger paths are background work; the
 *    manual path has authorized the caller first), snapshots the flow's LIVE
 *    publication, asks admission (the W05 seam), inserts under
 *    `flow_runs_dedupe_uq` and enqueues the first slice after commit.
 *  - `startManualRun` authorizes the person starting the run (the review
 *    round: running a flow uses its delegation, so the triggerer must pass
 *    rule 7 themself) and decides whether pre-approvals are honoured.
 *  - `cancelFlowRun` and the reads run in the CALLER's DB context: RLS
 *    (`breeze_has_org_access` on flow_runs / flow_run_steps) is the reach.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import {
  coerceFlowInputs,
  flowDocumentV1Schema,
  type FlowDocumentV1,
  type FlowManualRunRequest,
  type FlowRunDetailDto,
  type FlowRunStatus,
  type FlowRunStepDetailDto,
  type FlowRunStepSummaryDto,
  type FlowRunSummaryDto,
  type FlowValue,
} from '@breeze/shared';
import { db, runAfterDbContextCommit, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { sqlTimestamptz } from '../../db/sqlValues';
import { organizations } from '../../db/schema/orgs';
import { flows } from '../../db/schema/flows';
import { flowRuns, flowRunSteps, flowVersions, type FlowRunRow, type FlowRunStepRow } from '../../db/schema/flowRuns';
import { enqueueFlowRunSlice } from '../../jobs/flowRunQueue';
import { isAutomationPrincipal, isInteractiveUserSession, type AuthContext } from '../../middleware/auth';
import { requestLikeFromSnapshot, writeAuditEvent } from '../auditEvents';
import { flowStepPinSchema, type FlowStepPin } from '../flowValidator';
import { canAccessOrg, type UserPermissions } from '../permissions';
import { captureException } from '../sentry';
import { hasExactDeviceCeiling, hasSiteCeiling } from '../siteCeilingAccess';
import type { ToolOwnerRef } from '../toolSources/resolver';
import { MAX_FLOW_CHAIN_DEPTH } from './flowExecutionContext';
import { chargeFlowRun, lockFlowRunAdmission, recordAdmissionRefusal } from './budgets';
import { assertFlowRunAdmission, type FlowRunAdmissionRefusal } from './runAdmission';
import { TERMINAL_FLOW_RUN_STATUSES } from './runStore';
import type { FlowTriggerScope } from './triggerScope';
import { clampToCallerCredential, triggererPermissions, triggererPermsCleared } from './triggererAccess';
import { cancelOpenFlowRunIntents, missingPermissionsFor } from './versions';

// ── types ───────────────────────────────────────────────────────────────────

interface CreateFlowRunBase {
  flowId: string;
  orgId: string;
  scope: Omit<FlowTriggerScope, 'kind' | 'orgId'>;
  inputs: Record<string, FlowValue>;
  dedupeKey: string;
}

/** `triggered_via` and `pre_approvals_honored` are DERIVED in createFlowRun, never passed. */
export type CreateFlowRunInput = CreateFlowRunBase & (
  | { triggerKind: 'schedule' }
  | { triggerKind: 'event'; chainDepth: number; causedByRunId: string | null }
  | {
      triggerKind: 'manual';
      triggeredVia: 'ui' | 'api' | 'ai_tool';
      triggeredByUserId: string;
      aiSessionId: string | null;
      /** startManualRun's verdict: no site ceiling (and all-orgs access for a partner-wide flow). */
      triggererCleared: boolean;
      /**
       * The publication rule 7 and the inputs were checked against. The insert
       * refuses `not_enabled` when the LIVE publication is no longer this one
       * (re-enabled in between), so a run never executes an unchecked one.
       */
      expectedPublicationSeq: number;
    }
  | {
      /**
       * W5 (#5220, Decisions 2/4/5). Never honours pre-approvals. The run is bound
       * to what the ingress VERIFIED: the live publication seq and the secret
       * generation (`webhook_secret_rotated_at`) are compared under the flow row
       * lock, so a re-publish or a rotation between verification and insert
       * refuses the delivery (`not_enabled`) instead of running it on other
       * configuration.
       */
      triggerKind: 'webhook';
      expectedPublicationSeq: number;
      expectedSecretRotatedAt: Date;
      /**
       * Runs inside the run's system transaction, after the insert and the
       * charge (the accepted delivery row). A throw rolls back the run, the
       * charge and anything the hook wrote, and is rethrown to the caller.
       */
      onCreated: (runId: string) => Promise<void>;
    }
  | {
      /**
       * W5 PR C (#5220, Decisions 8–10): a flow started as a TOOL — chat
       * (`ai_tool`), Breeze's MCP server (`mcp`) or an AI agent (`ai_agent`).
       * Never honours pre-approvals (`flow_runs_pre_approvals_chk`). The caller
       * (`startToolRun`) authorized the triggerer against the publication it
       * resolved; the insert pins that publication, so a re-enable in between
       * is `not_enabled`, never a run on an unchecked publication.
       * `parentAgentRunId` exactly when via `ai_agent`
       * (`flow_runs_agent_parent_chk`); `triggeredByApiKeyId` only via `mcp`
       * (`flow_runs_api_key_chk`).
       */
      triggerKind: 'tool';
      triggeredVia: 'ai_tool' | 'mcp' | 'ai_agent';
      triggeredByUserId: string | null;
      triggeredByApiKeyId: string | null;
      parentAgentRunId: string | null;
      aiSessionId: string | null;
      expectedPublicationSeq: number;
    });

/** `preApprovalsHonored` (additive to the plan's shape) is the stored value of the run named. */
export type CreateFlowRunResult =
  | { created: true; runId: string; preApprovalsHonored: boolean }
  | { created: false; reason: 'duplicate'; runId: string; preApprovalsHonored: boolean }
  | { created: false; reason: 'not_enabled' | FlowRunAdmissionRefusal };

export type StartManualRunResult =
  | { ok: true; runId: string; duplicate: boolean; preApprovalsHonored: boolean }
  | { ok: false; error: 'inputs_invalid'; issues: Array<{ name: string; message: string }> }
  | { ok: false; error: 'permission_missing'; missing: Array<{ stepId: string; permission: string }> }
  | {
      ok: false;
      error: 'flow_not_found' | 'not_enabled' | 'not_manual' | 'org_required' | 'org_forbidden' | 'interactive_user_required'
        | 'delegation_scope_restricted' | FlowRunAdmissionRefusal;
    };

export type CancelFlowRunResult =
  | { ok: true; status: FlowRunStatus }
  | { ok: false; error: 'run_not_found' | 'already_terminal' };

export interface ListFlowRunsFilter {
  flowId?: string;
  orgId?: string;
  status?: FlowRunStatus;
  limit?: number;
  offset?: number;
}

/** What `get_flow_run` (A11) inlines per step: the output capped for the model. */
export const FLOW_RUN_TOOL_OUTPUT_CAP_BYTES = 4096;
export const FLOW_RUN_LIST_MAX_LIMIT = 100;
const FLOW_RUN_LIST_DEFAULT_LIMIT = 50;

const TERMINAL: ReadonlySet<string> = new Set(TERMINAL_FLOW_RUN_STATUSES);

function inSystemTx<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

/**
 * Sentry with the flow tag names the scrubber keeps (`org_id`, `flow_id`,
 * `flow_run_id`, `flow_site`) and a bounded fingerprint (a literal site,
 * never an id).
 */
function reportError(err: unknown, site: string, ids: { orgId?: string; flowId?: string; runId?: string }): void {
  const tags: Record<string, string> = { flow_site: site };
  if (ids.orgId) tags.org_id = ids.orgId;
  if (ids.flowId) tags.flow_id = ids.flowId;
  if (ids.runId) tags.flow_run_id = ids.runId;
  captureException(err instanceof Error ? err : new Error(String(err)), undefined, tags, { fingerprint: ['flow', site] });
}

// ── createFlowRun ───────────────────────────────────────────────────────────

interface DerivedProvenance {
  triggeredVia: FlowRunRow['triggeredVia'];
  preApprovalsHonored: boolean;
  chainDepth: number;
  causedByRunId: string | null;
  triggeredByUserId: string | null;
  aiSessionId: string | null;
  parentAgentRunId: string | null;
  triggeredByApiKeyId: string | null;
}

const NO_TOOL_PROVENANCE = { parentAgentRunId: null, triggeredByApiKeyId: null } as const;

/** Decision 4, the one place it is decided. Reads only the discriminated fields. */
function deriveProvenance(i: CreateFlowRunInput): DerivedProvenance {
  switch (i.triggerKind) {
    case 'schedule':
      return {
        triggeredVia: 'scheduler', preApprovalsHonored: true, chainDepth: 0, causedByRunId: null, triggeredByUserId: null, aiSessionId: null,
        ...NO_TOOL_PROVENANCE,
      };
    case 'event':
      return {
        triggeredVia: 'event', preApprovalsHonored: true, chainDepth: i.chainDepth, causedByRunId: i.causedByRunId,
        triggeredByUserId: null, aiSessionId: null, ...NO_TOOL_PROVENANCE,
      };
    case 'webhook':
      // Decision 4: the sender controls the payload, so a webhook run never
      // honours a pre-approval (flow_runs_pre_approvals_chk repeats it).
      return {
        triggeredVia: 'webhook', preApprovalsHonored: false, chainDepth: 0, causedByRunId: null, triggeredByUserId: null, aiSessionId: null,
        ...NO_TOOL_PROVENANCE,
      };
    case 'manual': {
      const via = i.triggeredVia;
      if (via !== 'ui' && via !== 'api' && via !== 'ai_tool') throw new Error(`createFlowRun: invalid manual triggeredVia '${String(via)}'`);
      return {
        triggeredVia: via,
        preApprovalsHonored: via === 'ui' && i.triggererCleared === true,
        chainDepth: 0,
        causedByRunId: null,
        triggeredByUserId: i.triggeredByUserId,
        aiSessionId: i.aiSessionId,
        ...NO_TOOL_PROVENANCE,
      };
    }
    case 'tool': {
      // W5 PR C (Decisions 8–10): never honours pre-approvals; the CHECKs
      // (flow_runs_via_matches_kind_chk, _agent_parent_chk, _api_key_chk) are
      // repeated here so a malformed call is a thrown caller bug, never a 23514.
      const via = i.triggeredVia;
      if (via !== 'ai_tool' && via !== 'mcp' && via !== 'ai_agent') throw new Error(`createFlowRun: invalid tool triggeredVia '${String(via)}'`);
      if ((via === 'ai_agent') !== (typeof i.parentAgentRunId === 'string' && i.parentAgentRunId.length > 0)) {
        throw new Error('createFlowRun: a tool run has parentAgentRunId exactly when it is via ai_agent');
      }
      if (i.triggeredByApiKeyId && via !== 'mcp') throw new Error('createFlowRun: only an MCP tool run records an api key');
      return {
        triggeredVia: via,
        preApprovalsHonored: false,
        chainDepth: 0,
        causedByRunId: null,
        triggeredByUserId: i.triggeredByUserId ?? null,
        aiSessionId: i.aiSessionId ?? null,
        parentAgentRunId: i.parentAgentRunId ?? null,
        triggeredByApiKeyId: i.triggeredByApiKeyId ?? null,
      };
    }
    default:
      throw new Error(`createFlowRun: unknown trigger kind '${String((i as { triggerKind?: unknown }).triggerKind)}'`);
  }
}

/** flow_runs_chain_chk in code: a malformed ancestry is a caller bug, never a row. */
function assertChain(p: DerivedProvenance): void {
  if (!Number.isInteger(p.chainDepth) || p.chainDepth < 0 || p.chainDepth > MAX_FLOW_CHAIN_DEPTH) {
    throw new Error(`createFlowRun: chain depth must be an integer 0..${MAX_FLOW_CHAIN_DEPTH}`);
  }
  if (p.chainDepth > 0 && !p.causedByRunId) throw new Error('createFlowRun: a chain depth above 0 needs causedByRunId');
}

/** Thrown inside the run transaction to roll it back (a monthly-cap breach found by the charge). */
class FlowRunRefused extends Error {
  constructor(readonly reason: FlowRunAdmissionRefusal) {
    super(`flow run refused: ${reason}`);
    this.name = 'FlowRunRefused';
  }
}

/**
 * Create one run (spec §6.4/§6.5, plan W04 Task A9, W05 Task A4). One system
 * transaction:
 *  1. the run org's partner (organizations) — the owner predicate's anchor;
 *  2. the flow, ENABLED, owned by the run org or partner-wide under its
 *     partner, `FOR SHARE` so a concurrent disable (which cancels queued runs
 *     in its own transaction) or a secret rotation waits for this insert
 *     instead of missing it; a manual or webhook run then checks the
 *     publication (and, webhook, the secret generation) it was verified
 *     against;
 *  3. the owner's admission lock (W05: serializes count → insert → charge per
 *     flow owner, so the monthly counters are exact);
 *  4. its LIVE publication (the snapshot every slice runs, and the document
 *     whose `limits` lower the flow cap);
 *  5. the dedupe probe — a redelivered trigger returns the first run even
 *     when admission would now refuse, and never charges;
 *  6. admission (`assertFlowRunAdmission`, joins this transaction): the
 *     active cap, then the monthly caps;
 *  7. `INSERT … ON CONFLICT ON CONSTRAINT flow_runs_dedupe_uq DO NOTHING`, and
 *     on a lost race the winner's id (no charge);
 *  8. the charge (`chargeFlowRun`); a breach throws and rolls the whole
 *     transaction back — run row and counters together;
 *  9. a webhook's `onCreated` (the accepted delivery row), same transaction.
 * After a refusal: the flow's banner marker (`recordAdmissionRefusal`, never
 * a pause). After commit: the first slice is enqueued (a failure is logged —
 * the reconciler re-enqueues queued runs after 2 minutes) and a manual run is
 * audited `flow.run.create`. Throws on DB failure (event/schedule retry).
 */
export async function createFlowRun(i: CreateFlowRunInput): Promise<CreateFlowRunResult> {
  const p = deriveProvenance(i);
  assertChain(p);
  const pinsPublication = i.triggerKind === 'manual' || i.triggerKind === 'webhook' || i.triggerKind === 'tool';
  const expectedSeq = pinsPublication ? i.expectedPublicationSeq : null;
  if (pinsPublication && !Number.isInteger(expectedSeq)) {
    throw new Error(`createFlowRun: a ${i.triggerKind} run needs the publication seq it was checked against`);
  }
  if (i.triggerKind === 'webhook') {
    if (!(i.expectedSecretRotatedAt instanceof Date) || Number.isNaN(i.expectedSecretRotatedAt.getTime())) {
      throw new Error('createFlowRun: a webhook run needs the secret generation it was verified with');
    }
    if (typeof i.onCreated !== 'function') throw new Error('createFlowRun: a webhook run needs its onCreated hook');
  }
  const triggerPayload = { ...i.scope, kind: i.triggerKind, orgId: i.orgId };

  let result: CreateFlowRunResult & { flowName?: string };
  try {
    result = await inSystemTx(async (): Promise<CreateFlowRunResult & { flowName?: string }> => {
      const [org] = await db
        .select({ partnerId: organizations.partnerId })
        .from(organizations)
        .where(eq(organizations.id, i.orgId))
        .limit(1);
      if (!org?.partnerId) return { created: false, reason: 'not_enabled' };

      const [flow] = await db
        .select({
          id: flows.id,
          orgId: flows.orgId,
          partnerId: flows.partnerId,
          name: flows.name,
          enabledPublicationSeq: flows.enabledPublicationSeq,
          webhookSecretRotatedAt: flows.webhookSecretRotatedAt,
        })
        .from(flows)
        .where(and(
          eq(flows.id, i.flowId),
          eq(flows.status, 'enabled'),
          or(eq(flows.orgId, i.orgId), and(isNull(flows.orgId), eq(flows.partnerId, org.partnerId))),
        ))
        .for('share')
        .limit(1);
      if (!flow || flow.enabledPublicationSeq === null) return { created: false, reason: 'not_enabled' };
      // A manual start checked rule 7 and the inputs against one publication;
      // a re-enable since then (a different live seq) is not that publication.
      if (expectedSeq !== null && flow.enabledPublicationSeq !== expectedSeq) return { created: false, reason: 'not_enabled' };
      // A webhook delivery was verified with one secret generation; a rotation
      // since (or a removed secret) is not that secret.
      if (i.triggerKind === 'webhook' && flow.webhookSecretRotatedAt?.getTime() !== i.expectedSecretRotatedAt.getTime()) {
        return { created: false, reason: 'not_enabled' };
      }

      const owner: ToolOwnerRef = flow.orgId ? { orgId: flow.orgId, partnerId: org.partnerId } : { orgId: null, partnerId: org.partnerId };
      // Serialize count → insert → charge for this owner (exact monthly counters).
      await lockFlowRunAdmission(owner);

      const [publication] = await db
        .select({ id: flowVersions.id, definitionVersion: flowVersions.definitionVersion, definition: flowVersions.definition })
        .from(flowVersions)
        .where(and(eq(flowVersions.flowId, flow.id), eq(flowVersions.publicationSeq, flow.enabledPublicationSeq)))
        .limit(1);
      if (!publication) return { created: false, reason: 'not_enabled' };
      // Validated at enable; one that no longer parses is refused, never run on guessed limits.
      const doc = flowDocumentV1Schema.safeParse(publication.definition);
      if (!doc.success) return { created: false, reason: 'not_enabled' };

      const existing = await findDedupedRun(flow.id, i.orgId, i.dedupeKey);
      if (existing) return { created: false, reason: 'duplicate', runId: existing.id, preApprovalsHonored: existing.preApprovalsHonored };

      const at = new Date();
      const admission = await assertFlowRunAdmission(owner, flow.id, { doc: doc.data, at });
      if (!admission.ok) return { created: false, reason: admission.error };

      const inserted = await db.execute(sql`
        INSERT INTO flow_runs (
          org_id, flow_id, flow_version_id, definition_version, trigger_kind, triggered_via,
          trigger_payload, inputs, status, pre_approvals_honored, dedupe_key, chain_depth,
          caused_by_run_id, triggered_by_user_id, ai_session_id, parent_agent_run_id, triggered_by_api_key_id
        ) VALUES (
          ${i.orgId}, ${flow.id}, ${publication.id}, ${publication.definitionVersion}, ${i.triggerKind}, ${p.triggeredVia},
          ${JSON.stringify(triggerPayload)}::jsonb, ${JSON.stringify(i.inputs)}::jsonb, 'queued', ${p.preApprovalsHonored},
          ${i.dedupeKey}, ${p.chainDepth}, ${p.causedByRunId}, ${p.triggeredByUserId}, ${p.aiSessionId},
          ${p.parentAgentRunId}, ${p.triggeredByApiKeyId}
        )
        ON CONFLICT ON CONSTRAINT flow_runs_dedupe_uq DO NOTHING
        RETURNING id`);
      const row = (inserted as unknown as Array<{ id: string }>)[0];
      if (!row) {
        const winner = await findDedupedRun(flow.id, i.orgId, i.dedupeKey);
        if (!winner) throw new Error('createFlowRun: dedupe conflict without a visible run');
        return { created: false, reason: 'duplicate', runId: winner.id, preApprovalsHonored: winner.preApprovalsHonored };
      }

      // Charged only once the run row exists (a duplicate never charges); a
      // breach rolls back the run row and both increments.
      const charge = await chargeFlowRun({ flowId: flow.id, owner, flowCap: admission.caps.flowCap, ownerCap: admission.caps.ownerCap, at });
      if (!charge.ok) throw new FlowRunRefused(charge.error);
      if (i.triggerKind === 'webhook') await i.onCreated(row.id);
      return { created: true, runId: row.id, preApprovalsHonored: p.preApprovalsHonored, flowName: flow.name };
    }, 'flows.runService.createFlowRun');
  } catch (err) {
    if (!(err instanceof FlowRunRefused)) throw err;
    result = { created: false, reason: err.reason };
  }

  if (!result.created) {
    if (result.reason !== 'duplicate' && result.reason !== 'not_enabled') await recordAdmissionRefusal(i.flowId, result.reason);
    return result;
  }
  const { flowName, ...created } = result;

  // The run row is already committed by the system transaction above, but a
  // manual start is called from a request handler whose ambient
  // withDbAccessContext transaction is still open: enqueueing here would hold
  // that pooled connection across a Redis round trip (#1105). Defer to after the
  // caller's context settles (immediate when there is none: schedule tick,
  // event worker). A lost enqueue is recovered by reconciler clause (a).
  runAfterDbContextCommit(`flow-run-first-slice:${created.runId}`, async () => {
    try {
      await enqueueFlowRunSlice(created.runId);
    } catch (err) {
      console.error(`[flows] first slice enqueue failed (run=${created.runId}); the reconciler will retry`, err);
      reportError(err, 'run_service.first_slice_enqueue', { orgId: i.orgId, flowId: i.flowId, runId: created.runId });
    }
  });

  if (i.triggerKind === 'manual' || i.triggerKind === 'tool') {
    try {
      writeAuditEvent(requestLikeFromSnapshot({}), {
        orgId: i.orgId,
        actorId: i.triggeredByUserId,
        initiatedBy: i.triggerKind === 'tool' || i.triggeredVia === 'ai_tool' ? 'ai' : 'manual',
        action: 'flow.run.create',
        resourceType: 'flow_run',
        resourceId: created.runId,
        resourceName: flowName ?? null,
        result: 'success',
        details: {
          flowId: i.flowId,
          triggeredVia: i.triggeredVia,
          preApprovalsHonored: created.preApprovalsHonored,
          ...(i.aiSessionId ? { aiSessionId: i.aiSessionId } : {}),
          ...(i.triggerKind === 'tool'
            ? {
                triggerKind: 'tool',
                ...(i.parentAgentRunId ? { parentAgentRunId: i.parentAgentRunId } : {}),
                ...(i.triggeredByApiKeyId ? { apiKeyId: i.triggeredByApiKeyId } : {}),
              }
            : {}),
        },
      });
    } catch (err) {
      console.error('[flows] run audit write failed', err);
      reportError(err, 'run_service.run_audit', { orgId: i.orgId, flowId: i.flowId, runId: created.runId });
    }
  }
  return created;
}

async function findDedupedRun(flowId: string, orgId: string, dedupeKey: string): Promise<{ id: string; preApprovalsHonored: boolean } | null> {
  const [row] = await db
    .select({ id: flowRuns.id, preApprovalsHonored: flowRuns.preApprovalsHonored })
    .from(flowRuns)
    .where(and(eq(flowRuns.flowId, flowId), eq(flowRuns.orgId, orgId), eq(flowRuns.dedupeKey, dedupeKey)))
    .limit(1);
  return row ?? null;
}

// ── startManualRun ──────────────────────────────────────────────────────────

export type AuthorizeRunTriggererResult =
  | { ok: true; perms: UserPermissions; usable: UserPermissions }
  | { ok: false; error: 'org_forbidden' | 'delegation_scope_restricted' }
  | { ok: false; error: 'permission_missing'; missing: Array<{ stepId: string; permission: string }> };

/**
 * Rule 7 for the PERSON behind a run start (W04 Task A9; W5 PR C reuses it for
 * tool-started runs and for the approver of a Tier-3 flow-tool intent): the
 * triggerer's own permissions in the run org must exist and reach it; a site
 * ceiling on the membership or the token (`[]` included) is refused — the flow
 * principal is org-wide and there is no site model (orchestrator decision, a
 * deviation from W04 Decision 4; the per-publication site ceiling, W5
 * Decision 17, can reopen it). An API key carries its creator's ceiling. The
 * permissions are clamped to the credential (an API key's scopes; an
 * unclampable credential holds nothing) and must cover every step of the
 * publication (`missingPermissionsFor`). The caller has already checked that
 * `auth` reaches `orgId` and that the run org sits under the flow's partner.
 */
export async function authorizeRunTriggerer(
  auth: AuthContext,
  orgId: string,
  orgPartnerId: string,
  doc: FlowDocumentV1,
  pins: FlowStepPin[],
): Promise<AuthorizeRunTriggererResult> {
  if (!auth.user?.id) return { ok: false, error: 'org_forbidden' };
  const perms = await triggererPermissions(auth.user.id, orgPartnerId, orgId);
  if (!perms || !canAccessOrg(perms, orgId)) return { ok: false, error: 'org_forbidden' };
  if (perms.allowedSiteIds !== undefined || hasSiteCeiling(auth)) return { ok: false, error: 'delegation_scope_restricted' };
  const usable = (await clampToCallerCredential(auth, perms, orgId)) ?? { ...perms, permissions: [] };
  const missing = missingPermissionsFor(doc, pins, usable);
  if (missing.length > 0) return { ok: false, error: 'permission_missing', missing };
  return { ok: true, perms, usable };
}

export function parsePins(raw: unknown): FlowStepPin[] | null {
  if (!Array.isArray(raw)) return null;
  const pins: FlowStepPin[] = [];
  for (const entry of raw) {
    const parsed = flowStepPinSchema.safeParse(entry);
    if (!parsed.success) return null;
    pins.push(parsed.data);
  }
  return pins;
}

/**
 * Start a manual run for the caller (plan Task A9; routes A10, `run_flow` A11).
 *
 * Authorization, in order, every refusal before any write:
 *  1. a person: automation principals never start runs; the `ui` and
 *     `ai_tool` lanes need an interactive user session. API keys and MCP act
 *     as the key's creator (`auth.user.id`, buildAuthFromApiKey), like every
 *     other user-RBAC gate.
 *  2. the flow is visible in the CALLER's context and enabled; its LIVE
 *     publication is a manual flow;
 *  3. the run org: an org flow's own org; a partner-wide flow needs
 *     `orgId`, reachable by the caller and under the flow's partner;
 *  4. the triggerer's own permissions in the run org exist, reach it, and —
 *     clamped to the credential (an API key's scopes; an unclampable
 *     credential holds nothing, `clampToCallerCredential`) — pass rule 7
 *     for every step of the live publication;
 *  5. inputs coerce against the publication's declarations;
 *  6. the insert pins THAT publication (`expectedPublicationSeq`): a flow
 *     re-enabled in between is `not_enabled`, never a run on a publication
 *     nobody checked.
 * A site-limited triggerer (a site ceiling on the membership in the run org
 * or on the token, `[]` included; for an API key, its creator's) is refused
 * `delegation_scope_restricted` before any write: the flow principal is
 * org-wide and W04 has no site model (orchestrator decision, a deviation from
 * Decision 4's "may still run"; W05's per-publication site ceiling can reopen
 * it). `preApprovalsHonored` = `ui` AND, for a partner-wide flow, all-orgs
 * partner access on the membership and the token; a selected-access partner
 * user still runs in an org it reaches, with every Tier-3 step parked.
 */
export async function startManualRun(
  auth: AuthContext,
  flowId: string,
  req: FlowManualRunRequest,
  via: 'ui' | 'api' | 'ai_tool',
  aiSessionId: string | null = null,
): Promise<StartManualRunResult> {
  if (isAutomationPrincipal(auth) || !auth.user?.id) return { ok: false, error: 'interactive_user_required' };
  // The `ui` lane and the `ai_tool` lane (run_flow, a chat session that passed
  // the Tier-3 card) are interactive sessions only. The tool handler enforces
  // this too; the service is the last line, whatever the caller.
  if (via !== 'api' && !isInteractiveUserSession(auth)) return { ok: false, error: 'interactive_user_required' };

  const [flow] = await db
    .select({ id: flows.id, orgId: flows.orgId, partnerId: flows.partnerId, status: flows.status, enabledPublicationSeq: flows.enabledPublicationSeq })
    .from(flows)
    .where(eq(flows.id, flowId))
    .limit(1);
  if (!flow) return { ok: false, error: 'flow_not_found' };
  if (flow.status !== 'enabled' || flow.enabledPublicationSeq === null) return { ok: false, error: 'not_enabled' };
  const seq = flow.enabledPublicationSeq;

  const [publication] = await inSystemTx(
    async () => db
      .select({ definition: flowVersions.definition, stepPins: flowVersions.stepPins })
      .from(flowVersions)
      .where(and(eq(flowVersions.flowId, flow.id), eq(flowVersions.publicationSeq, seq)))
      .limit(1),
    'flows.runService.livePublication',
  );
  const parsedDoc = publication ? flowDocumentV1Schema.safeParse(publication.definition) : null;
  const pins = publication ? parsePins(publication.stepPins) : null;
  if (!parsedDoc?.success || !pins) return { ok: false, error: 'not_enabled' };
  const doc = parsedDoc.data;
  if (doc.trigger.type !== 'manual') return { ok: false, error: 'not_manual' };

  let orgId: string;
  if (flow.orgId) {
    if (req.orgId && req.orgId !== flow.orgId) return { ok: false, error: 'org_forbidden' };
    orgId = flow.orgId;
  } else {
    if (!req.orgId) return { ok: false, error: 'org_required' };
    orgId = req.orgId;
  }
  if (!auth.canAccessOrg(orgId)) return { ok: false, error: 'org_forbidden' };
  const [org] = await inSystemTx(
    async () => db.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, orgId)).limit(1),
    'flows.runService.runOrgPartner',
  );
  const orgPartnerId = org?.partnerId ?? null;
  if (!orgPartnerId || (!flow.orgId && orgPartnerId !== flow.partnerId)) return { ok: false, error: 'org_forbidden' };

  const authorized = await authorizeRunTriggerer(auth, orgId, orgPartnerId, doc, pins);
  if (!authorized.ok) return authorized;
  const { perms } = authorized;

  const coerced = coerceFlowInputs(doc.inputs, req.inputs ?? {});
  if (!coerced.ok) return { ok: false, error: 'inputs_invalid', issues: coerced.issues };

  const partnerWide = !flow.orgId;
  const triggererCleared = triggererPermsCleared(perms, partnerWide) && (!partnerWide || auth.partnerOrgAccess === 'all');

  const created = await createFlowRun({
    triggerKind: 'manual',
    triggeredVia: via,
    triggeredByUserId: auth.user.id,
    aiSessionId: aiSessionId ?? null,
    triggererCleared,
    expectedPublicationSeq: seq,
    flowId: flow.id,
    orgId,
    scope: { firedAt: new Date().toISOString() },
    inputs: coerced.inputs,
    dedupeKey: `manual:${req.idempotencyKey ?? randomUUID()}`,
  });
  if (created.created) return { ok: true, runId: created.runId, duplicate: false, preApprovalsHonored: created.preApprovalsHonored };
  if (created.reason === 'duplicate') {
    return { ok: true, runId: created.runId, duplicate: true, preApprovalsHonored: created.preApprovalsHonored };
  }
  return { ok: false, error: created.reason };
}

// ── cancelFlowRun ───────────────────────────────────────────────────────────

/**
 * Cancel a run, in the caller's transaction (RLS = reach). `cancel_requested_at`
 * is set FIRST on every path; then:
 *  - queued / waiting ⇒ `cancelled` now (a slice that already holds a lease
 *    finds the run terminal at its next fenced write);
 *  - awaiting_approval ⇒ its open intent is cancelled exactly as disableFlow
 *    does (`cancelOpenFlowRunIntents` + the terminal outbox wake); the wake
 *    reads `cancel_requested_at` and ends the run `cancelled`, never `drift`;
 *  - running ⇒ the flag only; the slice stops at its next checkpoint.
 * The returned status is the run's status after this call.
 */
export async function cancelFlowRun(auth: AuthContext, runId: string): Promise<CancelFlowRunResult> {
  const reach = auth.orgCondition?.(flowRuns.orgId);
  const [run] = await db
    .select({ id: flowRuns.id, orgId: flowRuns.orgId, flowId: flowRuns.flowId, status: flowRuns.status })
    .from(flowRuns)
    .where(reach ? and(eq(flowRuns.id, runId), reach) : eq(flowRuns.id, runId))
    .for('update')
    .limit(1);
  if (!run) return { ok: false, error: 'run_not_found' };
  if (TERMINAL.has(run.status)) return { ok: false, error: 'already_terminal' };

  const now = new Date();
  const [flagged] = await db
    .update(flowRuns)
    .set({ cancelRequestedAt: sql`COALESCE(${flowRuns.cancelRequestedAt}, ${sqlTimestamptz(now)})`, updatedAt: now })
    .where(and(eq(flowRuns.id, run.id), notInArray(flowRuns.status, [...TERMINAL_FLOW_RUN_STATUSES])))
    .returning({ id: flowRuns.id, status: flowRuns.status });
  if (!flagged) return { ok: false, error: 'already_terminal' };

  let status: FlowRunStatus = flagged.status;
  let cancelledIntents = 0;
  if (status === 'queued' || status === 'waiting') {
    const [ended] = await db
      .update(flowRuns)
      .set({
        status: 'cancelled',
        errorCode: 'cancelled',
        error: 'The run was cancelled.',
        finishedAt: now,
        wakeAt: null,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(and(eq(flowRuns.id, run.id), inArray(flowRuns.status, ['queued', 'waiting'])))
      .returning({ id: flowRuns.id });
    if (ended) status = 'cancelled';
  } else if (status === 'awaiting_approval') {
    cancelledIntents = await cancelOpenFlowRunIntents([run.id]);
  }

  try {
    writeAuditEvent(requestLikeFromSnapshot({}), {
      orgId: run.orgId,
      actorId: auth.user?.id ?? null,
      actorEmail: auth.user?.email ?? null,
      action: 'flow.run.cancel',
      resourceType: 'flow_run',
      resourceId: run.id,
      result: 'success',
      details: { flowId: run.flowId, previousStatus: flagged.status, status, cancelledIntents },
    });
  } catch (err) {
    console.error('[flows] cancel audit write failed', err);
    reportError(err, 'run_service.cancel_audit', { orgId: run.orgId, flowId: run.flowId, runId: run.id });
  }
  return { ok: true, status };
}

// ── reads ──────────────────────────────────────────────────────────────────

/**
 * Whether the caller may see run BODIES (trigger payload, inputs, rendered
 * step inputs and outputs). Runs carry no site column and W04 has no site
 * model, so a body cannot be checked against a site or device ceiling: a
 * site-limited caller (`hasSiteCeiling`, `[]` included) or a device-bound
 * agent (`allowedDeviceIds` set) sees the ledger's shape only — summaries,
 * statuses and errors — never a body. The shared DTO has no "restricted"
 * flag, so the redaction reuses the retention-pruning semantics: run
 * `triggerPayload` / `inputs` are null, each step reports `bodiesPruned:
 * true` and carries no `output`, and the step-body read is not found.
 * Site-limited users cannot START a run either (startManualRun).
 */
function runBodiesRestricted(auth: AuthContext): boolean {
  return hasSiteCeiling(auth) || hasExactDeviceCeiling(auth);
}

const iso = (d: Date | string | null | undefined): string | null => (d == null ? null : new Date(d).toISOString());

const SUMMARY_COLUMNS = {
  id: flowRuns.id,
  orgId: flowRuns.orgId,
  flowId: flowRuns.flowId,
  flowVersionId: flowRuns.flowVersionId,
  definitionVersion: flowRuns.definitionVersion,
  triggerKind: flowRuns.triggerKind,
  triggeredVia: flowRuns.triggeredVia,
  status: flowRuns.status,
  errorCode: flowRuns.errorCode,
  currentStepId: flowRuns.currentStepId,
  createdAt: flowRuns.createdAt,
  startedAt: flowRuns.startedAt,
  finishedAt: flowRuns.finishedAt,
};
type SummaryRow = Pick<FlowRunRow, keyof typeof SUMMARY_COLUMNS>;

function toRunSummaryDto(row: SummaryRow, flowName: string): FlowRunSummaryDto {
  return {
    id: row.id,
    flowId: row.flowId,
    flowName,
    orgId: row.orgId,
    definitionVersion: row.definitionVersion,
    triggerKind: row.triggerKind,
    triggeredVia: row.triggeredVia,
    status: row.status,
    errorCode: row.errorCode ?? null,
    currentStepId: row.currentStepId ?? null,
    createdAt: iso(row.createdAt)!,
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
  };
}

const STEP_SUMMARY_COLUMNS = {
  id: flowRunSteps.id,
  stepId: flowRunSteps.stepId,
  itemIndex: flowRunSteps.itemIndex,
  attempt: flowRunSteps.attempt,
  tool: flowRunSteps.tool,
  toolSource: flowRunSteps.toolSource,
  tier: flowRunSteps.tier,
  status: flowRunSteps.status,
  approvalMode: flowRunSteps.approvalMode,
  outputTruncated: flowRunSteps.outputTruncated,
  errorCode: flowRunSteps.errorCode,
  error: flowRunSteps.error,
  actionIntentId: flowRunSteps.actionIntentId,
  approvedByUserId: flowRunSteps.approvedByUserId,
  startedAt: flowRunSteps.startedAt,
  finishedAt: flowRunSteps.finishedAt,
  durationMs: flowRunSteps.durationMs,
  aiInputTokens: flowRunSteps.aiInputTokens,
  aiOutputTokens: flowRunSteps.aiOutputTokens,
  aiCostCents: flowRunSteps.aiCostCents,
};
type StepSummaryRow = Pick<FlowRunStepRow, keyof typeof STEP_SUMMARY_COLUMNS>;

function toStepSummaryDto(row: StepSummaryRow, bodiesPruned: boolean): FlowRunStepSummaryDto {
  const base = {
    id: row.id,
    stepId: row.stepId,
    itemIndex: row.itemIndex ?? null,
    attempt: row.attempt,
    tool: row.tool,
    toolSource: row.toolSource,
    tier: row.tier,
    status: row.status,
    outputTruncated: row.outputTruncated,
    bodiesPruned,
    errorCode: row.errorCode ?? null,
    error: row.error ?? null,
    startedAt: iso(row.startedAt)!,
    finishedAt: iso(row.finishedAt),
    durationMs: row.durationMs ?? null,
    // flow_run_steps_ai_usage_chk: all three set (an `ai` step) or all three NULL.
    aiUsage: row.aiInputTokens != null && row.aiOutputTokens != null && row.aiCostCents != null
      ? { inputTokens: row.aiInputTokens, outputTokens: row.aiOutputTokens, costCents: row.aiCostCents }
      : null,
  };
  // flow_run_steps_intent_pair_chk: approval_mode 'intent' ⇔ action_intent_id.
  if (row.approvalMode === 'intent' && row.actionIntentId) {
    return { ...base, approvalMode: 'intent', actionIntentId: row.actionIntentId, approvedByUserId: row.approvedByUserId ?? null };
  }
  return { ...base, approvalMode: row.approvalMode === 'pre_approved' ? 'pre_approved' : 'none', actionIntentId: null, approvedByUserId: null };
}

/** The model-facing cap for `get_flow_run`: small outputs inline, larger ones `{ truncated: true, preview }`. */
export function capFlowRunToolOutput(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const serialized = JSON.stringify(value) ?? 'null';
  const bytes = Buffer.from(serialized, 'utf8');
  if (bytes.length <= FLOW_RUN_TOOL_OUTPUT_CAP_BYTES) return value;
  const preview = bytes.subarray(0, FLOW_RUN_TOOL_OUTPUT_CAP_BYTES - 64).toString('utf8').replace(/�+$/, '');
  return { truncated: true, preview };
}

/**
 * Publication metadata for runs the caller can already see. Read in SYSTEM
 * context keyed by the run's own (flow_version_id, flow_id): an API key's org
 * context cannot read a partner-wide publication through RLS, but a run it
 * can see always names one.
 */
async function loadPublications(refs: Array<{ flowVersionId: string; flowId: string }>, withDefinition: boolean) {
  const ids = [...new Set(refs.map((r) => r.flowVersionId))];
  if (ids.length === 0) return new Map<string, { name: string; publicationSeq: number | null; definition: unknown }>();
  const rows = await inSystemTx(
    async () => db
      .select({
        id: flowVersions.id,
        name: sql<string | null>`${flowVersions.definition}->>'name'`,
        publicationSeq: flowVersions.publicationSeq,
        ...(withDefinition ? { definition: flowVersions.definition } : {}),
      })
      .from(flowVersions)
      .where(inArray(flowVersions.id, ids)),
    'flows.runService.publications',
  );
  return new Map(rows.map((r) => {
    const def = (r as { definition?: unknown }).definition;
    const defName = def && typeof def === 'object' ? (def as { name?: unknown }).name : undefined;
    const name = typeof r.name === 'string' ? r.name : typeof defName === 'string' ? defName : '';
    return [r.id, { name, publicationSeq: r.publicationSeq ?? null, definition: def ?? null }];
  }));
}

export async function listFlowRuns(auth: AuthContext, f: ListFlowRunsFilter): Promise<{ runs: FlowRunSummaryDto[]; total: number }> {
  const limit = Math.min(Math.max(1, Math.trunc(f.limit ?? FLOW_RUN_LIST_DEFAULT_LIMIT)), FLOW_RUN_LIST_MAX_LIMIT);
  const offset = Math.max(0, Math.trunc(f.offset ?? 0));
  const conditions: SQL[] = [];
  const reach = auth.orgCondition?.(flowRuns.orgId);
  if (reach) conditions.push(reach);
  if (f.flowId) conditions.push(eq(flowRuns.flowId, f.flowId));
  if (f.orgId) conditions.push(eq(flowRuns.orgId, f.orgId));
  if (f.status) conditions.push(eq(flowRuns.status, f.status));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select(SUMMARY_COLUMNS)
    .from(flowRuns)
    .where(where)
    .orderBy(desc(flowRuns.createdAt), desc(flowRuns.id))
    .limit(limit)
    .offset(offset);
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(flowRuns).where(where);
  const pubs = await loadPublications(rows, false);
  return {
    runs: rows.map((r) => toRunSummaryDto(r, pubs.get(r.flowVersionId)?.name ?? '')),
    total: Number(count?.n ?? 0),
  };
}

/**
 * One run with its step ledger. `stepBodies: 'none'` (the polled route)
 * omits rendered inputs and outputs; `'capped'` (the `get_flow_run` tool)
 * inlines each step's output through `capFlowRunToolOutput`. A caller who may
 * not see bodies (`runBodiesRestricted`) gets the shape without any.
 */
export async function getFlowRun(
  auth: AuthContext,
  runId: string,
  opts: { stepBodies: 'none' | 'capped' } = { stepBodies: 'none' },
): Promise<FlowRunDetailDto | null> {
  const reach = auth.orgCondition?.(flowRuns.orgId);
  const [run] = await db
    .select({
      ...SUMMARY_COLUMNS,
      triggerPayload: flowRuns.triggerPayload,
      inputs: flowRuns.inputs,
      error: flowRuns.error,
      preApprovalsHonored: flowRuns.preApprovalsHonored,
      chainDepth: flowRuns.chainDepth,
      wakeAt: flowRuns.wakeAt,
      bodiesPrunedAt: flowRuns.bodiesPrunedAt,
      aiTokensUsed: flowRuns.aiTokensUsed,
      parentAgentRunId: flowRuns.parentAgentRunId,
    })
    .from(flowRuns)
    .where(reach ? and(eq(flowRuns.id, runId), reach) : eq(flowRuns.id, runId))
    .limit(1);
  if (!run) return null;

  const pub = (await loadPublications([run], true)).get(run.flowVersionId);
  const restricted = runBodiesRestricted(auth);
  const capped = opts.stepBodies === 'capped' && !restricted;
  const steps = await db
    .select(capped ? { ...STEP_SUMMARY_COLUMNS, output: flowRunSteps.output } : STEP_SUMMARY_COLUMNS)
    .from(flowRunSteps)
    .where(and(eq(flowRunSteps.runId, run.id), eq(flowRunSteps.orgId, run.orgId)))
    .orderBy(asc(flowRunSteps.startedAt), asc(flowRunSteps.stepId), asc(flowRunSteps.itemIndex), asc(flowRunSteps.attempt));
  const pruned = restricted || run.bodiesPrunedAt != null;

  return {
    ...toRunSummaryDto(run, pub?.name ?? ''),
    triggerPayload: restricted ? null : run.triggerPayload ?? null,
    inputs: restricted ? null : run.inputs ?? null,
    error: run.error ?? null,
    preApprovalsHonored: run.preApprovalsHonored,
    chainDepth: run.chainDepth,
    publicationSeq: pub?.publicationSeq ?? 0,
    wakeAt: iso(run.wakeAt),
    bodiesPrunedAt: iso(run.bodiesPrunedAt),
    aiTokensUsed: run.aiTokensUsed,
    parentAgentRunId: run.parentAgentRunId ?? null,
    definition: (pub?.definition ?? null) as FlowDocumentV1,
    steps: steps.map((s) => {
      const summary = toStepSummaryDto(s, pruned);
      return capped ? { ...summary, output: capFlowRunToolOutput((s as { output?: unknown }).output) } : summary;
    }),
  };
}

/**
 * One step row with its bodies (redacted at write time; null after retention).
 * Not found for a caller who may not see bodies (`runBodiesRestricted`).
 */
export async function getFlowRunStep(auth: AuthContext, runId: string, stepRowId: string): Promise<FlowRunStepDetailDto | null> {
  if (runBodiesRestricted(auth)) return null;
  const reach = auth.orgCondition?.(flowRuns.orgId);
  const [run] = await db
    .select({ bodiesPrunedAt: flowRuns.bodiesPrunedAt })
    .from(flowRuns)
    .where(reach ? and(eq(flowRuns.id, runId), reach) : eq(flowRuns.id, runId))
    .limit(1);
  if (!run) return null;
  const [step] = await db
    .select({ ...STEP_SUMMARY_COLUMNS, renderedInput: flowRunSteps.renderedInput, output: flowRunSteps.output })
    .from(flowRunSteps)
    .where(and(eq(flowRunSteps.id, stepRowId), eq(flowRunSteps.runId, runId)))
    .limit(1);
  if (!step) return null;
  return {
    ...toStepSummaryDto(step, run.bodiesPrunedAt != null),
    renderedInput: step.renderedInput ?? null,
    output: step.output ?? null,
  };
}
