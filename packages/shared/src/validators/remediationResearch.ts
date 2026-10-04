// packages/shared/src/validators/remediationResearch.ts
import { z } from 'zod';
import {
  RESEARCH_BUILTIN_ACTIONS, RESEARCH_MAX_ITEMS, RESEARCH_MAX_STEPS,
  type ResearchSubmission,
} from '../types/remediationResearch';

const text = (max: number) => z.string().trim().min(1).max(max);
const base = {
  title: text(160),
  reasoning: text(1200).describe('Why this fixes THIS problem on THIS device. Shown to technicians.'),
  riskTier: z.enum(['low', 'medium', 'high', 'critical']),
};
/** Typed params per built-in action; the execute path re-parses stored params with these. */
export const RESEARCH_BUILTIN_PARAM_SCHEMAS = {
  reboot: z.object({}).strict(),
  restart_service: z.object({ serviceName: text(256) }).strict(),
  kill_process: z.object({ processName: text(256) }).strict(),
  disk_cleanup: z.object({ actionIds: z.array(text(80)).min(1).max(12) }).strict(),
} as const satisfies { readonly [A in (typeof RESEARCH_BUILTIN_ACTIONS)[number]]: z.ZodTypeAny };

const builtin = (action: (typeof RESEARCH_BUILTIN_ACTIONS)[number], params: z.ZodTypeAny) =>
  z.object({ kind: z.literal('builtin_action'), action: z.literal(action), params, ...base }).strict();

const item = z.union([
  z.object({ kind: z.literal('catalog'), ref: z.object({ type: z.enum(['script', 'playbook']), id: z.string().uuid() }).strict(), ...base }).strict(),
  builtin('reboot', RESEARCH_BUILTIN_PARAM_SCHEMAS.reboot),
  builtin('restart_service', RESEARCH_BUILTIN_PARAM_SCHEMAS.restart_service),
  builtin('kill_process', RESEARCH_BUILTIN_PARAM_SCHEMAS.kill_process),
  builtin('disk_cleanup', RESEARCH_BUILTIN_PARAM_SCHEMAS.disk_cleanup),
  z.object({ kind: z.literal('manual_steps'), steps: z.array(text(400)).min(1).max(RESEARCH_MAX_STEPS), ...base }).strict(),
  z.object({ kind: z.literal('draft_request'), brief: text(2000), language: z.enum(['powershell', 'bash', 'python', 'cmd']), ...base }).strict(),
]);

/** Raw zod shape — the SDK `tool()` helper needs a shape, not a schema. */
export const RESEARCH_SUBMISSION_SHAPE = {
  summary: text(2000),
  items: z.array(item).max(RESEARCH_MAX_ITEMS),
};

export const researchSubmissionSchema = z.object(RESEARCH_SUBMISSION_SHAPE).strict() as unknown as z.ZodType<ResearchSubmission>;

/** A partner operator's REVIEWED generic steps — the only manual steps that can become shared memory. */
export const reviewedInstructionsSchema = z.object({
  title: text(160),
  steps: z.array(text(400)).min(1).max(RESEARCH_MAX_STEPS),
  osType: z.enum(['windows', 'macos', 'linux']).nullable(),
}).strict();
