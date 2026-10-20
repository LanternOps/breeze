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

function guarded(name: string, fn: (input: Record<string, unknown>, auth: AuthContext) => Promise<unknown>) {
  return async (input: Record<string, unknown>, auth: AuthContext): Promise<string> => {
    if (!flowsEnabled()) return DISABLED;
    try {
      return json(await fn(input, auth));
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
          limit: { type: 'integer', description: 'Maximum flows to return (1-100, default 50).' },
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
}
