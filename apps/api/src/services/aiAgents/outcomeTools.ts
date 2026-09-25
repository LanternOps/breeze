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
  DEVICE_FUNCTION_KEYS,
  FLEET_DESIGN_CONFIDENCE_THRESHOLD,
  NARRATIVE_BULLETS_PER_SECTION_MAX,
  NARRATIVE_BULLET_MAX_CHARS,
  NARRATIVE_HEADLINE_MAX_CHARS,
  NARRATIVE_SECTION_KEYS,
  PATCH_PLAN_DETAIL_MAX_CHARS,
  PATCH_FAILURE_CLASSES,
  PATCH_PLAN_ITEM_CLASSES,
  PATCH_PLAN_MAX_ITEMS,
  PATCH_PLAN_MAX_JOB_RESULT_IDS_PER_ITEM,
  PATCH_PLAN_MAX_PATCH_IDS_PER_ITEM,
  PATCH_PLAN_SUMMARY_MAX_CHARS,
  PATCH_PLAN_TITLE_MAX_CHARS,
  TICKET_TRIAGE_PRIORITIES,
  alertVerdictOutcomeSchema,
  fleetDesignOutcomeFromSubmission,
  fleetDesignSubmissionSchema,
  fleetDesignRuleFields,
  narrativeOutcomeFromSubmission,
  narrativeSubmissionSchema,
  patchPlanOutcomeFromSubmission,
  patchPlanSubmissionSchema,
  analysisOutcomeSchema,
  ANALYSIS_FINDING_SEVERITIES,
  sweepFindingsOutcomeSchema,
  ticketTriageProposalSchema,
  type AiAgentRunProfile,
  type AlertVerdictOutcome,
  type AnalysisOutcome,
  type FleetDesignOutcome,
  type FleetDesignOutcomeRefs,
  type FleetDesignSubmission,
  type NarrativeOutcome,
  type PatchPlanOutcome,
  type PatchPlanOutcomeRefs,
  type SweepFindingsOutcome,
  type TicketTriageProposal,
  type SubmitTaskStepPayload,
} from '@breeze/shared';
import {
  SUBMIT_TASK_STEP_DESCRIPTION,
  SUBMIT_TASK_STEP_SHAPE,
  SUBMIT_TASK_STEP_TOOL_NAME,
  validateSubmitTaskStep,
} from './tools/submitTaskStep';

export const OUTCOME_TOOL_NAMES = [
  'submit_alert_verdict', 'submit_sweep_findings', 'submit_narrative', 'submit_ticket_proposal',
  // Fleet Designer W01 (#5651) — the fifth profile-mapped outcome tool. See
  // `outcomeToolsForProfile`'s `'design'` arm below.
  'submit_fleet_design',
  // AI patch agent W01 (#5747) — the sixth profile-mapped outcome tool. See
  // `outcomeToolsForProfile`'s `'patch'` arm below.
  'submit_patch_plan',
  // Execution plane W04 (#5715) — the seventh profile-mapped outcome tool.
  // See `outcomeToolsForProfile`'s `'analysis'` arm below.
  'submit_analysis',
  // #5205 W06. Unlike the four above, this one is NOT selected by run profile
  // — a task-linked run uses the `full` profile (spec §6.2) and
  // `outcomeToolsForProfile('full')` is deliberately `[]`. It is selected by
  // `outcomeToolsForRun` on the run's task linkage instead.
  'submit_task_step',
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
  submit_task_step: 'mcp__breeze__submit_task_step',
  submit_alert_verdict: 'mcp__breeze__submit_alert_verdict',
  submit_sweep_findings: 'mcp__breeze__submit_sweep_findings',
  submit_narrative: 'mcp__breeze__submit_narrative',
  submit_ticket_proposal: 'mcp__breeze__submit_ticket_proposal',
  submit_fleet_design: 'mcp__breeze__submit_fleet_design',
  submit_patch_plan: 'mcp__breeze__submit_patch_plan',
  submit_analysis: 'mcp__breeze__submit_analysis',
};

/**
 * AI patch agent W01 — what `submit_patch_plan` validates against: the run's
 * evidence refs (`patchEvidenceRefs`), plus the two server-owned outcome
 * fields. Computed ONCE per run by `driveSdkLoop` and reused by the pre-hook,
 * the SDK handler and the post-hook capture, so they can never disagree.
 */
export interface PatchPlanToolRefs {
  refs: PatchPlanOutcomeRefs;
  evidenceTruncated: boolean;
  generatedAt: string;
}

function isPatchPlanToolRefs(value: unknown): value is PatchPlanToolRefs {
  return !!value && typeof value === 'object' && 'refs' in value && 'evidenceTruncated' in value;
}

export function isOutcomeTool(toolName: string): toolName is OutcomeToolName {
  return (OUTCOME_TOOL_NAMES as readonly string[]).includes(toolName);
}

/**
 * Which outcome tools THIS RUN may see — the profile's set, plus
 * `submit_task_step` when the run advances an AI Operator task (#5205 W06).
 *
 * This is the single function every call site uses, so exposure (the SDK tool
 * list), authorization (the pre-hook's allow test) and capture (the post-hook)
 * cannot disagree about what a run owns. That co-ordination is the whole
 * reason `outcomeToolsForProfile` was a single function to begin with; adding
 * a second selector without folding it in here would reintroduce exactly the
 * drift that comment warns about.
 *
 * A task-linked run keeps its profile's own tools. In the thin slice that set
 * is always empty (task runs are `full`), but a later wave that runs a task
 * step under, say, the `verdict` profile should get BOTH, not a silent
 * replacement.
 */
export function outcomeToolsForRun(run: {
  profile: AiAgentRunProfile;
  taskId?: string | null;
}): OutcomeToolName[] {
  const base = outcomeToolsForProfile(run.profile);
  return run.taskId ? [...base, 'submit_task_step'] : base;
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
    // Fleet Designer W01 (#5651) — a design run's ONLY tool other than its
    // small read-only drill-down floor (`designProfile.ts`'s
    // `DESIGN_TOOL_ALLOWLIST`, which is not an outcome tool and so is never
    // returned here).
    case 'design':
      return ['submit_fleet_design'];
    // AI patch agent W01 — a patch run's ONLY outcome tool; its read-only
    // drill-down floor (`patchProfile.ts`) is not an outcome tool.
    case 'patch':
      return ['submit_patch_plan'];
    // Execution plane W04 — the analysis run's ONE output channel. Unlike
    // narrative/triage this profile also has a real tool floor, but the
    // outcome is still the only thing anything downstream reads.
    case 'analysis':
      return ['submit_analysis'];
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
/**
 * #5205 W06 — `submit_task_step`'s validated outcome IS the raw tool input.
 * The proposal it carries is a REQUEST: `recipes/serviceRecovery.ts`'s
 * `validateNextStep` decides whether the named step is reachable and whether
 * its inputs parse, and `taskCoordinator.ts` is what executes anything. This
 * module, as ever, touches no database.
 */
export function validateOutcomeToolInput(toolName: 'submit_task_step', input: unknown): SubmitTaskStepPayload;
/**
 * Fleet Designer W01 (#5651) — `submit_fleet_design`'s validated outcome is
 * the SERVER-BUILT `FleetDesignOutcome` (`baseline.numbers` computed, every
 * `itemRef` attached, `markdown` derived), never the raw submission — same
 * split as `submit_narrative`. Unlike every sibling overload, this one takes
 * a THIRD, required argument: the run's device-id/baseline refs the
 * referential pass needs (`fleetDesignOutcomeFromSubmission`). There is no
 * run-independent way to validate a design submission, which is exactly why
 * `buildOutcomeSdkTools` refuses to build this tool without them (see
 * below).
 */
export function validateOutcomeToolInput(
  toolName: 'submit_fleet_design', input: unknown, refs: FleetDesignOutcomeRefs,
): FleetDesignOutcome;
/**
 * AI patch agent W01 — `submit_patch_plan`'s validated outcome is the
 * server-built `PatchPlanOutcome`. Like the design overload it takes a
 * REQUIRED refs argument: the in-tool referential gate throws on a device or
 * patch absent from the run's evidence, so the model retries within its turn
 * budget (`patchPlanOutcomeFromSubmission`). Window / job-result references
 * are left to `persistPatchPlan`, which refuses them with a disposition.
 */
export function validateOutcomeToolInput(
  toolName: 'submit_patch_plan', input: unknown, refs: PatchPlanToolRefs,
): PatchPlanOutcome;
// The union overload the run loop's hooks call through: `toolName` there is
// the `OutcomeToolName` the SDK handed them, not a literal, so none of the
// narrow overloads above would apply. Callers that need the concrete type
// narrow on the name first (see the post-hook's switch). `refs` is optional
// here — it is REQUIRED only for `submit_fleet_design`, which the
// implementation enforces at runtime (a caller reaching that branch without
// `refs` gets a thrown error, not a silently invalid outcome).
/**
 * Execution plane W04 — `submit_analysis`'s validated outcome IS the raw tool
 * input (like `submit_ticket_proposal`, unlike `submit_narrative`): the
 * `.strict()` shared schema rejects any smuggled key outright, and the
 * `proposedActions` it carries stay PROPOSALS — nothing in the run loop turns
 * them into intents (an analysis run is device-less with `maxActionsPerRun`
 * pinned to 0).
 */
export function validateOutcomeToolInput(toolName: 'submit_analysis', input: unknown): AnalysisOutcome;
export function validateOutcomeToolInput(
  toolName: OutcomeToolName, input: unknown, refs?: FleetDesignOutcomeRefs | PatchPlanToolRefs,
): AlertVerdictOutcome | SweepFindingsOutcome | NarrativeOutcome | TicketTriageProposal | SubmitTaskStepPayload
  | FleetDesignOutcome | PatchPlanOutcome | AnalysisOutcome;
export function validateOutcomeToolInput(
  toolName: OutcomeToolName, input: unknown, refs?: FleetDesignOutcomeRefs | PatchPlanToolRefs,
): AlertVerdictOutcome | SweepFindingsOutcome | NarrativeOutcome | TicketTriageProposal | SubmitTaskStepPayload
  | FleetDesignOutcome | PatchPlanOutcome | AnalysisOutcome {
  switch (toolName) {
    case 'submit_analysis':
      return analysisOutcomeSchema.parse(input);
    case 'submit_task_step':
      return validateSubmitTaskStep(input);
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
    case 'submit_fleet_design': {
      if (!refs || isPatchPlanToolRefs(refs)) throw new Error('[validateOutcomeToolInput] submit_fleet_design needs design refs');
      // `.parse` first (the message names the offending path — the model
      // reads it back as the tool error), then the referential pass, which
      // throws `FleetDesignReferenceError` with the same path discipline.
      //
      // The cast is the same boundary `fleetDesign.test.ts` (packages/shared)
      // documents on its own `asSubmission` helper: the zod schema's
      // `.refine()`-based `functionKey` check narrows at RUNTIME but not at
      // the type level, so `.parse()`'s inferred output keeps `functionKey:
      // string` rather than the real union `FleetDesignSubmission` declares.
      // The schema has already rejected anything `parseFunctionKey` would
      // reject by the time this line runs.
      return fleetDesignOutcomeFromSubmission(fleetDesignSubmissionSchema.parse(input) as FleetDesignSubmission, refs);
    }
    case 'submit_patch_plan': {
      if (!isPatchPlanToolRefs(refs)) throw new Error('[validateOutcomeToolInput] submit_patch_plan needs patch refs');
      // Structural first (the zod message names the path), then the
      // referential gate against this run's evidence — both throw, so the
      // model reads the reason back as a retryable tool error.
      return patchPlanOutcomeFromSubmission(patchPlanSubmissionSchema.parse(input), refs.refs, {
        evidenceTruncated: refs.evidenceTruncated,
        generatedAt: refs.generatedAt,
      });
    }
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

/**
 * Fleet Designer W01 (#5651) — the model-facing mirror of
 * `fleetDesignSubmissionSchema` (packages/shared/src/validators/fleetDesign.ts).
 * Same split as `SUBMIT_NARRATIVE_SHAPE`/`SUBMIT_TICKET_PROPOSAL_SHAPE`: this
 * shape carries NO authority of its own — `validateOutcomeToolInput`'s
 * `.parse()` through the real shared schema (plus the referential pass) is
 * the only place a submission is actually accepted or rejected, including
 * every `.strict()` unknown-key reject, the confidence-threshold check, the
 * one-function-per-device check and the device-id-in-evidence check a raw
 * Zod shape cannot express. Keys only, mirroring the submission's TOP-LEVEL
 * shape — the eight sections — with enough nested structure for the model to
 * submit something shaped right the first time.
 */
const FLEET_DESIGN_FUNCTION_KEY_SHAPE = z.string().max(48).describe(
  `One of ${DEVICE_FUNCTION_KEYS.join(', ')}, or a custom key shaped custom:<slug> (2-40 lowercase `
  + 'letters/digits/hyphens), which REQUIRES a label.',
);

const FLEET_DESIGN_FUNCTION_ENTRY_SHAPE = z.object({
  functionKey: FLEET_DESIGN_FUNCTION_KEY_SHAPE,
  label: z.string().max(80).optional().describe('Required when functionKey is a custom: key; the display name.'),
  deviceIds: z.array(z.string().uuid()).describe(
    'Device ids copied VERBATIM from the evidence device table. A device belongs to at most one function.',
  ),
  confidence: z.number().min(0).max(1).describe(
    `Your honest confidence. Below ${FLEET_DESIGN_CONFIDENCE_THRESHOLD} this entry is rejected here — put it `
    + 'in unsure.lowConfidenceFunctions instead.',
  ),
  evidence: z.array(z.string()).describe('Short evidence lines that justify this function assignment.'),
});

const FLEET_DESIGN_WATCH_SHAPE = z.object({
  watchType: z.enum(['service', 'process']).describe('Whether this watches a service or a plain process.'),
  name: z.string().max(255).describe('The exact service or process name to watch.'),
  alertOnStop: z.boolean().describe('Whether stopping should raise an alert.'),
  autoRestart: z.boolean().describe('Whether the agent should try to restart it automatically.'),
  rationale: z.string().describe('Why THIS fleet needs this watch. REQUIRED — never leave blank.'),
});

// W05c2 (#6371): a rule proposal IS a monitor definition. The field map comes
// from @breeze/shared so the model-facing shape cannot drift from the validator
// that parses the submission (which also runs the kind/condition cross-checks).
const FLEET_DESIGN_RULE_SHAPE = z.object({
  ...fleetDesignRuleFields,
  name: fleetDesignRuleFields.name.describe('A short, human-readable monitor name.'),
  kind: fleetDesignRuleFields.kind.describe(
    'The monitor kind (cpu, memory, disk, offline, event_log, service, process, ...). kind and condition must match.',
  ),
  condition: fleetDesignRuleFields.condition.describe(
    'The monitor condition in the monitor-definition shape for this kind, e.g. disk: { operator: "gt", value: 85, durationMinutes: 15 }.',
  ),
  severity: fleetDesignRuleFields.severity.describe('How urgent a firing of this monitor is.'),
  cooldownMinutes: fleetDesignRuleFields.cooldownMinutes.describe('Minutes to wait before re-alerting on the same condition.'),
  responses: fleetDesignRuleFields.responses.describe(
    'Device-bound responses that execute when the monitor fires. Usually []. Allowed: { type: "execute_command", kind: "restart_service" } on service monitors, send_notification, create_alert. Scripts and commands are refused; recommend them via action instead.',
  ),
  deliveryMode: fleetDesignRuleFields.deliveryMode.describe(
    'Notification delivery: "inherit" (routing decides; the default), "channels" (needs deliveryChannelIds) or "none" (inbox only).',
  ),
  rationale: fleetDesignRuleFields.rationale.describe('Why THIS fleet needs this monitor. REQUIRED — never leave blank.'),
  action: fleetDesignRuleFields.action.describe(
    'A recommended playbook or script for a technician, or "none". Recommendation only — it is not executed.',
  ),
  paging: fleetDesignRuleFields.paging.describe('Recommended paging for this monitor. Recommendation only.'),
}).describe(
  'A monitor definition. kind and condition must match. Only responses execute; action and paging are recommendation notes. Delivery inherits routing unless explicitly overridden.',
);

const SUBMIT_FLEET_DESIGN_SHAPE = {
  found: z.object({
    summary: z.array(z.string()).describe('A handful of plain-text lines: what this fleet is, its topology, who else manages it.'),
    findings: z.array(z.object({
      title: z.string().max(160).describe('One short finding title.'),
      deviceCount: z.number().int().min(0).describe('How many devices this finding affects.'),
      evidence: z.array(z.string()).describe('Short evidence lines backing this finding.'),
    })).describe('Fleet-wide findings, ranked by device count.'),
  }).describe('What the fleet is: roles, sites, topology, and the fleet-wide findings, ranked by device count.'),
  functions: z.array(FLEET_DESIGN_FUNCTION_ENTRY_SHAPE).describe(
    `One entry per device function you are confident about (>= ${FLEET_DESIGN_CONFIDENCE_THRESHOLD}). Every `
    + 'device belongs to at most one function.',
  ),
  monitoring: z.array(z.object({
    functionKey: FLEET_DESIGN_FUNCTION_KEY_SHAPE,
    watches: z.array(FLEET_DESIGN_WATCH_SHAPE).describe('Service/process watches for this function.'),
    alertRules: z.array(FLEET_DESIGN_RULE_SHAPE).describe('Monitor-definition proposals for this function; the collection name is retained for stable approval references.'),
  })).describe('What to watch, and why — one entry per function key named in `functions`.'),
  retired: z.array(z.object({
    kind: z.enum(['watch', 'rule']).describe('Whether the retired item was a watch or an alert rule.'),
    policyId: z.string().uuid().describe('The id of the existing configuration policy this item came from.'),
    policyName: z.string().max(255).describe('The policy name, copied verbatim.'),
    itemName: z.string().max(255).describe('The watch or rule name, copied verbatim.'),
    reason: z.string().describe('Why this design does not carry the item forward.'),
  })).describe('Watches/rules in the current configuration this design drops. An empty array is valid.'),
  automation: z.array(z.object({
    functionKey: FLEET_DESIGN_FUNCTION_KEY_SHAPE,
    playbooks: z.array(z.union([
      z.object({ builtInName: z.string().max(255).describe('The exact name of an existing built-in playbook.') }),
      z.object({
        custom: z.object({
          name: z.string().max(255),
          description: z.string().max(2000),
          steps: z.array(z.string()).describe('Plain-text steps, in order.'),
          triggeredBy: z.string().max(200).describe('What triggers this custom playbook.'),
        }),
      }),
    ])).describe('Automation for this function: built-in playbooks by name, or a described custom one.'),
    scripts: z.array(z.object({
      name: z.string().max(255),
      purpose: z.string().max(2000).describe('What this script does and why this fleet needs it.'),
      osTypes: z.array(z.enum(['windows', 'macos', 'linux'])).describe('Which operating systems this script targets.'),
      language: z.enum(['powershell', 'bash', 'python', 'cmd']),
      content: z.string().describe('The full script content.'),
    })).describe('New scripts proposed for this function, with full content.'),
  })).describe('Automation — built-in playbooks, custom playbooks and scripts — per function.'),
  legacy: z.array(z.object({
    scriptId: z.string().uuid().describe('The id of an existing script tagged legacy-import.'),
    scriptName: z.string().max(255),
    intent: z.string().describe('What this legacy script appears to be for.'),
    bucket: z.enum(['obsolete', 'covered', 'needed']).describe(
      'obsolete = no longer needed; covered = superseded by something this design proposes; needed = keep it.',
    ),
    coveredBy: z.string().max(255).optional().describe('What covers it, when bucket is "covered".'),
    notes: z.string(),
  })).describe('One entry per script tagged legacy-import. An empty array is valid when there are none.'),
  baseline: z.object({
    notes: z.array(z.string()).describe(
      'Plain-text notes about the baseline. The NUMBERS are computed by the system — do not submit them.',
    ),
  }).describe('Baseline notes only — the system computes the numbers.'),
  unsure: z.object({
    lowConfidenceFunctions: z.array(FLEET_DESIGN_FUNCTION_ENTRY_SHAPE).describe('Function guesses below the confidence threshold.'),
    unreachableDevices: z.array(z.string().uuid()).describe('Device ids, copied from the evidence, that you could not assess.'),
    needsHuman: z.array(z.string()).describe('Anything else that needs a human decision.'),
    roleCorrections: z.array(z.object({
      deviceId: z.string().uuid(),
      currentRole: z.string().max(30),
      proposedRole: z.string().max(30),
      evidence: z.array(z.string()),
      billingRelevant: z.literal(true).describe('Always true — a coarse role correction is always billing-relevant.'),
    })).describe('Coarse device_role corrections. Billing-relevant — flag for a human, never applied automatically.'),
  }).describe('What the designer is unsure about: low-confidence functions, unreachable devices, anything needing a human.'),
};

/**
 * AI patch agent W01 — the model-facing raw shape for `submit_patch_plan`.
 * Deliberately loose on the per-class field rules (the SDK needs a flat raw
 * shape); `patchPlanSubmissionSchema` (packages/shared) is the authority and
 * its messages name the offending path when a class carries the wrong fields.
 */
const PATCH_UUID = z.string().uuid();
/**
 * Execution plane W04 — the model-facing mirror of `analysisOutcomeSchema`
 * (packages/shared/src/validators/aiAgents.ts). Same split as its siblings:
 * the rich `.describe()` guidance lives here, the AUTHORITY is the shared
 * schema's `.strict()` `.parse()` in `validateOutcomeToolInput`.
 *
 * `proposedActions` says "proposal" three times on purpose. It is the one
 * field a prompt-injected model would try to weaponise, and the shared schema
 * rejects any extra key (an `execute: true`) outright — but the model should
 * not be spending turns discovering that.
 */
const SUBMIT_ANALYSIS_SHAPE = {
  summary: z.string().min(1).max(4000).describe(
    'What you analysed, what you found and what you did NOT find. Plain text a technician reads first.',
  ),
  findings: z.array(z.object({
    title: z.string().min(1).max(120).describe('One short line a technician scans in a list.'),
    severity: z.enum(ANALYSIS_FINDING_SEVERITIES).describe(
      'high = needs attention now; medium = schedule it; low = worth noting; info = context only.',
    ),
    detail: z.string().min(1).max(2000).describe(
      'What the data actually shows. State only what your computation demonstrates — never a cause you '
      + 'did not confirm.',
    ),
    artifactHandles: z.array(z.string().uuid()).max(20).describe(
      'Handles from workspace_collect that evidence this finding. Copy them verbatim.',
    ),
  }).strict()).max(50),
  artifactHandles: z.array(z.string().uuid()).max(100).describe(
    'Every artifact a technician should be able to open from this run.',
  ),
  proposedActions: z.array(z.object({
    tool: z.string().max(80).describe('The Breeze tool a technician would use, e.g. manage_services.'),
    action: z.string().max(80).optional(),
    deviceId: z.string().uuid().optional().describe("Only a device from this run's frozen device set."),
    args: z.record(z.string().max(80), z.unknown()),
    rationale: z.string().min(1).max(600),
  }).strict()).max(20).describe(
    'PROPOSALS ONLY. Nothing here is executed by this run; a technician reviews each one and approves it '
    + 'through the normal approval flow. Do not attempt an action yourself — you have no tool that can.',
  ),
};

const SUBMIT_PATCH_PLAN_SHAPE = {
  summary: z.string().max(PATCH_PLAN_SUMMARY_MAX_CHARS).describe(
    'Two or three sentences a technician reads first: overall patch posture and what matters most.',
  ),
  posture: z.object({
    compliancePct: z.number().min(0).max(100).describe('Percent of devices with no outstanding patch, from the evidence rollup.'),
    devicesAtRisk: z.number().int().min(0).describe('Devices you consider at risk (e.g. outstanding critical updates).'),
    oldestOutstandingDays: z.number().int().min(0).nullable().describe('Age in days of the oldest outstanding patch, or null when nothing is outstanding.'),
  }).describe('Fleet posture numbers, copied or derived from the evidence rollup.'),
  items: z.array(z.object({
    class: z.enum(PATCH_PLAN_ITEM_CLASSES).describe(
      'install = these outstanding patches should go on this device (a proposal a technician must approve); '
      + 'approval_advisory = these updates need a manual approval decision by a partner admin (no deviceId, creates nothing); '
      + 'reboot_plan = reboot inside an EXISTING maintenance window by id (never a time you choose); '
      + 'chase = failed patch work to retry; escalation = something a human must look at.',
    ),
    severity: z.enum(AI_SWEEP_SEVERITIES).describe('How urgent this item is.'),
    deviceId: PATCH_UUID.nullable().optional().describe(
      'The device id, copied from the evidence. Required for install, chase and reboot_plan; forbidden for approval_advisory.',
    ),
    patchIds: z.array(PATCH_UUID.describe('A patch id copied from that device\'s outstanding patches in the evidence.'))
      .max(PATCH_PLAN_MAX_PATCH_IDS_PER_ITEM).optional()
      .describe('Required for install, chase and approval_advisory; forbidden for reboot_plan.'),
    jobResultIds: z.array(PATCH_UUID.describe('A failed patch job result id copied from the evidence.'))
      .max(PATCH_PLAN_MAX_JOB_RESULT_IDS_PER_ITEM).optional()
      .describe('Chase items only.'),
    windowId: PATCH_UUID.nullable().optional().describe('reboot_plan only: an existing resolved maintenance window id from the evidence.'),
    title: z.string().max(PATCH_PLAN_TITLE_MAX_CHARS).describe('One line — what an approval card would show.'),
    detail: z.string().max(PATCH_PLAN_DETAIL_MAX_CHARS).describe('Why, citing the evidence numbers.'),
    evidenceRef: z.string().max(200).describe('Which evidence section/row this item comes from, e.g. "topNonCompliant".'),
    // W03 (#5749): quoted from the failedWork evidence, checked by the persister.
    failureClass: z.enum(PATCH_FAILURE_CLASSES).optional().describe(
      'chase and escalation only: the failure class shown in the failed-work evidence for this device and patch, copied verbatim.',
    ),
    attemptCount: z.number().int().min(1).optional().describe(
      'chase and escalation only: the attempt count shown in the failed-work evidence for this device and patch, copied verbatim.',
    ),
  })).max(PATCH_PLAN_MAX_ITEMS).describe('The plan items, most important first. An empty array is valid.'),
};

export function buildOutcomeSdkTools(
  names: readonly OutcomeToolName[],
  refs?: { design?: FleetDesignOutcomeRefs; patch?: PatchPlanToolRefs },
): SdkTool[] {
  return names.map((name) => {
    switch (name) {
      case 'submit_task_step':
        // Same construction-site cast as the four below, same reason. And the
        // same posture: validate-only, static ack, no DB, no execution. A
        // model that submits `{ nextStep: { kind: 'step', key: 'verify' } }`
        // gets `{status:'recorded'}` here and a classified run failure from
        // `validateNextStep` afterwards — naming a step never runs it.
        return tool(
          SUBMIT_TASK_STEP_TOOL_NAME,
          SUBMIT_TASK_STEP_DESCRIPTION,
          SUBMIT_TASK_STEP_SHAPE,
          async (input) => {
            validateSubmitTaskStep(input); // throws → model retries
            return { content: [{ type: 'text', text: JSON.stringify({ status: 'recorded' }) }] };
          },
        ) as SdkTool;
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
      case 'submit_fleet_design': {
        // Unlike every sibling case above, this tool cannot be built without
        // run-specific refs (the evidence's device-id set and the
        // server-computed baseline numbers) — there is no run-independent way
        // to validate a design submission. Refusing to build it here (rather
        // than building a tool whose handler always throws) makes a caller
        // that forgets to pass `refs` fail at wiring time, not at the model's
        // first tool call three turns into a live run.
        const design = refs?.design;
        if (!design) throw new Error('[buildOutcomeSdkTools] submit_fleet_design requires design refs');
        return tool(
          'submit_fleet_design',
          'Record the Fleet Design for this organization: all eight sections exactly once. Every watch and '
          + 'alert rule needs a rationale. Device ids must come from the evidence. Call exactly once, as '
          + 'your last action.',
          SUBMIT_FLEET_DESIGN_SHAPE,
          async (input) => {
            validateOutcomeToolInput('submit_fleet_design', input, design); // throws → model retries
            return { content: [{ type: 'text', text: JSON.stringify({ status: 'recorded' }) }] };
          },
        ) as SdkTool;
      }
      case 'submit_patch_plan': {
        // Same wiring-time refusal as submit_fleet_design: there is no
        // run-independent way to validate a patch plan's references.
        const patch = refs?.patch;
        if (!patch) throw new Error('[buildOutcomeSdkTools] submit_patch_plan requires patch refs');
        return tool(
          'submit_patch_plan',
          'Record the patch plan for this organization. Every device and patch id must be copied from the '
          + 'evidence. This records a plan for technicians — it installs, approves and reboots nothing. '
          + 'Call exactly once, as your last action.',
          SUBMIT_PATCH_PLAN_SHAPE,
          async (input) => {
            validateOutcomeToolInput('submit_patch_plan', input, patch); // throws → model retries
            return { content: [{ type: 'text', text: JSON.stringify({ status: 'recorded' }) }] };
          },
        ) as SdkTool;
      }
      case 'submit_analysis':
        return tool(
          'submit_analysis',
          'Record the result of this analysis. Call exactly once, as your last action.',
          SUBMIT_ANALYSIS_SHAPE,
          async (input) => {
            validateOutcomeToolInput('submit_analysis', input); // throws → model retries
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
