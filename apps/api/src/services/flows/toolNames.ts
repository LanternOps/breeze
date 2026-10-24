/**
 * Tool Catalog W03 (#5218). A leaf module (no imports) so the registry, the
 * MCP env gate and the flow catalog can all name the flow tools without an
 * import cycle through aiTools.ts.
 */
export const FLOW_TOOL_NAMES = ['draft_flow', 'validate_flow', 'get_flow', 'list_flows'] as const;
export type FlowToolName = (typeof FLOW_TOOL_NAMES)[number];
