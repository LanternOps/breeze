/**
 * W5 PR C (#5220), Task C2 — releasing an APPROVED Tier-3 flow-tool intent
 * (plan Decision 8, quorum Q4: an immutable invocation binding revalidated at
 * release and atomically at insert).
 *
 * Called only by the durable release worker (`jobs/intentReleaseWorker.ts`):
 * flow-tool intents never take the inline chat release
 * (`actionIntents/durableRelease.ts`), so the approver — not the live chat
 * session — is always the authority that starts the run.
 *
 *  1. the binding parses: `invoked_flow_id`, `tool_revision 'flowpub:<id>'`
 *     and the coerced call `{ inputs, orgId, idempotencyKey }`;
 *  2. the flow tool is re-resolved LIVE for the approver in the intent org: a
 *     missing / disabled / invisible flow, another flow on the slug, or a
 *     publication other than the approved one is `flow_tool_changed` — the
 *     intent fails and nothing is created;
 *  3. `startToolRun` with the approver as the triggerer (rule 7 for every
 *     step, `automations.write`, no site or device ceiling), the intent org
 *     as the run org, and the approved publication's seq pinned on the insert;
 *     the intent id is the idempotency key, so a redelivered release returns
 *     the same run.
 * The run is an ordinary `tool` run: its own Tier-3 steps park again
 * (pre-approvals are never honoured for tool runs).
 */
import type { ActionIntent } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { resolveFlowToolForCall } from './flowTools';
import { startToolRun } from './toolRuns';

const FLOWPUB_RE = /^flowpub:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export type FlowToolReleaseResult =
  | { ok: true; result: { runId: string; runPath: string; duplicate: boolean } }
  | { ok: false; code: string; details?: Record<string, unknown> };

/** The approved call, or null when the stored binding is not one this module wrote. */
function boundCall(intent: ActionIntent): { publicationId: string; inputs: Record<string, unknown> } | null {
  const m = typeof intent.toolRevision === 'string' ? FLOWPUB_RE.exec(intent.toolRevision) : null;
  if (!m || !intent.invokedFlowId) return null;
  const args = intent.arguments as Record<string, unknown> | null;
  const inputs = args?.inputs;
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return null;
  return { publicationId: m[1]!, inputs: inputs as Record<string, unknown> };
}

export async function releaseFlowToolIntent(intent: ActionIntent, approver: AuthContext): Promise<FlowToolReleaseResult> {
  const bound = boundCall(intent);
  if (!bound) return { ok: false, code: 'flow_tool_changed' };

  const d = await resolveFlowToolForCall(approver, intent.actionName, intent.orgId);
  if (!d || d.flowId !== intent.invokedFlowId || d.publicationId !== bound.publicationId) {
    return { ok: false, code: 'flow_tool_changed' };
  }
  if (d.owner.orgId && d.owner.orgId !== intent.orgId) return { ok: false, code: 'org_forbidden' };

  const started = await startToolRun(
    d,
    // The coerced inputs as the call; the run org travels as the default org
    // (never an argument, whose presence depends on the approver's scope).
    { ...bound.inputs, idempotencyKey: intent.id },
    'ai_tool',
    { kind: 'user', auth: approver },
    { defaultOrgId: intent.orgId },
  );
  if (started.ok) return { ok: true, result: { runId: started.runId, runPath: started.runPath, duplicate: started.duplicate } };
  if (started.error === 'permission_missing') return { ok: false, code: started.error, details: { missing: started.missing } };
  if (started.error === 'inputs_invalid') return { ok: false, code: started.error, details: { issues: started.issues } };
  return { ok: false, code: started.error };
}
