/**
 * Tool Catalog W03 (#5215 / #5218) — flow authoring tools.
 *
 *  - draft_flow    (Tier 2, automations.write, agent human-only): validate a
 *                  flow document against the owner's catalog and save it as a
 *                  draft. Invalid documents are not saved.
 *  - validate_flow (Tier 1, automations.read): the same validation, no write.
 *  - get_flow      (Tier 1): one flow plus a live re-validation.
 *  - list_flows    (Tier 1): flows the caller can see.
 *
 * W04 (#5219, Task A11) adds run_flow (Tier 3, chat only), list_flow_runs,
 * get_flow_run (Tier 1) and cancel_flow_run (Tier 2).
 *
 * Nothing runs a flow in W03. Every handler refuses with `flows_disabled`
 * when FLOWS_ENABLED is off — the last line of defence behind the chat
 * factory and the MCP list/call gate (`aiToolEnvGates.ts`).
 *
 * The service/validator are imported lazily: they import the guardrails and
 * the agent catalog, which import `aiTools.ts`, which imports this file.
 *
 * Session provenance (`ai_session_id`) is never read from tool input; the chat
 * post-tool hook back-fills it from the authenticated session.
 */
import { flowsEnabled } from '../config/env';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import type { ToolExecutionContext } from './toolExecutionContext';
import { captureException } from './sentry';
import { FLOW_TOOL_NAMES } from './flows/toolNames';

export { FLOW_TOOL_NAMES };

const json = (v: unknown) => JSON.stringify(v);
const DISABLED = json({ error: 'flows_disabled' });

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const ownerScopeOf = (v: unknown): 'organization' | 'partner' | undefined =>
  v === 'organization' || v === 'partner' ? v : undefined;
const recordOf = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

// The wrapper forwards the trailing execution context (a two-parameter wrapper
// would silently drop it, see AiTool.handler): run_flow reads the chat session
// from it.
function guarded(name: string, fn: (input: Record<string, unknown>, auth: AuthContext, context?: ToolExecutionContext) => Promise<unknown>) {
  return async (input: Record<string, unknown>, auth: AuthContext, context?: ToolExecutionContext): Promise<string> => {
    if (!flowsEnabled()) return DISABLED;
    try {
      return json(await fn(input, auth, context));
    } catch (err) {
      console.error(`[${name}]`, err);
      captureException(err, undefined, { tool: name });
      return json({ error: 'Operation failed. Check server logs for details.' });
    }
  };
}

const DOCUMENT_PROP = {
  type: 'object',
  description: 'Flow document v1: version 1, name, optional description, trigger, inputs, and steps (id, tool, input, optional when/forEach).',
} as const;

export function registerFlowTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('draft_flow', {
    tier: 2,
    domain: 'scripts',
    searchHint: 'create or update an automation workflow draft from a description',
    deviceArgs: [],
    definition: {
      name: 'draft_flow',
      description: "Save a flow (a multi-step automation) as a draft. The document is validated against the caller's enabled tools; an invalid document is not saved and the issues are returned. Nothing runs: the tech reviews and enables the draft on the Flows page.",
      input_schema: {
        type: 'object' as const,
        properties: {
          document: DOCUMENT_PROP,
          flowId: { type: 'string', description: 'Existing draft to update (UUID). Omit to create a new draft.' },
          expectedVersion: { type: 'integer', description: 'Version the update is based on; a newer saved version is a conflict.' },
          ownerScope: { type: 'string', enum: ['organization', 'partner'], description: 'organization (default) or partner for an all-organizations flow.' },
          orgId: { type: 'string', description: 'Owning organization UUID for an organization flow.' },
          slug: { type: 'string', description: 'Optional stable name; derived from the document name when omitted.' },
        },
        required: ['document'],
      },
    },
    handler: guarded('draft_flow', async (input, auth) => {
      const { saveDraftFlow } = await import('./flows/service');
      const result = await saveDraftFlow(auth, {
        document: recordOf(input.document),
        flowId: str(input.flowId),
        expectedVersion: typeof input.expectedVersion === 'number' ? input.expectedVersion : undefined,
        ownerScope: ownerScopeOf(input.ownerScope),
        orgId: str(input.orgId),
        slug: str(input.slug),
      });
      return result.saved ? { ...result, reviewPath: `/flows/${result.flow.id}` } : result;
    }),
  });

  aiTools.set('validate_flow', {
    tier: 1,
    domain: 'scripts',
    searchHint: 'check an automation workflow document for problems',
    deviceArgs: [],
    definition: {
      name: 'validate_flow',
      description: "Check a flow document without saving it: structure, expressions, step tools available to the owner, step inputs, approval tiers and asset ownership. Returns the issues and the flow's effective approval tier.",
      input_schema: {
        type: 'object' as const,
        properties: {
          document: DOCUMENT_PROP,
          ownerScope: { type: 'string', enum: ['organization', 'partner'], description: 'Owner to validate against: organization (default) or partner.' },
          orgId: { type: 'string', description: 'Owning organization UUID for an organization flow.' },
        },
        required: ['document'],
      },
    },
    handler: guarded('validate_flow', async (input, auth) => {
      const { resolveFlowOwnerForCaller } = await import('./flows/owner');
      const resolved = await resolveFlowOwnerForCaller(auth, { ownerScope: ownerScopeOf(input.ownerScope), orgId: str(input.orgId) }, 'read');
      if ('error' in resolved) return { error: resolved.error };
      const { validateFlowDocument } = await import('./flowValidator');
      const { document: _document, ...validation } = await validateFlowDocument(recordOf(input.document), { owner: resolved.owner });
      return validation;
    }),
  });

  aiTools.set('get_flow', {
    tier: 1,
    domain: 'scripts',
    searchHint: 'show an automation workflow and its steps',
    deviceArgs: [],
    definition: {
      name: 'get_flow',
      description: 'Read one flow: its document, status and version, plus a fresh validation against the current catalog (a tool disabled since the draft was saved shows up as an issue).',
      input_schema: {
        type: 'object' as const,
        properties: { flowId: { type: 'string', description: 'Flow UUID' } },
        required: ['flowId'],
      },
    },
    handler: guarded('get_flow', async (input, auth) => {
      const { getFlow } = await import('./flows/service');
      const flowId = str(input.flowId);
      const found = flowId ? await getFlow(auth, flowId) : null;
      return found ?? { error: 'flow_not_found' };
    }),
  });

  aiTools.set('list_flows', {
    tier: 1,
    domain: 'scripts',
    searchHint: 'list automation workflows and drafts',
    deviceArgs: [],
    definition: {
      name: 'list_flows',
      description: "List flows the caller can see, newest first, including the partner's all-organizations flows.",
      input_schema: {
        type: 'object' as const,
        properties: {
          orgId: { type: 'string', description: 'Only this organization and its partner-wide flows (UUID).' },
          status: { type: 'string', enum: ['draft', 'enabled', 'paused', 'disabled'] },
          limit: { type: 'integer', description: 'Maximum flows to return (default 50, max 100)' },
        },
      },
    },
    handler: guarded('list_flows', async (input, auth) => {
      const { listFlows } = await import('./flows/service');
      const status = input.status === 'draft' || input.status === 'enabled' || input.status === 'paused' || input.status === 'disabled'
        ? input.status
        : undefined;
      return listFlows(auth, {
        orgId: str(input.orgId),
        status,
        limit: typeof input.limit === 'number' ? input.limit : undefined,
      });
    }),
  });

  const RUN_STATUSES = [
    'queued', 'running', 'waiting', 'awaiting_approval', 'succeeded', 'failed', 'cancelled', 'timed_out',
  ];

  aiTools.set('run_flow', {
    tier: 3,
    domain: 'scripts',
    searchHint: 'start an enabled automation workflow now',
    deviceArgs: [],
    definition: {
      name: 'run_flow',
      description: "Start an enabled manual flow now. Starting a flow needs the user's approval, and its sensitive steps still wait for a human to approve each one. Returns the run id and the page to follow it.",
      input_schema: {
        type: 'object' as const,
        properties: {
          flowId: { type: 'string', description: 'Flow UUID' },
          orgId: { type: 'string', description: 'Target organization UUID; required for a partner-wide flow.' },
          inputs: { type: 'object', description: 'Values for the flow inputs, by name.' },
          idempotencyKey: { type: 'string', description: 'Optional key; the same key returns the same run.' },
        },
        required: ['flowId'],
      },
    },
    handler: guarded('run_flow', async (input, auth, context) => {
      // Decision 11: an unattended MCP principal (MCP_UNATTENDED_TIER3_PRINCIPALS)
      // can reach a Tier 3 handler without a tap. Only an interactive user session
      // inside a chat session, which already passed the approval card, may start a
      // flow. The session id comes from the server-owned context, never from input.
      const chatSessionId = str(context?.chatSessionId);
      if (auth.principal?.kind !== 'user_session' || !chatSessionId) return { error: 'run_flow_requires_chat' };
      const flowId = str(input.flowId);
      if (!flowId) return { error: 'flow_not_found' };
      const { startManualRun } = await import('./flows/runService');
      const result = await startManualRun(
        auth,
        flowId,
        { orgId: str(input.orgId), inputs: recordOf(input.inputs), idempotencyKey: str(input.idempotencyKey) },
        'ai_tool',
        chatSessionId,
      );
      return result.ok ? { ...result, runPath: `/flows/runs/${result.runId}` } : result;
    }),
  });

  aiTools.set('list_flow_runs', {
    tier: 1,
    domain: 'scripts',
    searchHint: 'list recent automation workflow runs and their status',
    deviceArgs: [],
    definition: {
      name: 'list_flow_runs',
      description: 'List flow runs the caller can see, newest first, optionally for one flow, organization or status.',
      input_schema: {
        type: 'object' as const,
        properties: {
          flowId: { type: 'string', description: 'Only runs of this flow (UUID).' },
          orgId: { type: 'string', description: 'Only runs in this organization (UUID).' },
          status: { type: 'string', enum: RUN_STATUSES },
          limit: { type: 'integer', description: 'Maximum runs to return (default 50, max 50)' },
        },
      },
    },
    handler: guarded('list_flow_runs', async (input, auth) => {
      const { listFlowRuns } = await import('./flows/runService');
      const status = RUN_STATUSES.includes(input.status as string) ? (input.status as never) : undefined;
      const limit = typeof input.limit === 'number' ? Math.min(50, Math.max(1, Math.trunc(input.limit))) : undefined;
      return listFlowRuns(auth, { flowId: str(input.flowId), orgId: str(input.orgId), status, limit });
    }),
  });

  aiTools.set('get_flow_run', {
    tier: 1,
    domain: 'scripts',
    searchHint: 'show one automation workflow run step by step',
    deviceArgs: [],
    definition: {
      name: 'get_flow_run',
      description: 'Read one flow run: status, error and every step with its status and output. Large step outputs are cut to 4 KB and marked truncated.',
      input_schema: {
        type: 'object' as const,
        properties: { runId: { type: 'string', description: 'Flow run UUID' } },
        required: ['runId'],
      },
    },
    handler: guarded('get_flow_run', async (input, auth) => {
      const { getFlowRun, capFlowRunToolOutput } = await import('./flows/runService');
      const runId = str(input.runId);
      const run = runId ? await getFlowRun(auth, runId, { stepBodies: 'capped' }) : null;
      if (!run) return { error: 'run_not_found' };
      // The service already caps; re-capping is idempotent and keeps the 4 KB
      // promise independent of the caller that built the detail.
      return {
        ...run,
        steps: run.steps.map((s) => ('output' in s ? { ...s, output: capFlowRunToolOutput((s as { output?: unknown }).output) } : s)),
      };
    }),
  });

  aiTools.set('cancel_flow_run', {
    tier: 2,
    domain: 'scripts',
    searchHint: 'stop a running automation workflow',
    deviceArgs: [],
    definition: {
      name: 'cancel_flow_run',
      description: 'Cancel a flow run that has not finished. Steps already running may complete; parked approvals are withdrawn. A finished run returns already_terminal.',
      input_schema: {
        type: 'object' as const,
        properties: { runId: { type: 'string', description: 'Flow run UUID' } },
        required: ['runId'],
      },
    },
    handler: guarded('cancel_flow_run', async (input, auth) => {
      const { cancelFlowRun } = await import('./flows/runService');
      const runId = str(input.runId);
      return runId ? cancelFlowRun(auth, runId) : { ok: false, error: 'run_not_found' };
    }),
  });
}
