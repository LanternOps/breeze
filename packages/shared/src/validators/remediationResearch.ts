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
const builtin = (action: (typeof RESEARCH_BUILTIN_ACTIONS)[number], params: z.ZodTypeAny) =>
  z.object({ kind: z.literal('builtin_action'), action: z.literal(action), params, ...base }).strict();

const item = z.union([
  z.object({ kind: z.literal('catalog'), ref: z.object({ type: z.enum(['script', 'playbook']), id: z.string().uuid() }).strict(), ...base }).strict(),
  builtin('reboot', z.object({}).strict()),
  builtin('restart_service', z.object({ serviceName: text(256) }).strict()),
  builtin('kill_process', z.object({ processName: text(256) }).strict()),
  builtin('disk_cleanup', z.object({ actionIds: z.array(text(80)).min(1).max(12) }).strict()),
  z.object({ kind: z.literal('manual_steps'), steps: z.array(text(400)).min(1).max(RESEARCH_MAX_STEPS), ...base }).strict(),
  z.object({ kind: z.literal('draft_request'), brief: text(2000), language: z.enum(['powershell', 'bash', 'python', 'cmd']), ...base }).strict(),
]);

export const researchSubmissionSchema = z.object({
  summary: text(2000),
  items: z.array(item).max(RESEARCH_MAX_ITEMS),
}).strict() as unknown as z.ZodType<ResearchSubmission>;
