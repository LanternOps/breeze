import { isAiToolDomain } from '@breeze/shared';
import { toolActionEnum } from './aiToolActions';
import { TIER1_ACTIONS, TIER2_ACTIONS, TIER2_READONLY_ACTIONS, TIER3_ACTIONS, isReadOnlyResolution } from './aiGuardrails';

export interface McpToolAnnotations { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
/** B-W05 (#6159): a tool's MCP Apps pointer (`_meta.ui`); display-only views are model-visible only. */
export type McpToolUiMeta = { resourceUri: string; visibility: ['model'] };
// `ui` is merged in by tools/list for an MCP App's tool only; buildMcpToolPresentation never sets it.
export interface McpToolPresentation { title: string; annotations: McpToolAnnotations; _meta: { 'app.breeze/domain': string; ui?: McpToolUiMeta } }

const ACRONYMS = new Set(['m365', 's1', 'c2c', 'dns', 'cis', 'pam', 'dr', 'sla', 'vm', 'mssql', 'ip', 'os', 'psa', 'ui', 'api', 'id', 'usb', 'pprof']);

export function mcpToolTitle(name: string): string {
  return name.split('_').map((w, i) => {
    if (ACRONYMS.has(w)) return w === 'pprof' ? w : w.toUpperCase();
    return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w;
  }).join(' ');
}

export function resolveActionTier(toolName: string, action: string | undefined, baseTier: number): number {
  if (action) {
    if (TIER3_ACTIONS[toolName]?.includes(action)) return 3;
    if (TIER2_ACTIONS[toolName]?.includes(action)) return 2;
    if (TIER1_ACTIONS[toolName]?.includes(action)) return 1;
  }
  return baseTier;
}

export function isActionReadOnly(toolName: string, action: string | undefined, baseTier: number): boolean {
  const tier = resolveActionTier(toolName, action, baseTier);
  const readOnlyAction = tier === 2 && action !== undefined && (TIER2_READONLY_ACTIONS[toolName]?.includes(action) ?? false);
  return isReadOnlyResolution(toolName, { tier: tier as 1 | 2 | 3 | 4, readOnly: readOnlyAction });
}

export function buildMcpToolPresentation(tool: { name: string; input_schema?: unknown }, baseTier: number | undefined, domain: string | undefined, options: { external?: boolean } = {}): McpToolPresentation {
  const title = mcpToolTitle(tool.name);
  const meta = { 'app.breeze/domain': domain ?? 'unknown' };
  if (baseTier === undefined) {
    return { title, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }, _meta: meta };
  }
  const actions = [...new Set([...(toolActionEnum(tool.name) ?? []), ...(TIER2_ACTIONS[tool.name] ?? []), ...(TIER3_ACTIONS[tool.name] ?? [])])];
  const targets: (string | undefined)[] = actions.length > 0 ? actions : [undefined];
  const readOnlyHint = targets.every((a) => isActionReadOnly(tool.name, a, baseTier));
  // Only read-only tools can safely claim additive-only, closed-world behavior.
  const destructiveHint = !readOnlyHint;
  return {
    title,
    annotations: { readOnlyHint, destructiveHint, idempotentHint: readOnlyHint, openWorldHint: options.external === true || !readOnlyHint || !isAiToolDomain(domain) || domain === 'integrations' },
    _meta: meta,
  };
}
