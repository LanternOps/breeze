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
  NARRATIVE_BULLETS_PER_SECTION_MAX,
  NARRATIVE_BULLET_MAX_CHARS,
  NARRATIVE_HEADLINE_MAX_CHARS,
  NARRATIVE_SECTION_KEYS,
  TICKET_TRIAGE_PRIORITIES,
  alertVerdictOutcomeSchema,
  narrativeOutcomeFromSubmission,
  narrativeSubmissionSchema,
  sweepFindingsOutcomeSchema,
  ticketTriageProposalSchema,
  type AiAgentRunProfile,
  type AlertVerdictOutcome,
  type NarrativeOutcome,
  type SweepFindingsOutcome,
  type TicketTriageProposal,
} from '@breeze/shared';

export const OUTCOME_TOOL_NAMES = [
  'submit_alert_verdict', 'submit_sweep_findings', 'submit_narrative', 'submit_ticket_proposal',
] as const;
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
  submit_narrative: 'mcp__breeze__submit_narrative',
  submit_ticket_proposal: 'mcp__breeze__submit_ticket_proposal',
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
 * fifth profile added to `AI_AGENT_RUN_PROFILES` without a decision here is
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
    // Phase 2 wave P2-3 (weekly org narrative). This is the ONLY tool a
    // narrative run ever sees: its drill-down floor is empty by design
    // (`narrativeProfile.ts`'s `NARRATIVE_TOOL_ALLOWLIST`), so the exposure
    // this function grants IS the run's entire tool surface.
    case 'narrative':
      return ['submit_narrative'];
    // Phase 2 wave P2-4 (ticket triage), task A6 — this is the ONLY tool a
    // triage run ever sees, same "empty drill-down floor" design as
    // `narrative` (`triageProfile.ts`'s `TRIAGE_TOOL_ALLOWLIST`). Nothing
    // admits triage runs yet (task A9 flips the subscriber) — registering the
    // exposure here does not, on its own, create a triage run.
    case 'triage':
      return ['submit_ticket_proposal'];
    default: {
      const exhaustive: never = profile;
      throw new Error(`[outcomeToolsForProfile] Unknown run profile: ${String(exhaustive)}`);
    }
  }
}

export function validateOutcomeToolInput(toolName: 'submit_alert_verdict', input: unknown): AlertVerdictOutcome;
export function validateOutcomeToolInput(toolName: 'submit_sweep_findings', input: unknown): SweepFindingsOutcome;
/**
 * `submit_narrative` is the one outcome tool whose stored outcome is NOT the
 * validated tool input: the model submits `{ headline, sections: [{ key,
 * bullets }] }` and the SERVER owns the section titles, the section order and
 * the derived markdown (see `orgNarrativeReport.ts`'s file docstring for why
 * a model that could author markdown could author arbitrary document
 * structure into a customer-facing report). So this overload returns the
 * BUILT `NarrativeOutcome`, and `narrativeOutcomeFromSubmission` is reached
 * through here and nowhere else on the run path.
 */
export function validateOutcomeToolInput(toolName: 'submit_narrative', input: unknown): NarrativeOutcome;
/**
 * Phase 2 wave P2-4 (#4191) — `submit_ticket_proposal`'s validated outcome IS
 * the raw tool input (unlike `submit_narrative`): the model's
 * `TicketTriageProposal` is stored as-is, and the server-owned turning of it
 * into `manage_tickets` intents/`ticket_drafts` rows happens downstream in
 * `finishRun` (task A8), never here — this module never touches the database.
 */
export function validateOutcomeToolInput(toolName: 'submit_ticket_proposal', input: unknown): TicketTriageProposal;
// The union overload the run loop's hooks call through: `toolName` there is
// the `OutcomeToolName` the SDK handed them, not a literal, so none of the
// narrow overloads above would apply. Callers that need the concrete type
// narrow on the name first (see the post-hook's switch).
export function validateOutcomeToolInput(
  toolName: OutcomeToolName, input: unknown,
): AlertVerdictOutcome | SweepFindingsOutcome | NarrativeOutcome | TicketTriageProposal;
export function validateOutcomeToolInput(
  toolName: OutcomeToolName, input: unknown,
): AlertVerdictOutcome | SweepFindingsOutcome | NarrativeOutcome | TicketTriageProposal {
  switch (toolName) {
    case 'submit_alert_verdict':
      return alertVerdictOutcomeSchema.parse(input);
    case 'submit_sweep_findings':
      return sweepFindingsOutcomeSchema.parse(input);
    case 'submit_narrative':
      // `.parse` first (throws a message naming the missing/duplicated
      // section key, which the model reads back as the tool error), then the
      // server-owned build. Never the other way round.
      return narrativeOutcomeFromSubmission(narrativeSubmissionSchema.parse(input));
    case 'submit_ticket_proposal':
      return ticketTriageProposalSchema.parse(input);
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

/**
 * Phase 2 wave P2-3 (weekly org narrative) — the model-facing mirror of
 * `narrativeSubmissionSchema` (packages/shared/src/validators/orgNarrative.ts).
 *
 * Two rules the SHARED schema enforces but a raw Zod shape structurally
 * cannot (there is no object-level `superRefine` on a `tool()` shape) have to
 * be stated in prose here, because the tool definition is the only place the
 * model reads before its first attempt and a rejected first attempt costs one
 * of a narrative run's three turns:
 *
 *   1. **all eight keys, exactly once** — a missing or repeated key is a hard
 *      reject naming the offending key;
 *   2. **a bullet is one plain-text line** — the schema rejects any control
 *      or format codepoint (so a bullet cannot contain a newline) and rejects
 *      a bullet that is content-free once leading markdown markers are
 *      stripped (`'#'`, `'- '`, `'>'`).
 *
 * The per-field bounds below are the same constants the shared schema uses,
 * so what the model is told and what it is held to cannot drift.
 */
const SUBMIT_NARRATIVE_SHAPE = {
  headline: z.string().min(1).max(NARRATIVE_HEADLINE_MAX_CHARS).describe(
    'One plain-text sentence naming the single most important thing about this week for this customer, '
    + 'e.g. "A quiet week: alert volume down, one server still failing its backups". No markdown, no '
    + 'newlines, no identifiers.',
  ),
  sections: z.array(z.object({
    key: z.enum(NARRATIVE_SECTION_KEYS).describe(
      `Which section this is. Submit all ${NARRATIVE_SECTION_KEYS.length} of `
      + `${NARRATIVE_SECTION_KEYS.join(', ')} exactly once — a missing or repeated key is rejected and `
      + 'the whole submission has to be resent. Section titles and section order are added by the '
      + 'system; do not send them.',
    ),
    bullets: z.array(z.string().min(1).max(NARRATIVE_BULLET_MAX_CHARS)).min(1)
      .max(NARRATIVE_BULLETS_PER_SECTION_MAX)
      .describe(
        `1 to ${NARRATIVE_BULLETS_PER_SECTION_MAX} bullets, each ONE single sentence on ONE line of plain `
        + 'text: no newlines, no control characters, and no markdown markers (#, -, *, +, >) — a bullet '
        + 'containing any of those is rejected, as is a bullet with no words left once markers are '
        + 'stripped. Every section needs at least one bullet; when there is nothing to report, say that '
        + 'plainly in one bullet rather than omitting the section.',
      ),
  })).min(NARRATIVE_SECTION_KEYS.length).max(NARRATIVE_SECTION_KEYS.length).describe(
    `Exactly ${NARRATIVE_SECTION_KEYS.length} entries — one per section key, in any order.`,
  ),
};

/**
 * Phase 2 wave P2-4 (#4191, ticket triage) — the model-facing mirror of
 * `ticketTriageProposalSchema` (packages/shared/src/validators/ticketTriage.ts).
 * Same split as `SUBMIT_NARRATIVE_SHAPE`: this shape exists only to give the
 * model rich per-field `.describe()` guidance in the tool definition, and
 * carries NO authority of its own — `validateOutcomeToolInput`'s
 * `.parse()` through the real shared schema is the only place a submission is
 * actually accepted or rejected (including the `.strict()` unknown-key
 * reject and the control-character sanitization neither a raw Zod shape nor
 * this comment can express).
 *
 * `fields`/`device` are left OPTIONAL objects rather than flattened, mirroring
 * the shared schema's nesting exactly — a model that omits a whole group it
 * has nothing to say about (e.g. no device mentioned anywhere in the ticket)
 * should not have to submit an empty placeholder for it.
 */
const SUBMIT_TICKET_PROPOSAL_SHAPE = {
  version: z.literal(1).describe('Always 1.'),
  summary: z.string().min(1).max(2000).describe(
    'What you found and why, for the technician\'s eyes only (becomes a private note). 1 to 2000 characters, plain text.',
  ),
  fields: z.object({
    categoryId: z.object({
      value: z.string().uuid().describe(
        'The categoryId of one of the categories shown in the ticket context, copied verbatim. Never invent one.',
      ),
      confidence: z.number().min(0).max(1).describe(
        '0 to 1, your honest confidence in this specific field. Below 0.7 the proposal is dropped and never written, '
        + 'so do not inflate it.',
      ),
    }).strict().optional(),
    priority: z.object({
      value: z.enum(TICKET_TRIAGE_PRIORITIES).describe('One of the priorities shown in the ticket context.'),
      confidence: z.number().min(0).max(1).describe(
        '0 to 1, your honest confidence in this specific field. Below 0.7 the proposal is dropped and never written, '
        + 'so do not inflate it.',
      ),
    }).strict().optional(),
  }).strict().optional().describe(
    'Optional per-field proposals for this ticket, each with its OWN confidence — omit a field entirely rather '
    + 'than guess at it.',
  ),
  device: z.object({
    hostname: z.string().min(1).max(255).optional().describe(
      'A hostname EXACTLY as it appears in the ticket text or context — never invented, never guessed, never '
      + 'normalized. Omit if none is named.',
    ),
    serial: z.string().min(1).max(255).optional().describe(
      'A serial number EXACTLY as it appears in the ticket text or context — never invented, never guessed. '
      + 'Omit if none is named.',
    ),
  }).strict().optional().describe(
    'Only when the ticket names a specific device the system-built context did not already resolve. Resolving this '
    + 'to an actual device record happens server-side, including refusing an ambiguous match.',
  ),
  draftReply: z.string().min(1).max(4000).optional().describe(
    'A draft customer-facing reply. Never sent automatically — a technician must explicitly review and send it as '
    + 'themselves.',
  ),
  draftResolutionNote: z.string().min(1).max(2000).optional().describe(
    'A draft resolution note offered when the ticket is closed. Never applied automatically.',
  ),
  notes: z.array(z.string().min(1).max(500)).max(5).optional().describe(
    'Up to 5 short talking points folded into the one private note this run posts. Display only — never a write '
    + 'on their own.',
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
      case 'submit_narrative':
        // Same construction-site cast as above, same reason.
        return tool(
          'submit_narrative',
          'Record the weekly narrative for this organization. Submit all eight sections exactly once, '
          + 'bullets only — the system owns the section titles, the order and the rendered document. '
          + 'Call exactly once, as your last action.',
          SUBMIT_NARRATIVE_SHAPE,
          async (input) => {
            validateOutcomeToolInput('submit_narrative', input); // throws → model retries
            return { content: [{ type: 'text', text: JSON.stringify({ status: 'recorded' }) }] };
          },
        ) as SdkTool;
      case 'submit_ticket_proposal':
        // Same construction-site cast as above, same reason. Validate-only,
        // static ack — no DB (this module never touches the database; see
        // the file docstring), no execution: `finishRun` (task A8) is where a
        // stored proposal becomes anything.
        return tool(
          'submit_ticket_proposal',
          'Record your triage proposal for this ticket. Call exactly once, as your last action.',
          SUBMIT_TICKET_PROPOSAL_SHAPE,
          async (input) => {
            validateOutcomeToolInput('submit_ticket_proposal', input); // throws → model retries
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
