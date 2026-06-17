import { describe, it, expect } from 'vitest';
import { TOOL_TIERS } from './aiAgentSdkTools';
import { TOOL_PERMISSIONS } from './aiGuardrails';

/**
 * Guard against the "Unknown tool" regression (script-builder could not search
 * or read the existing script library).
 *
 * The script-builder assistant exposes a curated set of context tools that flow
 * through makeExistingHandler -> createSessionPreToolUse -> executeTool. Each
 * such tool MUST be present in BOTH:
 *   - TOOL_TIERS (aiAgentSdkTools)    — else createSessionPreToolUse rejects it
 *                                        as "Unknown tool" before execution.
 *   - TOOL_PERMISSIONS (aiGuardrails) — else checkToolPermission denies it with
 *                                        "No RBAC permission mapping for tool".
 *
 * These are the executeTool handler names passed to makeExistingHandler in
 * createScriptBuilderMcpServer (scriptBuilderTools.ts). The apply tools
 * (apply_script_code / apply_script_metadata) intentionally bypass preToolUse
 * via makeApplyHandler, so they are excluded here. Keep this list in sync with
 * createScriptBuilderMcpServer.
 */
const SCRIPT_BUILDER_CONTEXT_HANDLER_TOOLS = [
  'query_devices',
  'get_device_details',
  'manage_alerts',
  'list_scripts',
  'get_script_details',
  'list_script_templates',
  'get_script_execution_history',
  'run_script', // exposed to the model as execute_script_on_device
] as const;

describe('script-builder context tools are fully wired for the session guardrail', () => {
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
});
