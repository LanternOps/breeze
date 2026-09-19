/**
 * Canonical MCP tool-name normalization and the session-allowlist predicate.
 *
 * Deliberately a dependency-free leaf module, for two different reasons:
 *
 * - `stripMcpPrefix` was duplicated — `aiAgentSdk.ts` and
 *   `actionIntents/secretBearingTools.ts` each carried a hand-synced copy,
 *   because `aiAgentSdk.ts` imports `secretBearingTools.ts` and neither could
 *   import the other. It gates `isAllowedForSession` below,
 *   `secretBearingTools.isSecretBearingTool` (and through it the
 *   pre-execution refusal in `aiAgentSdkTools.ts` and
 *   `assertNoPlaintextSecret`), so a narrower or drifted copy fails OPEN and
 *   reinstates the plaintext-secret leak class. One implementation, here.
 * - `isAllowedForSession` was never duplicated; it lived unexported in
 *   `aiAgentSdk.ts` and moved here so the script-builder guard test can
 *   exercise the real predicate without pulling in that module's graph.
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
 *
 * `toolName` must be non-empty. An empty string fails CLOSED (nothing in an
 * allowlist strips to `''`), but it is never a meaningful question to ask.
 */
export function isAllowedForSession(toolName: string, allowedTools: readonly string[]): boolean {
  const bareToolName = stripMcpPrefix(toolName);
  return allowedTools.some((allowedTool) => stripMcpPrefix(allowedTool) === bareToolName);
}
