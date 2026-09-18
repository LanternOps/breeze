import { z } from 'zod';
import { REMEDIATION_TRIGGER_KINDS, REMEDIATION_TRIGGER_KEY_MAX } from '../types/remediationTrigger';

export const remediationTriggerSchema = z.object({
  kind: z.enum(REMEDIATION_TRIGGER_KINDS),
  refId: z.string().uuid().nullish(),
  key: z.string().min(1).max(REMEDIATION_TRIGGER_KEY_MAX).nullish(),
}).strict();
