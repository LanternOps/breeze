/**
 * Outcome tools (phase 2, spec §9 "structured-output path"): SDK tools whose
 * Zod-validated INPUT is the run's structured outcome. They execute nothing,
 * are not in the `aiTools` registry (so chat / MCP / routes never see them),
 * and are exposed only to a headless run whose profile asks for them. The
 * runner's post-tool hook (runLoop.ts) captures the validated input into the
 * outcome; this module never touches the database.
 *
 * One outcome tool per non-`full` profile, mapped by `outcomeToolsForProfile`
 * — that function is the SINGLE source of truth the run loop uses for the
 * pre-hook gate, the post-hook capture, the SDK `allowedTools` exposure and
 * the MCP `extraTools` registration, so a verdict run can never be handed the
 * sweep tool (or vice versa) by one of those four sites drifting.
 */
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  AI_ALERT_VERDICT_CLASSIFICATIONS,
  AI_SWEEP_KINDS,
  AI_SWEEP_SEVERITIES,
  alertVerdictOutcomeSchema,
  sweepFindingsOutcomeSchema,
  type AiAgentRunProfile,
  type AlertVerdictOutcome,
  type SweepFindingsOutcome,
} from '@breeze/shared';

export const OUTCOME_TOOL_NAMES = ['submit_alert_verdict', 'submit_sweep_findings'] as const;
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
  submit_sweep_findings: 'mcp__breeze__submit_sweep_findings',
};

export function isOutcomeTool(toolName: string): toolName is OutcomeToolName {
  return (OUTCOME_TOOL_NAMES as readonly string[]).includes(toolName);
}

/**
 * Which outcome tool(s) a run profile may see — exposure AND authority. A
 * `full` run gets none: it has the whole registry and its output channel is
 * the free-text summary, not a structured outcome.
 *
 * Exhaustive on `AiAgentRunProfile` by construction (the `never` default): a
 * seventh profile added to `AI_AGENT_RUN_PROFILES` without a decision here is
 * a compile error, not a run that silently exposes nothing (or, worse,
 * everything).
 */
export function outcomeToolsForProfile(profile: AiAgentRunProfile): OutcomeToolName[] {
  switch (profile) {
    case 'full':
      return [];
    case 'verdict':
      return ['submit_alert_verdict'];
    case 'sweep':
      return ['submit_sweep_findings'];
    default: {
      const exhaustive: never = profile;
      throw new Error(`[outcomeToolsForProfile] Unknown run profile: ${String(exhaustive)}`);
    }
  }
}

export function validateOutcomeToolInput(toolName: 'submit_alert_verdict', input: unknown): AlertVerdictOutcome;
export function validateOutcomeToolInput(toolName: 'submit_sweep_findings', input: unknown): SweepFindingsOutcome;
// The union overload the run loop's hooks call through: `toolName` there is
// the `OutcomeToolName` the SDK handed them, not a literal, so neither of the
// two narrow overloads above would apply. Callers that need the concrete
// type narrow on the name first (see the post-hook's switch).
export function validateOutcomeToolInput(
  toolName: OutcomeToolName, input: unknown,
): AlertVerdictOutcome | SweepFindingsOutcome;
export function validateOutcomeToolInput(
  toolName: OutcomeToolName, input: unknown,
): AlertVerdictOutcome | SweepFindingsOutcome {
  switch (toolName) {
    case 'submit_alert_verdict':
      return alertVerdictOutcomeSchema.parse(input);
    case 'submit_sweep_findings':
      return sweepFindingsOutcomeSchema.parse(input);
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
    // Review round 2 (IMPORTANT 2): `min(1)`, not `min(0)` — a model-suggested
    // suppression may never be indefinite (`0` = forever is a human-only
    // choice on the real `manage_alerts` tool schema, aiToolSchemas.ts, which
    // stays `min(0)` deliberately). Keep in sync with
    // `alertVerdictOutcomeSchema` in packages/shared/src/validators/aiAgents.ts.
    z.object({ tool: z.literal('manage_alerts'), action: z.literal('suppress'), alertId: z.string().uuid(), suppressDuration: z.number().int().min(1).max(720) }),
    z.object({ tool: z.literal('manage_alerts'), action: z.literal('resolve'), alertId: z.string().uuid() }),
  ]).optional().describe('Optional. Becomes a proposal a human approves; never applied directly.'),
};

/**
 * The one mutation a sweep finding may propose — the model-facing mirror of
 * `sweepProposedActionSchema` (packages/shared/src/validators/aiAgentSchedules.ts).
 * A closed two-variant union on purpose: everything else a sweep might want
 * done is a human's call, and there is no run-loop path that executes either
 * of these anyway (a sweep run's `maxActionsPerRun` is 0 — see
 * `sweepProfile.ts`). Task A7 turns an accepted proposal into a supervised,
 * device-bound action intent.
 */
const SWEEP_PROPOSED_ACTION = z.discriminatedUnion('tool', [
  z.object({
    tool: z.literal('manage_services'),
    action: z.literal('restart'),
    deviceId: z.string().uuid().describe('Must be the deviceId of a row shown in the evidence.'),
    serviceName: z.string().min(1).max(255).describe('The service name exactly as it appears in the evidence row.'),
  }),
  z.object({
    tool: z.literal('remediate_vulnerability'),
    deviceId: z.string().uuid().describe('Must be the deviceId of a row shown in the evidence.'),
    deviceVulnerabilityIds: z.array(z.string().uuid()).min(1).max(100).describe(
      'Copy these from the evidence row\'s deviceVulnerabilityIds field — never invent or reformat an id.',
    ),
  }),
]);

const SWEEP_FINDING = z.object({
  kind: z.enum(AI_SWEEP_KINDS).describe('Which sweep check this finding came from — the evidence section it appeared under.'),
  severity: z.enum(AI_SWEEP_SEVERITIES).describe(
    'critical = customer impact now or imminent data loss; high = needs work this week; medium = schedule it; '
    + 'low = worth noting; info = context only, no action expected.',
  ),
  deviceId: z.string().uuid().nullable().optional().describe(
    'The device this finding is about, copied verbatim from the evidence row. Omit or null ONLY for a '
    + 'fleet-wide observation that names no single machine.',
  ),
  title: z.string().min(1).max(120).describe('One short line a technician scans in a list, e.g. "C: is 96% full".'),
  detail: z.string().min(1).max(600).describe(
    'What is wrong, on which machine, and why it matters. State only what the evidence (or a read tool you '
    + 'called) actually shows — never guess a cause you did not confirm.',
  ),
  evidence: z
    .record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean(), z.null()]))
    .describe('The evidence-row fields that justify this finding, copied verbatim. Scalars only; at most 20 keys.'),
  proposedAction: SWEEP_PROPOSED_ACTION.optional().describe(
    'Optional. Becomes a proposal a human approves; never applied directly, and only valid for a device that '
    + 'appears in the evidence.',
  ),
});

const SUBMIT_SWEEP_FINDINGS_SHAPE = {
  summary: z.string().min(1).max(400).describe(
    'Two or three sentences a technician reads first: what this sweep looked at and what stood out. Say so '
    + 'plainly when nothing needs attention.',
  ),
  findings: z.array(SWEEP_FINDING).max(50).describe(
    'One entry per real problem, deduplicated — never one entry per evidence row. An empty array is a valid, '
    + 'expected result for a healthy org.',
  ),
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
      case 'submit_sweep_findings':
        // Same construction-site cast as above, same reason.
        return tool(
          'submit_sweep_findings',
          'Record the findings of this scheduled sweep. Call exactly once, as your last action.',
          SUBMIT_SWEEP_FINDINGS_SHAPE,
          async (input) => {
            validateOutcomeToolInput('submit_sweep_findings', input); // throws → model retries
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
