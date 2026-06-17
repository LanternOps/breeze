import { describe, it, expect } from 'vitest';
import { TOOL_TIERS } from './aiAgentSdkTools';
import { TOOL_PERMISSIONS, checkGuardrails } from './aiGuardrails';
import { SCRIPT_BUILDER_TOOL_TIERS } from './scriptBuilderTools';
import { toolInputSchemas, validateToolInput } from './aiToolSchemas';

/**
 * Guard against the "Unknown tool" regression (script-builder could not search
 * or read the existing script library).
 *
 * Every script-builder *context* tool flows through makeExistingHandler ->
 * createSessionPreToolUse -> executeTool, and MUST be present in BOTH:
 *   - TOOL_TIERS (aiAgentSdkTools)    — else createSessionPreToolUse rejects it
 *                                        as "Unknown tool" before execution.
 *   - TOOL_PERMISSIONS (aiGuardrails) — else checkToolPermission denies it with
 *                                        "No RBAC permission mapping for tool".
 *
 * The list is DERIVED from the script-builder's own source-of-truth tool list
 * (SCRIPT_BUILDER_TOOL_TIERS) rather than hardcoded, so adding a new context
 * tool there without wiring it into the global maps fails this test — the exact
 * drift that caused the original bug.
 */

// The apply tools bypass preToolUse via makeApplyHandler, so they don't need
// (and must not require) TOOL_TIERS / TOOL_PERMISSIONS entries.
const APPLY_TOOLS = new Set(['apply_script_code', 'apply_script_metadata']);

// A few MCP tool names dispatch to a differently-named executeTool handler;
// preToolUse / checkToolPermission see the HANDLER name. Keep in sync with the
// makeExistingHandler(...) call sites in createScriptBuilderMcpServer.
const MCP_NAME_TO_HANDLER: Record<string, string> = {
  execute_script_on_device: 'run_script',
};

const SCRIPT_BUILDER_CONTEXT_HANDLER_TOOLS = Object.keys(SCRIPT_BUILDER_TOOL_TIERS)
  .filter((name) => !APPLY_TOOLS.has(name))
  .map((name) => MCP_NAME_TO_HANDLER[name] ?? name);

describe('script-builder context tools are fully wired for the session guardrail', () => {
  it('derives the handler-tool list from SCRIPT_BUILDER_TOOL_TIERS (so new tools cannot silently skip the guard)', () => {
    expect(SCRIPT_BUILDER_CONTEXT_HANDLER_TOOLS.length).toBeGreaterThan(0);
    expect(SCRIPT_BUILDER_CONTEXT_HANDLER_TOOLS).toContain('list_scripts');
    expect(SCRIPT_BUILDER_CONTEXT_HANDLER_TOOLS).toContain('run_script'); // execute_script_on_device
    expect(SCRIPT_BUILDER_CONTEXT_HANDLER_TOOLS).not.toContain('apply_script_code');
  });

  it.each(SCRIPT_BUILDER_CONTEXT_HANDLER_TOOLS)(
    '%s has a TOOL_TIERS entry (preToolUse would otherwise reject it as "Unknown tool")',
    (toolName) => {
      expect(
        TOOL_TIERS[toolName],
        `${toolName} is missing from TOOL_TIERS — createSessionPreToolUse rejects it as "Unknown tool"`,
      ).toBeDefined();
    },
  );

  it.each(SCRIPT_BUILDER_CONTEXT_HANDLER_TOOLS)(
    '%s has a TOOL_PERMISSIONS mapping (checkToolPermission would otherwise deny it)',
    (toolName) => {
      expect(
        TOOL_PERMISSIONS[toolName],
        `${toolName} is missing from TOOL_PERMISSIONS — checkToolPermission denies "No RBAC permission mapping"`,
      ).toBeDefined();
    },
  );

  // Membership is necessary but not sufficient: a mis-set tier or an unintended
  // action-escalation could still block a read-only library call. Verify the
  // four library tools actually resolve as allowed, tier-1 (auto-execute) reads.
  it.each([
    'list_scripts',
    'get_script_details',
    'list_script_templates',
    'get_script_execution_history',
  ])('checkGuardrails permits %s as a tier-1 read tool (no approval)', (toolName) => {
    const result = checkGuardrails(toolName, {});
    expect(result.allowed).toBe(true);
    expect(result.tier).toBe(1);
    expect(result.requiresApproval).toBe(false);
  });

  // The THIRD map: validateToolInput rejects any tool missing from
  // toolInputSchemas ("No input schema defined for tool"), so a tool can clear
  // TOOL_TIERS and TOOL_PERMISSIONS above and STILL never execute. That was the
  // #1457 follow-on bug — list_scripts surfaced past the guard but every call
  // was rejected for lack of a schema, and the AI looped until it gave up.
  it.each(SCRIPT_BUILDER_CONTEXT_HANDLER_TOOLS)(
    '%s has a registered input schema (validateToolInput would otherwise reject every call)',
    (toolName) => {
      expect(
        toolInputSchemas[toolName],
        `${toolName} is missing from toolInputSchemas — validateToolInput rejects input as "No input schema defined for tool"`,
      ).toBeDefined();
    },
  );

  it('validateToolInput accepts a no-arg list_scripts call (the script-builder default)', () => {
    expect(validateToolInput('list_scripts', {})).toEqual({ success: true });
  });

  it('validateToolInput accepts representative library-tool inputs', () => {
    expect(validateToolInput('list_scripts', { search: 'backup', language: 'powershell', limit: 5 }).success).toBe(true);
    expect(validateToolInput('list_script_templates', { category: 'Maintenance' }).success).toBe(true);
    expect(
      validateToolInput('get_script_execution_history', {
        scriptId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        limit: 10,
      }).success,
    ).toBe(true);
  });
});
