/**
 * Tool Catalog W03 (#5218). A leaf module (no imports) so the registry, the
 * MCP env gate and the flow catalog can all name the flow tools without an
 * import cycle through aiTools.ts.
 */
export const FLOW_TOOL_NAMES = [
  'draft_flow', 'validate_flow', 'get_flow', 'list_flows',
  // W04 (#5219, Task A11): run / observe / cancel.
  'run_flow', 'list_flow_runs', 'get_flow_run', 'cancel_flow_run',
] as const;
export type FlowToolName = (typeof FLOW_TOOL_NAMES)[number];

/**
 * W5 PR C (#5220), Decision 7: an enabled manual flow is a tool named
 * `flow__<slug>`. `flow` is a reserved tool-source slug
 * (packages/shared/src/validators/toolSources.ts), so no tenant tool can carry
 * the prefix; but `splitQualifiedToolName('flow__x')` still parses as slug
 * `flow`, so every tenant-tool branch must test `isFlowToolName` FIRST.
 *
 * The remainder rule is the shared flow slug rule (`FLOW_SLUG_RE` and no
 * `__`), inlined because this module is a leaf; flowTools.test.ts pins the two
 * together.
 */
export const FLOW_TOOL_PREFIX = 'flow__';
const FLOW_TOOL_SLUG_RE = /^[a-z][a-z0-9_]{1,47}$/;

export function isFlowToolName(name: string): boolean {
  if (typeof name !== 'string' || !name.startsWith(FLOW_TOOL_PREFIX)) return false;
  const slug = name.slice(FLOW_TOOL_PREFIX.length);
  return FLOW_TOOL_SLUG_RE.test(slug) && !slug.includes('__');
}

export function flowToolName(slug: string): string {
  return `${FLOW_TOOL_PREFIX}${slug}`;
}

/** The slug a flow tool name carries, or null for any other name. */
export function flowToolSlug(name: string): string | null {
  return isFlowToolName(name) ? name.slice(FLOW_TOOL_PREFIX.length) : null;
}
