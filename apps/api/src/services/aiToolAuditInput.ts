/**
 * Per-tool summaries of a tool call's INPUT for the two generic tool-audit
 * writers (#6268): the chat `ai.tool.<name>` row (`aiAgentSdk.ts`) and the
 * MCP `mcp.tool.<name>` row (`mcpTier3Lifecycle.ts`). Both used to serialise
 * the raw input; `sanitizeAuditPayload` redacts secret-shaped keys only.
 *
 * `ioc_hunt`: an IOC list is customer threat intelligence (hashes, domains,
 * IPs, file paths). Its values never reach `audit_logs` — `iocs` becomes
 * `{ count, kinds }`. Scope is the audit trail only: the intent row
 * (`action_intents.arguments`, what the approver reviews and release
 * executes) and the chat transcript tables (`ai_messages`,
 * `ai_tool_executions.tool_input`) still hold the list, like any other tool
 * input there.
 *
 * Identity for every other tool. Never mutates the caller's object.
 */
type InputSummarizer = (input: Record<string, unknown>) => Record<string, unknown>;

function summarizeIocList(value: unknown): { count: number; kinds: string[] } {
  if (!Array.isArray(value)) return { count: 0, kinds: [] };
  const kinds = new Set<string>();
  for (const ioc of value) {
    const kind = ioc && typeof ioc === 'object' ? (ioc as Record<string, unknown>).kind : undefined;
    if (typeof kind === 'string' && /^[a-z0-9_]{1,32}$/.test(kind)) kinds.add(kind);
  }
  return { count: value.length, kinds: [...kinds].sort() };
}

const SUMMARIZERS: Record<string, InputSummarizer> = {
  ioc_hunt: (input) => ('iocs' in input ? { ...input, iocs: summarizeIocList(input.iocs) } : input),
};

export function summarizeToolInputForAudit(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const summarize = SUMMARIZERS[toolName];
  return summarize ? summarize(input) : input;
}
