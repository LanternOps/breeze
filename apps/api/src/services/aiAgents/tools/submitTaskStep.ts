/**
 * The `submit_task_step` outcome tool (#5205 W06), spec §6.2.
 *
 * IT EXECUTES NOTHING. Like every other outcome tool in `outcomeTools.ts`
 * (`submit_alert_verdict`, `submit_sweep_findings`, …) the handler validates
 * its input, returns a static acknowledgement, and touches no database. The
 * captured payload becomes meaningful only in `finishRun`, where server code
 * — not the model — decides what the proposal is allowed to cause.
 *
 * WHY IT IS AN OUTCOME TOOL RATHER THAN A NEW TOOL CLASS: the outcome-tool
 * lane already has exactly the properties a task step needs. It is
 * profile-gated by `outcomeToolsForProfile`, authorized in the pre-hook
 * BEFORE `checkAgentGuardrails` runs, captured in the post-hook, and its input
 * is validated by a shared schema so a malformed submission is a retryable
 * tool error rather than a corrupt persisted record. Inventing a parallel
 * mechanism would duplicate all four and leave the duplicate unaudited.
 *
 * The one difference from its siblings: a task-linked run uses the `full`
 * profile (spec §6.2's "task-aware full-profile runs plus a registered
 * `submit_task_step` outcome tool"), and `outcomeToolsForProfile('full')`
 * returns `[]`. So this tool is gated on the RUN being task-linked rather than
 * on its profile — see `outcomeToolsForRun` in `outcomeTools.ts`.
 *
 * SHAPE NOTE. The SDK tool shape below is hand-written as a `ZodRawShape`
 * (not `submitTaskStepSchema.shape`) for the same reason the other four are:
 * `tool()` needs a raw shape whose `.describe()` text is what the model
 * actually reads, and the descriptions are prompt engineering that belongs
 * next to the tool, not next to the persistence schema. `validateSubmitTaskStep`
 * re-parses with the SHARED schema, so the two cannot drift into accepting
 * different payloads — the shape is the model's documentation, the schema is
 * the contract.
 */

import { z } from 'zod';
import {
  SUBMIT_TASK_STEP_VERSION,
  TASK_STEP_FINDING_SOURCE_KINDS,
  submitTaskStepSchema,
  type SubmitTaskStepPayload,
} from '@breeze/shared';

export const SUBMIT_TASK_STEP_TOOL_NAME = 'submit_task_step' as const;

export const SUBMIT_TASK_STEP_SHAPE = {
  version: z.literal(SUBMIT_TASK_STEP_VERSION).describe(
    'Always 1. The payload version this submission conforms to.',
  ),
  findings: z.array(
    z.object({
      text: z.string().min(1).max(500).describe(
        'ONE factual observation, at most 500 characters. State what you observed, not what you '
        + 'concluded and not how you reasoned. No speculation, no plans, no instructions.',
      ),
      sourceKind: z.enum(TASK_STEP_FINDING_SOURCE_KINDS).describe(
        'Which kind of record this fact came from. Never guess — if you did not read it from one of '
        + 'these, use "other".',
      ),
      sourceId: z.string().min(1).max(200).nullable().describe(
        'The id (or name) of the specific record the fact came from, copied verbatim, or null.',
      ),
      observedAt: z.string().datetime().describe(
        'ISO-8601 timestamp of when the underlying fact was observed, copied from the record. '
        + 'Not the current time unless you read it just now.',
      ),
    }).strict(),
  ).max(20).describe(
    'Up to 20 factual observations supporting your proposed next step. These are persisted as the '
    + 'task checkpoint and are the ONLY thing a later attempt on this task will see from your work.',
  ),
  nextStep: z.union([
    z.object({
      kind: z.literal('step'),
      key: z.string().min(1).max(128).describe(
        'The key of the next workflow step. Only steps this workflow permits from the current step '
        + 'are accepted; anything else ends the task and hands it to a technician.',
      ),
      inputs: z.record(z.string(), z.unknown()).describe(
        'That step\'s inputs. Validated server-side against the step\'s own schema.',
      ),
    }).strict(),
    z.object({
      kind: z.literal('handoff'),
      reason: z.string().min(1).max(200).describe('Short classification of why a human is needed.'),
      summary: z.string().min(1).max(2000).describe(
        'What you found, what you changed (if anything), what is unresolved, and what you suggest next.',
      ),
    }).strict(),
    z.object({
      kind: z.literal('question'),
      text: z.string().min(1).max(1000).describe(
        'One bounded question a technician can answer. Use this only when the answer actually changes '
        + 'what you would do.',
      ),
    }).strict(),
  ]).describe(
    'Exactly one of: the next workflow step to take, a handoff to a human, or a question. Proposing a '
    + 'step is a REQUEST — the server validates and executes it, you do not.',
  ),
} as const;

export const SUBMIT_TASK_STEP_DESCRIPTION =
  'Record your findings for this task step and propose exactly one next action: a permitted workflow '
  + 'step, a handoff to a technician, or a bounded question. Call exactly once, as your last action. '
  + 'This tool performs no action itself — proposing a step does not execute it, and claiming success '
  + 'here does not mark the task resolved. The task is only resolved by an independent verification '
  + 'read.';

/**
 * Validate a submission. Throws (a ZodError) on malformed input, which the
 * pre-hook surfaces to the model as a retryable tool error — identical
 * handling to `validateOutcomeToolInput`'s other arms.
 */
export function validateSubmitTaskStep(input: unknown): SubmitTaskStepPayload {
  return submitTaskStepSchema.parse(input);
}
