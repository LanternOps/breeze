import { z } from 'zod';
import { CONTACT_ROLES } from '../../services/contacts/types';
import { reportTypeSchema } from './schemas';

/** The same loose regex as ReportBuilder chips and the worker (schemas.ts emailRecipients). */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const seriesRecipientRuleSchema = z.object({
  primaryContact: z.boolean(),
  roles: z.array(z.enum(CONTACT_ROLES)).max(CONTACT_ROLES.length),
}).strict();

const internalCcSchema = z.array(z.string().trim().regex(EMAIL).max(254)).max(50);
/** Recurring only (INDEX): a one-time series would never run. */
const seriesScheduleSchema = z.enum(['daily', 'weekly', 'monthly']);
const formatSchema = z.enum(['csv', 'pdf', 'excel']);
const targetModeSchema = z.enum(['all', 'selected']);
const orgIdsSchema = z.array(z.string().guid()).max(1000);

/**
 * Loose (the builder round-trips presentation metadata); the route parses it
 * against the type's own schema (parseStoredReportConfig) and the series
 * rules. `emailRecipients` is refused: internalCc is its one home.
 */
const seriesConfigSchema = z.looseObject({}).superRefine((value, ctx) => {
  if (Object.prototype.hasOwnProperty.call(value, 'emailRecipients')) {
    ctx.addIssue({
      code: 'custom',
      path: ['emailRecipients'],
      message: 'Set internal CC addresses with internalCc, not config.emailRecipients',
    });
  }
});

function requireSelectedOrgs(value: { targetMode: 'all' | 'selected'; orgIds: string[] }, ctx: z.RefinementCtx): void {
  if (value.targetMode === 'selected' && value.orgIds.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['orgIds'], message: 'Chosen organizations needs at least one organization' });
  }
  if (new Set(value.orgIds).size !== value.orgIds.length) {
    ctx.addIssue({ code: 'custom', path: ['orgIds'], message: 'orgIds must not repeat' });
  }
}

export const createSeriesSchema = z.object({
  name: z.string().trim().min(1).max(255),
  type: reportTypeSchema,
  format: formatSchema.default('pdf'),
  schedule: seriesScheduleSchema,
  config: seriesConfigSchema.optional().default({}),
  targetMode: targetModeSchema.default('all'),
  orgIds: orgIdsSchema.default([]),
  recipientRule: seriesRecipientRuleSchema.default({ primaryContact: true, roles: [] }),
  internalCc: internalCcSchema.default([]),
  enabled: z.boolean().default(true),
  ownerUserId: z.string().guid().optional(),
}).strict().superRefine(requireSelectedOrgs);

/**
 * Shared definition fields only. `.strict()` refuses partnerId, type,
 * targetMode/orgIds (PUT /:id/targets) and ownerUserId (transfer-owner).
 */
export const updateSeriesSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  format: formatSchema.optional(),
  schedule: seriesScheduleSchema.optional(),
  config: seriesConfigSchema.optional(),
  recipientRule: seriesRecipientRuleSchema.optional(),
  internalCc: internalCcSchema.optional(),
  enabled: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, { message: 'No updates provided' });

export const replaceSeriesTargetsSchema = z.object({
  targetMode: targetModeSchema,
  orgIds: orgIdsSchema,
}).strict().superRefine(requireSelectedOrgs);

export const transferSeriesOwnerSchema = z.object({ ownerUserId: z.string().guid() }).strict();

export const previewSeriesRecipientsSchema = z.object({
  targetMode: targetModeSchema,
  orgIds: orgIdsSchema.default([]),
  recipientRule: seriesRecipientRuleSchema,
  internalCc: internalCcSchema.default([]),
}).strict().superRefine(requireSelectedOrgs);

export const seriesIdParamSchema = z.object({ id: z.string().guid() });
