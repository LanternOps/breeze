/**
 * Tool Catalog W03 (#5218) — the tools a flow OWNER's steps may name.
 *
 * Three sources, resolved in this order by the validator:
 *  - built-ins (`FLOW_BUILTIN_STEPS`, shared) — never in `aiTools`, so chat,
 *    MCP and the prompt index never see them;
 *  - tenant tools of the owner (`resolveTenantToolsForOwner`);
 *  - core tools a headless principal could reach. A flow runs unattended, so
 *    its principal is agent-like (spec §6.5 D4): human-only, secret-bearing,
 *    session-only (M365/Google), denied-read and blocked tools are not
 *    flow-eligible — `listAgentReachableTools()` already applies exactly that
 *    deny set — and neither are the flow tools themselves.
 */
import type { ValidateFunction } from 'ajv';
import { FLOW_BUILTIN_STEPS, type FlowBuiltinName } from '@breeze/shared';
import { aiTools } from '../aiTools';
import { listAgentReachableTools } from '../aiAgents/agentToolCatalog';
import {
  compileTenantInputSchema,
  resolveTenantToolsForOwner,
  type TenantToolDescriptor,
  type ToolOwnerRef,
} from '../toolSources/resolver';
import { FLOW_TOOL_NAMES } from './toolNames';

export type FlowCatalogEntry =
  | { source: 'core'; name: string; deviceArgs: readonly string[] }
  | { source: 'tenant'; name: string; descriptor: TenantToolDescriptor; validate: ValidateFunction }
  | { source: 'builtin'; name: FlowBuiltinName };

/** The flow authoring tools — a flow never drafts or reads flows. */
export const FLOW_EXCLUDED_CORE_TOOLS: ReadonlySet<string> = new Set<string>(FLOW_TOOL_NAMES);

/**
 * Core input fields that name an owned asset other than a device, keyed by
 * tool. Rule 6 checks every literal value against the flow owner. Pinned by
 * referenceFields.contract.test.ts: a flow-eligible tool gaining a new
 * id-typed input forces a classification decision here.
 */
export const FLOW_OWNED_REFERENCE_FIELDS: Readonly<Record<string, Readonly<Record<string, 'script' | 'device_group'>>>> = {
  run_script: { scriptId: 'script', groupId: 'device_group' },
};

/** Registered in the core tool registry at all (flow-eligible or not). */
export function isRegisteredCoreTool(name: string): boolean {
  return aiTools.has(name);
}

/** Core tools a flow step may name. Computed at call time (the registry is a live map). */
export function listFlowEligibleCoreTools(): string[] {
  return listAgentReachableTools().filter((name) => !FLOW_EXCLUDED_CORE_TOOLS.has(name));
}

export async function loadFlowCatalog(owner: ToolOwnerRef): Promise<Map<string, FlowCatalogEntry>> {
  const catalog = new Map<string, FlowCatalogEntry>();
  for (const name of Object.keys(FLOW_BUILTIN_STEPS) as FlowBuiltinName[]) {
    catalog.set(name, { source: 'builtin', name });
  }
  for (const name of listFlowEligibleCoreTools()) {
    if (catalog.has(name)) continue;
    catalog.set(name, { source: 'core', name, deviceArgs: aiTools.get(name)?.deviceArgs ?? [] });
  }
  for (const descriptor of await resolveTenantToolsForOwner(owner)) {
    // The descriptor's flattened validate() loses paths; recompile for
    // structured errors with the resolver's own Ajv options.
    const validate = compileTenantInputSchema(descriptor.inputSchema);
    if (!validate) continue;
    catalog.set(descriptor.qualifiedName, { source: 'tenant', name: descriptor.qualifiedName, descriptor, validate });
  }
  return catalog;
}
