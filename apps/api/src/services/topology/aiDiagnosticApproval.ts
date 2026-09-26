/**
 * Topology M4 Task 4 (#6000) — binding ONE AI-proposed diagnostic to the
 * existing action-intent approval effect (amendments M4-D1, M4-D3).
 *
 * Two host-owned boundaries, both around the ordinary action-intent chain:
 *
 *   PROPOSAL (`prepareTopologyDiagnosticProposal`, called by
 *   `createActionIntent` — the one choke point every intent path funnels
 *   through). Only an interactive human's topology chat session may propose:
 *   the session's server-owned pin must name the tool's site (the M4-D1 gate),
 *   the requester must hold execute on that site, and `flags.ai`, the org AI
 *   policy and diagnostics must be on. The server then MATERIALIZES the
 *   proposal — the origin the planner would pick (auto-selected or confirmed),
 *   its context and family, and an immutable expiry — into the intent's
 *   (immutable) arguments, and writes the origin into the approval text. What
 *   the approver reads is exactly what the effect digest pins.
 *
 *   RELEASE (`runApprovedTopologyDiagnostic`, the tool handler). Runs only as
 *   the release of an approved intent (both release paths set
 *   `actionIntentId` + the verified effect, and nothing else can). It
 *   re-authorizes LIVE — execute access, flags + AI policy, partner trust —
 *   and proves the approval from the recorded decision rather than from any
 *   session claim: the approver is the requester, the decision was a FRESH
 *   hardware-backed factor for this approval (a durable release's rebuilt
 *   auth synthesizes `mfa: true`, which is never used), the proposal has not
 *   expired and the proposing session is still pinned to this site. Inside ONE
 *   start transaction it then locks the intent, re-derives the effect from
 *   current state (scoped load → pure extraction), compares it to the pinned
 *   digest and persists the same M1 run + outbox rows. Replays reuse the run
 *   (`topology-intent:<intentId>`); nothing re-selects an origin.
 */
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { canonicalizeArguments } from '@breeze/shared/canonicalize';

import { db, runOutsideDbContext, withDbAccessContext } from '../../db';
import { actionIntents, aiSessions, approvalRequests, devices } from '../../db/schema';
import { dbAccessContextFromAuth, type AuthContext } from '../../middleware/auth';
import { isFreshApproverFactor } from '../actionIntents/freshApproverFactor';
import { deviceExecuteAllowedForOrg } from '../partnerTrust.commands';
import { getUserPermissions } from '../permissions';
import { diagnoseConnectivityInputSchema } from '../aiToolSchemasTopology';
import type { ToolExecutionContext } from '../toolExecutionContext';
import { requireTopologySiteAccess, TopologyError, type TopologyRequestContext } from './access';
import {
  DIAGNOSE_CONNECTIVITY_TOOL,
  TOPOLOGY_AI_PROPOSAL_TTL_MS,
  extractTopologyDiagnosticEffect,
  topologyDiagnosticProposalSchema,
  topologyDiagnosticRequestFromProposal,
  type TopologyDiagnosticProposal,
  type VerifiedTopologyDiagnostic,
} from './aiDiagnosticEffect';
import { authorizeTopologyAiToolCall, loadTopologyAiReadiness, topologyAiAvailable } from './aiToolGate';
import { createVerifiedTopologyDiagnosticRun } from './diagnosticRuns';
import { loadTopologyFlags } from './flags';
import { loadTopologyDiagnosticPlanningSnapshotForScope } from './originEligibility';
import { TopologyOperationError } from './operationErrors';

export { DIAGNOSE_CONNECTIVITY_TOOL, TOPOLOGY_AI_PROPOSAL_TTL_MS };

export { diagnoseConnectivityInputSchema };

export class TopologyDiagnosticProposalError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'TopologyDiagnosticProposalError';
  }
}

const RECIPE_LABELS: Record<string, string> = {
  gateway_basic: 'gateway reachability',
  dns_basic: 'DNS resolution',
  internet_basic: 'internet reachability',
  target_connectivity: 'target connectivity',
  trace_route: 'routed trace',
};

/** Fixed refusals: none echoes input, none reveals which hidden check failed. */
const PROPOSAL_REFUSALS: Record<string, string> = {
  topology_session_required: 'A diagnostic can only be proposed from a site-pinned topology investigation',
  topology_site_mismatch: 'This topology investigation is pinned to a different site',
  topology_site_unavailable: 'Topology site not found or access denied',
  topology_ai_disabled: 'Topology AI is disabled for this organization',
  topology_permission_denied: 'Running topology diagnostics at this site is not permitted',
  diagnostics_disabled: 'Topology diagnostics are disabled for this organization',
  graph_revision_changed: 'The topology changed; re-read it before proposing a diagnostic',
  diagnostic_not_plannable: 'This diagnostic cannot be planned for the selection right now',
  invalid_input: 'Invalid diagnostic proposal',
};

function refuseProposal(code: string): never {
  throw new TopologyDiagnosticProposalError(code, PROPOSAL_REFUSALS[code] ?? PROPOSAL_REFUSALS.diagnostic_not_plannable!);
}

/** Maximum tolerated skew between the API host clock and the database clock (see the release check). */
const DECISION_CLOCK_SKEW_TOLERANCE_MS = 60_000;

const scopedAs = <T>(auth: AuthContext, fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withDbAccessContext(dbAccessContextFromAuth(auth), fn));

function isoMinute(value: string): string {
  return `${value.slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * Proposal boundary (see the header). Returns the materialized arguments the
 * intent stores, the site's org, and the approval text naming the origin.
 */
export async function prepareTopologyDiagnosticProposal(
  auth: AuthContext,
  rawInput: Record<string, unknown>,
  now: Date = new Date(),
): Promise<{ orgId: string; arguments: TopologyDiagnosticProposal; label: string }> {
  const parsed = diagnoseConnectivityInputSchema.safeParse(rawInput);
  if (!parsed.success) refuseProposal('invalid_input');
  const input = parsed.data;
  // Only an interactive human's own topology chat session proposes. Agent
  // runs, API keys, MCP and scripts are refused before any read.
  const sessionId = auth.aiOrigin?.kind === 'ai_assistant' ? auth.aiOrigin.sessionId : undefined;
  if (auth.principal?.kind !== 'user_session' || !sessionId) refuseProposal('topology_session_required');

  return scopedAs(auth, async () => {
    const gate = await authorizeTopologyAiToolCall({ site_id: input.site_id }, auth, { kind: 'ai_session', sessionId });
    if (!gate.ok) refuseProposal(gate.code);
    let ctx: TopologyRequestContext;
    try {
      ctx = await requireTopologySiteAccess(auth, gate.ctx.permissions, gate.pinnedSiteId, 'execute');
    } catch (error) {
      if (error instanceof TopologyError) refuseProposal('topology_permission_denied');
      throw error;
    }
    const flags = await loadTopologyFlags(ctx);
    if (!flags.materialization || !flags.diagnostics) refuseProposal('diagnostics_disabled');

    const request = {
      recipeId: input.recipe_id, recipeVersion: 1 as const, subject: input.subject, graphRevision: input.graph_revision,
      ...(input.origin_device_id ? { originDeviceId: input.origin_device_id } : {}),
      ...(input.context_key ? { contextKey: input.context_key } : {}),
      ...(input.family ? { family: input.family } : {}),
    };
    let snapshot;
    try {
      snapshot = await loadTopologyDiagnosticPlanningSnapshotForScope(ctx.scope, request, { now: now.getTime() });
    } catch (error) {
      if (error instanceof TopologyOperationError) refuseProposal('diagnostic_not_plannable');
      throw error;
    }
    if (snapshot.graphRevision !== input.graph_revision) refuseProposal('graph_revision_changed');

    // Resolve the origin the planner would use NOW (auto-selected, or the
    // model's confirmed choice), then pin it: the release compiles with this
    // exact origin/context/family and never re-selects.
    const first = snapshot.candidates.find((candidate) => candidate.eligibility.eligible
      && (!request.originDeviceId || candidate.eligibility.origin.deviceId === request.originDeviceId)
      && (!request.contextKey || candidate.eligibility.origin.contextKey === request.contextKey)
      && (!request.family || candidate.eligibility.families.includes(request.family)));
    if (!first) refuseProposal('diagnostic_not_plannable');
    const proposal: TopologyDiagnosticProposal = {
      site_id: ctx.scope.siteId,
      subject: input.subject,
      recipe_id: input.recipe_id,
      recipe_version: 1,
      graph_revision: input.graph_revision,
      origin_device_id: first.eligibility.origin.deviceId,
      context_key: first.eligibility.origin.contextKey,
      family: request.family ?? first.eligibility.families[0]!,
      proposal_expires_at: new Date(now.getTime() + TOPOLOGY_AI_PROPOSAL_TTL_MS).toISOString(),
    };
    let plan;
    try {
      ({ plan } = extractTopologyDiagnosticEffect(ctx.scope, proposal, snapshot, { now, newId: () => crypto.randomUUID() }));
    } catch (error) {
      if (error instanceof TopologyOperationError) refuseProposal('diagnostic_not_plannable');
      throw error;
    }

    const [origin] = await db
      .select({ hostname: devices.hostname })
      .from(devices)
      .where(and(eq(devices.id, proposal.origin_device_id), eq(devices.orgId, ctx.scope.orgId)))
      .limit(1);
    const destinations = plan.destinations.map((destination) => {
      const target = destination.target;
      if (target.kind === 'configured_target') return target.definition.label;
      return target.kind === 'observed_gateway' ? `gateway ${target.address}` : `resolver ${target.address}`;
    });
    const label = [
      `Run ${RECIPE_LABELS[proposal.recipe_id] ?? proposal.recipe_id} check from ${origin?.hostname ?? 'the selected device'}`,
      `(context ${proposal.context_key}, ${proposal.family})`,
      destinations.length ? `to ${destinations.join(', ')}` : '',
      `— ${plan.steps.length} bounded steps, ${plan.limits.lifetimeSeconds}s max; approval expires ${isoMinute(proposal.proposal_expires_at)}`,
    ].filter(Boolean).join(' ');
    return { orgId: ctx.scope.orgId, arguments: proposal, label };
  });
}

const HANDLER_REFUSALS: Record<string, string> = {
  approval_required: 'This diagnostic runs only as the release of an approved proposal',
  topology_site_mismatch: 'The approved diagnostic belongs to a different site',
  topology_site_unavailable: 'Topology site not found or access denied',
  topology_permission_denied: 'Running topology diagnostics at this site is not permitted',
  topology_ai_disabled: 'Topology AI is disabled for this organization',
  diagnostics_disabled: 'Topology diagnostics are disabled for this organization',
  human_approval_required: 'This diagnostic requires a human approval',
  acceptance_invalid: 'The approval for this diagnostic could not be verified',
  acceptance_replayed: 'This approval has already been used',
  fresh_mfa_required: 'This diagnostic needs an approval confirmed with a fresh second factor',
  proposal_expired: 'The approved diagnostic proposal has expired',
  content_changed: 'The site changed after approval; the diagnostic was not started',
  trust_denied: 'Partner trust policy does not allow diagnostics on this organization',
};

function handlerError(code: string, fallback?: string): string {
  return JSON.stringify({ error: HANDLER_REFUSALS[code] ?? fallback ?? HANDLER_REFUSALS.acceptance_invalid, code });
}

type IntentRow = typeof actionIntents.$inferSelect;

/** The recorded approval, proven from the intent and its winning approval row. */
async function assertAcceptance(
  ctx: TopologyRequestContext,
  verified: VerifiedTopologyDiagnostic,
  actionIntentId: string,
  now: Date,
): Promise<IntentRow> {
  const [intent] = await db.select().from(actionIntents).where(eq(actionIntents.id, actionIntentId)).limit(1);
  const refuse = (code: string, status: 403 | 409 = 403) => { throw new TopologyOperationError(code, status, HANDLER_REFUSALS[code]); };
  if (!intent || intent.actionName !== DIAGNOSE_CONNECTIVITY_TOOL || intent.orgId !== ctx.scope.orgId) return refuse('acceptance_invalid');
  if (intent.status !== 'executing') return refuse('acceptance_replayed', 409);
  // Atomic binding of intent / actor / digest: the executing release is THIS
  // requester's own supervised intent, decided by that same human, and pinned
  // to exactly the effect the release path just verified.
  if (
    intent.approvalScope !== 'supervised'
    || intent.requestedByUserId !== ctx.auth.user.id
    || intent.decidedByUserId !== ctx.auth.user.id
    || typeof intent.effectDigest !== 'string'
    || intent.effectDigest !== verified.effectDigest
    || canonicalizeArguments(intent.arguments) !== canonicalizeArguments(verified.proposal)
  ) {
    return refuse('acceptance_invalid');
  }
  // Fresh second factor, recorded on the decision itself — never a session claim.
  const [approval] = await db
    .select({ userId: approvalRequests.userId, decidedViaStepUpGrant: approvalRequests.decidedViaStepUpGrant })
    .from(approvalRequests)
    .where(and(eq(approvalRequests.intentId, intent.id), eq(approvalRequests.status, 'approved')))
    .limit(1);
  // `created_at` is stamped by Postgres and `decided_at` by the API host, so the
  // ordering check tolerates bounded clock skew between the two; a decision
  // recorded well before the proposal existed is still refused.
  if (
    !approval || approval.userId !== ctx.auth.user.id || !intent.decidedAt
    || intent.decidedAt.getTime() < intent.createdAt.getTime() - DECISION_CLOCK_SKEW_TOLERANCE_MS
    || !isFreshApproverFactor({ decidedVia: intent.decidedVia, decidedAssuranceLevel: intent.decidedAssuranceLevel, stepUpGrantReuse: approval.decidedViaStepUpGrant })
  ) {
    return refuse('fresh_mfa_required');
  }
  const expiresAt = Date.parse(verified.proposal.proposal_expires_at);
  if (!Number.isFinite(expiresAt) || now.getTime() > expiresAt || intent.decidedAt.getTime() > expiresAt) return refuse('proposal_expired', 409);
  // The proposing session is the server-owned site pin (M4-D1); it must still
  // exist, belong to the requester and name this site.
  if (!intent.aiOriginSessionId) return refuse('acceptance_invalid');
  const [session] = await db
    .select({ userId: aiSessions.userId, orgId: aiSessions.orgId, type: aiSessions.type, siteId: aiSessions.topologySiteId })
    .from(aiSessions)
    .where(eq(aiSessions.id, intent.aiOriginSessionId))
    .limit(1);
  if (!session || session.type !== 'topology' || session.siteId !== ctx.scope.siteId
    || session.userId !== ctx.auth.user.id || session.orgId !== ctx.scope.orgId) {
    return refuse('acceptance_invalid');
  }
  return intent;
}

/**
 * The `diagnose_connectivity` handler body (release only). Returns accepted /
 * queued run details; polling `get_diagnostic_run` is the read-only follow-up.
 */
export async function runApprovedTopologyDiagnostic(
  input: Record<string, unknown>,
  auth: AuthContext,
  context: ToolExecutionContext | undefined,
  now: () => Date = () => new Date(),
): Promise<string> {
  const actionIntentId = context?.actionIntentId;
  const verified = context?.verifiedTopologyDiagnostic;
  if (!actionIntentId || !verified) return handlerError('approval_required');
  if (typeof input.site_id !== 'string' || input.site_id.toLowerCase() !== verified.scope.siteId.toLowerCase()) {
    return handlerError('topology_site_mismatch');
  }
  const proposal = topologyDiagnosticProposalSchema.safeParse(verified.proposal);
  if (!proposal.success || proposal.data.site_id !== verified.scope.siteId) return handlerError('acceptance_invalid');

  try {
    const permissions = await getUserPermissions(auth.user.id, {
      partnerId: auth.partnerId ?? undefined,
      orgId: auth.orgId ?? undefined,
      scope: auth.scope,
    });
    if (!permissions) return handlerError('topology_site_unavailable');
    let ctx: TopologyRequestContext;
    try {
      ctx = await requireTopologySiteAccess(auth, permissions, verified.scope.siteId, 'execute');
    } catch (error) {
      if (error instanceof TopologyError) {
        return handlerError(error.code === 'topology_permission_denied' ? 'topology_permission_denied' : 'topology_site_unavailable');
      }
      throw error;
    }
    if (ctx.scope.orgId !== verified.scope.orgId) return handlerError('topology_site_unavailable');

    const request = topologyDiagnosticRequestFromProposal(proposal.data);
    const run = await createVerifiedTopologyDiagnosticRun(ctx, {
      request,
      authorize: async (current) => {
        if (current.auth.principal?.kind === 'ai_agent') throw new TopologyOperationError('human_approval_required', 403);
        const [flags, readiness] = await Promise.all([loadTopologyFlags(current), loadTopologyAiReadiness(current.scope.orgId)]);
        if (!topologyAiAvailable(flags, readiness)) throw new TopologyOperationError('topology_ai_disabled', 403);
        await assertAcceptance(current, verified, actionIntentId, now());
        if (!await deviceExecuteAllowedForOrg(current.scope.orgId, 'network_diagnostic', current.auth.user.id)) {
          throw new TopologyOperationError('trust_denied', 403);
        }
      },
      resolvePlan: async () => {
        // Final check/use, under the start transaction and the org lock: the
        // intent is locked so a concurrent release cannot also bind it, and
        // the effect is re-derived from CURRENT state and compared with the
        // digest the approver's decision pinned.
        const [locked] = await db.execute<{ status: string; effect_digest: string | null }>(sql`
          SELECT status, effect_digest FROM action_intents WHERE id = ${actionIntentId}::uuid FOR UPDATE`);
        if (!locked || locked.status !== 'executing') throw new TopologyOperationError('acceptance_replayed', 409, HANDLER_REFUSALS.acceptance_replayed);
        if (locked.effect_digest !== verified.effectDigest) throw new TopologyOperationError('acceptance_invalid', 403, HANDLER_REFUSALS.acceptance_invalid);
        const at = now();
        if (at.getTime() > Date.parse(proposal.data.proposal_expires_at)) throw new TopologyOperationError('proposal_expired', 409, HANDLER_REFUSALS.proposal_expired);
        try {
          const snapshot = await loadTopologyDiagnosticPlanningSnapshotForScope(ctx.scope, request, { now: at.getTime() });
          const { plan, material } = extractTopologyDiagnosticEffect(ctx.scope, proposal.data, snapshot, { now: at, newId: () => crypto.randomUUID() });
          if (createHash('sha256').update(material).digest('hex') !== verified.effectDigest) {
            throw new TopologyOperationError('content_changed', 409, HANDLER_REFUSALS.content_changed);
          }
          return plan;
        } catch (error) {
          if (error instanceof TopologyOperationError) throw new TopologyOperationError('content_changed', 409, HANDLER_REFUSALS.content_changed);
          throw error;
        }
      },
    }, `topology-intent:${actionIntentId}`);
    return JSON.stringify({ runId: run.id, state: run.state, siteId: verified.scope.siteId, recipeId: run.plan.recipeId, deadline: run.deadline });
  } catch (error) {
    if (error instanceof TopologyOperationError) return handlerError(error.code, 'The approved diagnostic could not be started');
    if (error instanceof TopologyError) return handlerError('topology_site_unavailable');
    throw error;
  }
}
