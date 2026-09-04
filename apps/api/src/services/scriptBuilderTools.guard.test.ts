import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { TOOL_TIERS } from './aiAgentSdkTools';
import { TOOL_PERMISSIONS, checkGuardrails } from './aiGuardrails';
import {
  applyScriptMetadataInputShape,
  buildScriptBuilderTools,
  SCRIPT_BUILDER_HANDLER_BY_MCP_TOOL,
  SCRIPT_BUILDER_MCP_TOOL_NAMES,
  SCRIPT_BUILDER_TOOL_TIERS,
  scriptBuilderMcpToolName,
} from './scriptBuilderTools';
import { isAllowedForSession } from './mcpToolNames';
import { toolInputSchemas, validateToolInput } from './aiToolSchemas';
import type { AuthContext } from '../middleware/auth';

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
// preToolUse's tier/RBAC/schema lookups see the HANDLER name. Imported rather
// than restated here so the test cannot drift from the map the registration
// itself resolves through — the "still dispatches each tool to its executeTool
// handler name" case below pins the map against the real handlers.
const MCP_NAME_TO_HANDLER = SCRIPT_BUILDER_HANDLER_BY_MCP_TOOL;

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

// ============================================
// #4883: the session allowlist must see the EXPOSED tool name
// ============================================

/**
 * The three maps above are about the *handler* identity. This block is about
 * the other identity every tool has — the `mcp__script_builder__<name>` the
 * SDK exposes to the model, which is also what `scriptAi.ts` puts in the
 * session's `allowedTools`.
 *
 * `createSessionPreToolUse` gates on `isAllowedForSession(<name>,
 * session.allowedTools)`. `execute_script_on_device` dispatches to the
 * `run_script` handler, so passing the handler name to that gate compared
 * `run_script` against an allowlist that only ever holds
 * `mcp__script_builder__execute_script_on_device` — every Script Builder test
 * run came back `Tool 'run_script' is not allowed for this session`, before
 * tier/approval logic ran at all (#4883).
 *
 * These tests drive the REAL registered handlers, so they fail if the two
 * identities are ever conflated again — including for a future renamed tool.
 */
describe('#4883: script-builder tools reach the session guardrail under the name the session granted', () => {
  const GUARD_TEST_BLOCK = 'blocked-by-guard-test';

  /**
   * Invoke every registered context tool's handler with a pre-hook that
   * records what the guardrail was asked about and then blocks, so nothing
   * reaches executeTool / the database.
   */
  async function capturePreToolUseCalls() {
    const calls: Array<{ toolName: string; mcpToolName: string | undefined }> = [];
    const onPreToolUse = vi.fn(
      async (toolName: string, _input: Record<string, unknown>, mcpToolName?: string) => {
        calls.push({ toolName, mcpToolName });
        return { allowed: false as const, error: GUARD_TEST_BLOCK };
      },
    );

    const getAuth = () => {
      throw new Error('getAuth must not be reached — the pre-hook blocks first');
    };
    const tools = buildScriptBuilderTools(getAuth as unknown as () => AuthContext, onPreToolUse);
    const contextTools = tools.filter((t) => !APPLY_TOOLS.has(t.name));

    for (const t of contextTools) {
      await t.handler({} as never, undefined);
    }

    return { contextTools, calls };
  }

  it('asks the guardrail about a name the session allowlist actually contains', async () => {
    const { contextTools, calls } = await capturePreToolUseCalls();

    expect(calls).toHaveLength(contextTools.length);
    contextTools.forEach((t, i) => {
      const { toolName, mcpToolName } = calls[i]!;
      const checkedName = mcpToolName ?? toolName;
      expect(
        isAllowedForSession(checkedName, SCRIPT_BUILDER_MCP_TOOL_NAMES),
        `${t.name}: the guard checks '${checkedName}' against a session allowlist that holds `
          + `'${scriptBuilderMcpToolName(t.name)}' — it will deny a tool the session granted`,
      ).toBe(true);
    });
  });

  it('still dispatches each tool to its executeTool handler name', async () => {
    const { contextTools, calls } = await capturePreToolUseCalls();

    contextTools.forEach((t, i) => {
      // Handler identity: what TOOL_TIERS / TOOL_PERMISSIONS / the rate limits
      // are keyed on. Pins SCRIPT_BUILDER_HANDLER_BY_MCP_TOOL against the real
      // registration, so the map the three tests above derive from cannot
      // quietly disagree with what actually runs.
      expect(calls[i]!.toolName).toBe(MCP_NAME_TO_HANDLER[t.name] ?? t.name);
      // Exposed identity: it must be THIS tool's MCP name, not some other
      // allowlisted tool's — otherwise the gate could be satisfied by a name
      // the model never called.
      expect(calls[i]!.mcpToolName).toBe(scriptBuilderMcpToolName(t.name));
    });
  });

  it('registers exactly the tools the session allowlist is built from', async () => {
    const registered = buildScriptBuilderTools(
      (() => {
        throw new Error('getAuth must not be reached');
      }) as unknown as () => AuthContext,
    ).map((t) => t.name);

    // SCRIPT_BUILDER_MCP_TOOL_NAMES is derived from SCRIPT_BUILDER_TOOL_TIERS,
    // so a tool registered without a tier entry is exposed to the model but
    // absent from the session allowlist — denied on every call, exactly the
    // #4883 failure mode by a different route.
    expect(registered.slice().sort()).toEqual(Object.keys(SCRIPT_BUILDER_TOOL_TIERS).sort());
  });

  // The allowlist must not have been WIDENED to make the above pass. A bare
  // handler alias in SCRIPT_BUILDER_MCP_TOOL_NAMES would satisfy the first
  // test while also granting `run_script` to every session that only ever
  // asked for `execute_script_on_device`.
  it('does not grant the bare run_script handler name', () => {
    expect(isAllowedForSession('run_script', SCRIPT_BUILDER_MCP_TOOL_NAMES)).toBe(false);
    expect(isAllowedForSession('mcp__breeze__run_script', SCRIPT_BUILDER_MCP_TOOL_NAMES)).toBe(false);
  });

  it('still rejects tools the script-builder session never granted', () => {
    for (const denied of [
      'execute_command',
      'mcp__breeze__execute_command',
      'mcp__script_builder__execute_command',
      'manage_devices',
      'm365_reset_password',
    ]) {
      expect(
        isAllowedForSession(denied, SCRIPT_BUILDER_MCP_TOOL_NAMES),
        `${denied} is not a script-builder tool and must stay denied`,
      ).toBe(false);
    }
  });

  it('returns the guardrail denial to the model instead of executing', async () => {
    const onPreToolUse = vi.fn(async () => ({ allowed: false as const, error: GUARD_TEST_BLOCK }));
    const getAuth = () => {
      throw new Error('getAuth must not be reached');
    };
    const tools = buildScriptBuilderTools(getAuth as unknown as () => AuthContext, onPreToolUse);
    const exec = tools.find((t) => t.name === 'execute_script_on_device');
    expect(exec).toBeDefined();

    const result = await exec!.handler({} as never, undefined);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(GUARD_TEST_BLOCK);
  });
});

describe('apply_script_metadata timeoutSeconds cap', () => {
  // The agent executor hard-clamps script timeouts to 3600s
  // (agent/internal/executor/executor.go MaxTimeout). If this inline cap ever
  // drifts back up (e.g. to let the builder honor a "2 hour timeout" request),
  // the builder would propose values the scripts route then rejects with a 400,
  // breaking the apply flow — see #2398.
  const schema = z.object(applyScriptMetadataInputShape);

  it('accepts a timeout at the 3600s executor cap', () => {
    expect(schema.safeParse({ timeoutSeconds: 3600 }).success).toBe(true);
  });

  it('rejects timeouts above 3600s (#2398)', () => {
    for (const tooLong of [3601, 7200, 86400]) {
      expect(schema.safeParse({ timeoutSeconds: tooLong }).success).toBe(false);
    }
  });
});
