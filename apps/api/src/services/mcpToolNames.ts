/**
 * Canonical MCP tool-name normalization and the session-allowlist predicate.
 *
 * Deliberately a dependency-free leaf module. Both helpers gate security
 * decisions (which tools a session may invoke, and which results must be
 * sealed), and both were previously copy-pasted into the modules that needed
 * them — `aiAgentSdk.ts` and `actionIntents/secretBearingTools.ts` — because
 * importing either of those from the other is a cycle. A narrower or drifted
 * copy of `stripMcpPrefix` fails OPEN, so it lives here once.
 *
 * (Unrelated to `aiToolNames.ts`, which owns the core AI tool *registry* and
 * the extension reserved-name guard.)
 */

/**
 * Reduce `mcp__<server>__<tool>` to the bare `<tool>`. Any server segment is
 * accepted (not just `mcp__breeze__`): the SDK prefixes in-process MCP tools
 * with whichever server registered them, so a check that only understood one
 * server name would let a differently-prefixed name slip past.
 */
export function stripMcpPrefix(toolName: string): string {
  if (!toolName.startsWith('mcp__')) return toolName;
  const separatorIndex = toolName.indexOf('__', 'mcp__'.length);
  return separatorIndex === -1 ? toolName : toolName.slice(separatorIndex + 2);
}

/**
 * Is `toolName` covered by this session's `allowedTools`?
 *
 * Both sides are normalized, so a session that allowed
 * `mcp__script_builder__query_devices` also permits the bare `query_devices`.
 * The comparison is on the *exposed* tool name — the name the SDK advertised
 * to the model, which is what the allowlist was built from. Where a tool's
 * model-facing name differs from the `executeTool` handler that runs it
 * (script builder's `execute_script_on_device` -> `run_script`, #4883), the
 * caller must pass the exposed name here; checking the handler name against
 * an allowlist of exposed names denies a tool the session explicitly granted.
 */
export function isAllowedForSession(toolName: string, allowedTools: readonly string[]): boolean {
  const bareToolName = stripMcpPrefix(toolName);
  return allowedTools.some((allowedTool) => stripMcpPrefix(allowedTool) === bareToolName);
}
