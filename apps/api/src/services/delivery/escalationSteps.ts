import { z } from 'zod';

export const escalationStepSchema = z.object({
  delayMinutes: z.number().int().min(1).max(10080),
  channelIds: z.array(z.string().guid()).max(100).default([]),
  userIds: z.array(z.string().guid()).max(100).default([]),
  renotify: z.object({ everyMinutes: z.number().int().min(1).max(1440),
    maxTimes: z.number().int().min(1).max(10) }).strict().optional(),
}).strict().refine(step => step.channelIds.length + step.userIds.length > 0, 'At least one target is required');
export type EscalationStep = z.infer<typeof escalationStepSchema>;

export const escalationStepsSchema = z.array(escalationStepSchema).min(1).max(10).refine(
  steps => steps.reduce((total, step) => total + 1 + (step.renotify?.maxTimes ?? 0), 0) <= 50,
  'Escalation policy must have at most 50 total occurrences',
);

