import { z } from 'zod';
import {
  YARA_MAX_RULE_SOURCE_BYTES,
  YARA_RULE_NAME_PATTERN,
  YARA_RULE_SEVERITIES,
} from '@breeze/shared';

/**
 * Request schemas for `routes/security/yara.ts` (#6263 W03a). They mirror the
 * DB CHECKs on yara_rules (name pattern, 64 KiB source) so a bad request is a
 * 400 rather than a 23514 from the database.
 */

const ruleSource = z
  .string()
  .min(1)
  .refine((s) => Buffer.byteLength(s, 'utf8') <= YARA_MAX_RULE_SOURCE_BYTES, {
    message: `Rule source must be at most ${YARA_MAX_RULE_SOURCE_BYTES} bytes`,
  });

const ruleName = z.string().regex(YARA_RULE_NAME_PATTERN, {
  message: 'Rule name must be a YARA identifier: a letter or underscore, then letters, digits or underscores (max 128)',
});

const tags = z.array(z.string().trim().min(1).max(64)).max(32);

export const yaraRuleSetIdParamSchema = z.object({ id: z.string().uuid() });
export const yaraRuleIdParamSchema = z.object({ ruleId: z.string().uuid() });

// ownerScope is create-only (Partner-Wide First step 2): the update schema
// below is built WITHOUT it, so a PATCH can never move a set across owners.
export const createYaraRuleSetSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().max(2000).optional(),
  ownerScope: z.enum(['organization', 'partner']).default('organization'),
  orgId: z.string().uuid().optional(),
  autoQuarantine: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

export const updateYaraRuleSetSchema = createYaraRuleSetSchema
  .omit({ ownerScope: true, orgId: true })
  .partial();

export const createYaraRuleSchema = z.object({
  name: ruleName,
  source: ruleSource,
  severity: z.enum(YARA_RULE_SEVERITIES).optional(),
  tags: tags.optional(),
  enabled: z.boolean().optional(),
});

export const updateYaraRuleSchema = createYaraRuleSchema.partial();
