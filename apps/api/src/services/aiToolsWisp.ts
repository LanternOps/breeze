/**
 * Wisp W07 — the two specialist tool names (plan Tasks 4 and 6; Wisp design
 * §7.5). Neither launches anything itself: both hand a request to the
 * deterministic coordinator (`services/wisp/coordinator.ts`), which runs every
 * gate. No model-callable tool launches a run directly — `launch_analysis` is
 * a coordinator code path, and `workspace_launch_analysis` stays denied.
 *
 *   launch_specialist        Tier 2 chat tool, inside a Wisp session only
 *                            (`auth.wispGrant`, stamped by W04). The auto-admit
 *                            kinds (sweep, analysis) run on the call; every
 *                            asks-first kind escalates to a supervised Tier-3
 *                            approval in chat (`TIER3_ACTIONS`, keyed on
 *                            `kind`), so the person sees the exact request —
 *                            the ticket list and message for a bulk reply —
 *                            before it runs. Agent principals are denied
 *                            (AGENT_HUMAN_ONLY_TOOLS).
 *   wisp_specialist_request  the approval card an assessment raises for an
 *                            asks-first kind. Human-only (never declared);
 *                            runs ONLY as the release of its own approved
 *                            intent, under the APPROVER's rebuilt authority.
 */
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { launchSpecialistInputSchema, launchSpecialistShape, wispSpecialistRequestSchema } from './aiToolSchemas';
import type { ToolExecutionContext } from './toolExecutionContext';
import type { RequestSpecialistResult } from './wisp/coordinator';
import { WISP_SPECIALIST_REQUEST_TOOL } from './wisp/specialistPolicy';

import { loadReleasableCarrierIntent } from './wisp/specialistCarrier';
import { z } from 'zod';

// Lazy: the coordinator's closure (launchers → admission → intents) imports
// the tool registry, which imports this module; a static edge is a cycle.
async function requestSpecialist(...args: Parameters<typeof import('./wisp/coordinator').requestSpecialist>) {
  const { requestSpecialist: run } = await import('./wisp/coordinator');
  return run(...args);
}

const GRANT_REQUIRED = JSON.stringify({ error: 'wisp_grant_required' });

function render(result: RequestSpecialistResult): string {
  if ('refused' in result) {
    return JSON.stringify(result.detail ? { error: result.refused, detail: result.detail } : { error: result.refused });
  }
  return JSON.stringify(result);
}

// ---------------------------------------------------------------------------
// wisp_specialist_request — the approval carrier's release
// ---------------------------------------------------------------------------

export async function wispSpecialistRequestHandler(
  input: Record<string, unknown>,
  _auth: AuthContext,
  context?: ToolExecutionContext,
): Promise<string> {
  const intentId = context?.actionIntentId;
  if (!intentId) {
    return JSON.stringify({ error: `${WISP_SPECIALIST_REQUEST_TOOL} runs only as the release of its own approved intent` });
  }
  const parsed = wispSpecialistRequestSchema.safeParse(input);
  if (!parsed.success) return JSON.stringify({ error: 'invalid_arguments' });
  const args = parsed.data;

  // The intent row is the authority, not the input: same tool, same request,
  // same org, decided by a human, and claimed for release.
  const intent = await loadReleasableCarrierIntent(intentId, { requestId: args.requestId, orgId: args.orgId });
  if (!intent) return JSON.stringify({ error: 'intent_mismatch' });

  // The APPROVER's authority, rebuilt and revalidated — never the grantor's.
  // Lazy: actorContext's closure reaches the tool registry (a static edge is a cycle).
  const { buildApproverAuthContextForIntent } = await import('./actionIntents/actorContext');
  const approverAuth = await buildApproverAuthContextForIntent(intent, intent.decidedByUserId);
  if (!approverAuth) return JSON.stringify({ error: 'approver_invalid' });

  const result = await requestSpecialist(
    {
      grantId: args.grantId,
      grantRevisionId: args.grantRevisionId,
      orgId: intent.orgId,
      kind: args.kind,
      params: args.params,
      // Lineage from the intent row (the run that minted it), not the input.
      requestedByRunId: intent.requestingAgentRunId ?? null,
    },
    {
      requester: { kind: 'approval', intentId, auth: approverAuth, pinnedDigest: args.pinnedDigest ?? null },
      requestId: args.requestId,
      reason: args.reason,
    },
  );
  return render(result);
}

// ---------------------------------------------------------------------------
// launch_specialist — the chat tool
// ---------------------------------------------------------------------------

export async function launchSpecialistHandler(
  input: { orgId: string; kind: string; params?: Record<string, unknown>; reason: string } | Record<string, unknown>,
  auth: AuthContext,
): Promise<string> {
  const grant = auth.wispGrant;
  if (!grant) return GRANT_REQUIRED;
  const parsed = launchSpecialistInputSchema.safeParse(input);
  if (!parsed.success) {
    return JSON.stringify({ error: 'invalid_input', detail: parsed.error.issues.map((i) => i.message).join('; ') });
  }
  const { orgId, kind, params, reason } = parsed.data;
  const result = await requestSpecialist(
    { grantId: grant.grantId, grantRevisionId: grant.grantRevisionId, orgId, kind, params: params ?? {}, requestedByRunId: null },
    // A person asking twice means twice (routes/patchPlan.ts posture).
    { requester: { kind: 'user', auth }, requestId: randomUUID(), reason },
  );
  return render(result);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function jsonSchema(shape: z.ZodRawShape): AiTool['definition']['input_schema'] {
  const { $schema: _dropped, ...schema } = z.toJSONSchema(z.object(shape), { io: 'input' }) as Record<string, unknown>;
  return schema as AiTool['definition']['input_schema'];
}

export function registerWispTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('launch_specialist', {
    tier: 2,
    domain: 'ai',
    deviceArgs: [],
    searchHint: 'hand work to a specialist agent: sweep, sandbox analysis, Operator task, patch plan, research, bulk ticket reply',
    definition: {
      name: 'launch_specialist',
      description: 'Hand bounded work to a specialist agent under your Wisp grant: a sweep, sandbox analysis, Operator task, patch plan, remediation research, or one reply to a set of tickets. Sweeps and analysis start at once; other kinds need approval first.',
      input_schema: jsonSchema(launchSpecialistShape),
    },
    handler: (input, auth) => launchSpecialistHandler(input, auth),
  });

  aiTools.set(WISP_SPECIALIST_REQUEST_TOOL, {
    tier: 3,
    domain: 'ai',
    deviceArgs: [],
    searchHint: 'Wisp approval card for a specialist request; raised only by the Wisp coordinator',
    definition: {
      name: WISP_SPECIALIST_REQUEST_TOOL,
      description: 'Approval carrier for a Wisp specialist request. Raised only by the Wisp coordinator under an assessment run; releasing it admits one specialist under the approver\'s authority.',
      input_schema: jsonSchema(wispSpecialistRequestSchema.shape),
    },
    handler: wispSpecialistRequestHandler,
  });
}
