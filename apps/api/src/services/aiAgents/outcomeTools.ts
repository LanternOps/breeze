/**
 * Outcome tools (phase 2, spec §9 "structured-output path"): SDK tools whose
 * Zod-validated INPUT is the run's structured outcome. They execute nothing,
 * are not in the `aiTools` registry (so chat / MCP / routes never see them),
 * and are exposed only to a headless run whose profile asks for them. The
 * runner's post-tool hook (runLoop.ts) captures the validated input into the
 * outcome; this module never touches the database.
 */
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { alertVerdictOutcomeSchema, AI_ALERT_VERDICT_CLASSIFICATIONS, type AlertVerdictOutcome } from '@breeze/shared';

export const OUTCOME_TOOL_NAMES = ['submit_alert_verdict'] as const;
export type OutcomeToolName = (typeof OUTCOME_TOOL_NAMES)[number];
// `ReturnType<typeof tool>` does not resolve usefully here: `tool` is generic
// over the Zod raw shape, so TypeScript instantiates the return type at the
// shape's *constraint* and the handler parameter's contravariance then makes
// every concrete `tool(...)` call (each with its own shape) unassignable to
// that instantiation. The SDK's own `CreateSdkMcpServerOptions.tools` field
// sidesteps this the same way: `Array<SdkMcpToolDefinition<any>>`.
export type SdkTool = SdkMcpToolDefinition<any>;

export const OUTCOME_MCP_TOOL_NAMES: Record<OutcomeToolName, string> = {
  submit_alert_verdict: 'mcp__breeze__submit_alert_verdict',
};

export function isOutcomeTool(toolName: string): toolName is OutcomeToolName {
  return (OUTCOME_TOOL_NAMES as readonly string[]).includes(toolName);
}

export function validateOutcomeToolInput(toolName: OutcomeToolName, input: unknown): AlertVerdictOutcome {
  switch (toolName) {
    case 'submit_alert_verdict':
      return alertVerdictOutcomeSchema.parse(input);
    default: {
      const exhaustive: never = toolName;
      throw new Error(`[validateOutcomeToolInput] Unknown outcome tool: ${String(exhaustive)}`);
    }
  }
}

const SUBMIT_ALERT_VERDICT_SHAPE = {
  classification: z.enum(AI_ALERT_VERDICT_CLASSIFICATIONS).describe(
    'actionable = a human or remediation should act; transient_self_healed = already recovered on its own; '
    + 'recurring_pattern = fires on a schedule and clears (give pattern); duplicate_of_group = same root cause as its correlation group; '
    + 'needs_human = cannot classify confidently',
  ),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(400).describe('One or two sentences shown to technicians on the alert row.'),
  pattern: z.object({
    kind: z.enum(['daily', 'weekly', 'after_event']),
    evidenceAlertIds: z.array(z.string().uuid()).max(50),
  }).optional(),
  suggestedAction: z.union([
    z.object({ tool: z.literal('manage_alerts'), action: z.literal('suppress'), alertId: z.string().uuid(), suppressDuration: z.number().int().min(0).max(720) }),
    z.object({ tool: z.literal('manage_alerts'), action: z.literal('resolve'), alertId: z.string().uuid() }),
  ]).optional().describe('Optional. Becomes a proposal a human approves; never applied directly.'),
};

export function buildOutcomeSdkTools(names: readonly OutcomeToolName[]): SdkTool[] {
  return names.map((name) => {
    switch (name) {
      case 'submit_alert_verdict':
        // Cast at construction: `tool()` returns `SdkMcpToolDefinition<Shape>` for
        // the CONCRETE shape above, which TypeScript's contravariant handler-arg
        // check will not widen into the loose `SdkTool` (= SdkMcpToolDefinition<any>)
        // used to type a heterogeneous array of outcome tools. The `tool()` call
        // itself is still fully checked against SUBMIT_ALERT_VERDICT_SHAPE.
        return tool(
          'submit_alert_verdict',
          'Record your final verdict for this alert or correlation group. Call exactly once, as your last action.',
          SUBMIT_ALERT_VERDICT_SHAPE,
          async (input) => {
            validateOutcomeToolInput('submit_alert_verdict', input); // throws → model retries
            return { content: [{ type: 'text', text: JSON.stringify({ status: 'recorded' }) }] };
          },
        ) as SdkTool;
      default: {
        const exhaustive: never = name;
        throw new Error(`[buildOutcomeSdkTools] Unknown outcome tool: ${String(exhaustive)}`);
      }
    }
  });
}
