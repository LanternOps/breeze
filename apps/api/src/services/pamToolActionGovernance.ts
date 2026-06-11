/**
 * Phase 1 Helper privileged-action governance (security finding A).
 *
 * Models a governed (tier>=2) Helper tool invocation as a PAM elevation
 * request (flow_type='ai_tool_action') and decides it through the PAM rule
 * engine. pamBridge is deliberately skipped — it is executable-shaped and
 * has no binding for a tool action. The decision is mirrored onto
 * ai_tool_executions.status so the SDK gate's waitForApproval() unblocks
 * with no change to its polling contract:
 *   auto_approve            → elevation auto_approved → execution approved
 *   auto_deny               → elevation denied        → execution rejected
 *   require_approval / none → elevation pending; an admin decides via
 *     POST /pam/elevation-requests/:id/respond (separate identity,
 *     pam:execute + MFA), whose handler calls the mirror in-transaction.
 * FAIL SAFE: any error → 'pending' (never auto-approve on failure).
 */
import { createHash } from 'node:crypto';
import { and, eq, isNull, or } from 'drizzle-orm';
import { db, withDbAccessContext } from '../db';
import {
  aiToolExecutions,
  devices,
  elevationAudit,
  elevationRequests,
  pamRules,
} from '../db/schema';
import { evaluatePamToolActionRules } from './pamRuleEngine';
import { publishEvent } from './eventBus';

const AUTO_APPROVE_DEFAULT_DURATION_MINUTES = 15;

export type ToolActionDecision = 'auto_approved' | 'denied' | 'pending';

export interface ToolActionParams {
  orgId: string;
  deviceId: string;
  /** The pending ai_tool_executions row the SDK gate is polling. */
  executionId: string;
  /** Bare tool name (mcp__breeze__ prefix already stripped). */
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Guardrail tier (2–3 today). */
  riskTier: number;
  /** Helper identity — the device hostname. */
  subjectUsername: string;
}

type DbExecutor = Pick<typeof db, 'update'>;

/**
 * CAS the linked ai_tool_executions row out of 'pending'. Returns whether a
 * row actually flipped — false means the execution was already decided
 * (e.g. waitForApproval timed out and marked it rejected). Accepts a
 * transaction handle so /respond can mirror atomically with its own CAS.
 */
export async function mirrorElevationDecisionToExecution(
  executor: DbExecutor,
  executionId: string,
  approved: boolean,
  approvedByUserId: string | null,
): Promise<boolean> {
  const updated = await executor
    .update(aiToolExecutions)
    .set(
      approved
        ? { status: 'approved', approvedBy: approvedByUserId, approvedAt: new Date() }
        : { status: 'rejected' },
    )
    .where(and(eq(aiToolExecutions.id, executionId), eq(aiToolExecutions.status, 'pending')))
    .returning({ id: aiToolExecutions.id });
  return updated.length > 0;
}

/**
 * Create + decide the elevation request for a Helper tool action. Called
 * from the preToolUse helper branch (services/aiAgentSdk.ts), which runs
 * outside the request's ALS DB context — all DB work is wrapped here.
 */
export async function decideHelperToolAction(
  params: ToolActionParams,
): Promise<ToolActionDecision> {
  try {
    return await withDbAccessContext(
      { scope: 'organization', orgId: params.orgId, accessibleOrgIds: [params.orgId] },
      () => decideInContext(params),
    );
  } catch (err) {
    console.error('[PAM-ToolAction] decisioning failed — failing safe to pending:', err);
    return 'pending';
  }
}

async function decideInContext(params: ToolActionParams): Promise<ToolActionDecision> {
  const now = new Date();

  const [device] = await db
    .select({ siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.id, params.deviceId))
    .limit(1);
  const siteId = device?.siteId ?? null;

  // Org rules, site-narrowed like ingest: an org-wide rule (site_id null)
  // or a rule scoped to the device's own site.
  const rules = await db
    .select()
    .from(pamRules)
    .where(
      and(
        eq(pamRules.orgId, params.orgId),
        eq(pamRules.enabled, true),
        siteId ? or(isNull(pamRules.siteId), eq(pamRules.siteId, siteId)) : isNull(pamRules.siteId),
      ),
    );

  const match = evaluatePamToolActionRules(rules, {
    toolName: params.toolName,
    riskTier: params.riskTier,
    subjectUsername: params.subjectUsername,
    at: now,
  });

  // 'ignore' has no suppress semantics for a tool action (the action must be
  // decided one way or the other) — treat as no-match → pending.
  const verdict = match && match.verdict !== 'ignore' ? match.verdict : null;
  const decision: ToolActionDecision =
    verdict === 'auto_approve' ? 'auto_approved' : verdict === 'auto_deny' ? 'denied' : 'pending';

  const actionDigest = createHash('sha256')
    .update(JSON.stringify(params.toolInput ?? {}))
    .digest('hex');

  const durationMinutes = match?.approvalDurationMinutes ?? AUTO_APPROVE_DEFAULT_DURATION_MINUTES;
  const [row] = await db
    .insert(elevationRequests)
    .values({
      orgId: params.orgId,
      siteId,
      // partner_id stays null, matching the uac_intercept ingest.
      deviceId: params.deviceId,
      flowType: 'ai_tool_action',
      subjectUserId: null,
      subjectUsername: params.subjectUsername,
      reason: `Breeze Helper requested AI tool '${params.toolName}' (tier ${params.riskTier})`,
      status: decision,
      requestedAt: now,
      approvedAt: decision === 'auto_approved' ? now : null,
      expiresAt:
        decision === 'auto_approved'
          ? new Date(now.getTime() + durationMinutes * 60_000)
          : null,
      denialReason:
        decision === 'denied' ? `Denied by PAM rule '${match!.ruleName}'` : null,
      executionId: params.executionId,
      toolName: params.toolName,
      actionDigest,
      riskTier: params.riskTier,
      metadata: match ? { pam_rule_id: match.ruleId, pam_rule_name: match.ruleName } : {},
    })
    .returning({ id: elevationRequests.id });

  // Audit chain (best-effort — an audit hiccup must not flip a safe decision
  // into a throw, mirroring ingest's posture).
  try {
    await db.insert(elevationAudit).values({
      orgId: params.orgId,
      elevationRequestId: row!.id,
      eventType: 'requested',
      actor: 'system',
      actorUserId: null,
      details: {
        tool_name: params.toolName,
        risk_tier: params.riskTier,
        execution_id: params.executionId,
      },
      occurredAt: now,
    });
    if (decision !== 'pending') {
      await db.insert(elevationAudit).values({
        orgId: params.orgId,
        elevationRequestId: row!.id,
        eventType: decision === 'auto_approved' ? 'auto_approved' : 'denied',
        actor: 'policy',
        actorUserId: null,
        details: { pam_rule_id: match!.ruleId, pam_rule_name: match!.ruleName },
        occurredAt: now,
      });
    }
  } catch (err) {
    console.error('[PAM-ToolAction] audit insert failed (non-fatal):', err);
  }

  // Mirror auto verdicts onto the execution row the SDK gate is polling.
  if (decision !== 'pending') {
    await mirrorElevationDecisionToExecution(db, params.executionId, decision === 'auto_approved', null);
  }

  // Events (best-effort).
  try {
    const eventType =
      decision === 'auto_approved'
        ? ('elevation.auto_approved' as const)
        : decision === 'denied'
          ? ('elevation.denied' as const)
          : ('elevation.requested' as const);
    await publishEvent(
      eventType,
      params.orgId,
      {
        elevationRequestId: row!.id,
        deviceId: params.deviceId,
        flowType: 'ai_tool_action',
        status: decision,
        toolName: params.toolName,
        executionId: params.executionId,
        ...(match ? { pamRuleId: match.ruleId } : {}),
      },
      'pam-tool-action',
    );
  } catch (err) {
    console.error('[PAM-ToolAction] event publish failed (non-fatal):', err);
  }

  return decision;
}
