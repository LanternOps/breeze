import { z } from 'zod';
import { REARM_MODES, type RearmMode } from '../utils/alertLifecycle';

export const rearmModeSchema = z.enum(REARM_MODES);
/** Minutes after close before an `after_delay` episode may re-open on consumed evidence. */
export const rearmDelayMinutesSchema = z.number().int().min(1).max(1440);
export const alertCooldownMinutesSchema = z.number().int().min(0).max(1440);

export const REARM_PAIR_MESSAGE = 'rearmDelayMinutes (1–1440) is required when rearmMode is after_delay, and must be null otherwise';

/**
 * The re-arm pair rule: `after_delay` ⇔ a delay. An omitted (`undefined`) mode
 * places no constraint here — that is a partial update, and the service checks
 * the MERGED row (the DB CHECK is the backstop).
 */
export function isValidRearmPair(value: {
  rearmMode?: RearmMode | null;
  rearmDelayMinutes?: number | null;
}): boolean {
  if (value.rearmMode === undefined) return true;
  const hasDelay = value.rearmDelayMinutes !== null && value.rearmDelayMinutes !== undefined;
  return value.rearmMode === 'after_delay' ? hasDelay : !hasDelay;
}

export const rearmFieldsShape = {
  rearmMode: rearmModeSchema.nullable().optional(),
  rearmDelayMinutes: rearmDelayMinutesSchema.nullable().optional(),
};

/**
 * The pair rule is a top-level `.refine` (not a `superRefine` chained after
 * other checks), so it always runs once the fields themselves parse.
 */
export const rearmFieldsSchema = z
  .object(rearmFieldsShape)
  .refine(isValidRearmPair, { message: REARM_PAIR_MESSAGE, path: ['rearmDelayMinutes'] });

/**
 * `PUT /alerts/lifecycle-defaults` body. Every field is REQUIRED so a PUT
 * replaces the level's whole setting set and can never wipe a value the client
 * merely omitted.
 * - partner: the default everyone inherits — non-null values
 *   (`rearmDelayMinutes` is null unless `after_delay`).
 * - organization: an override — each field `null` = inherit the partner default.
 */
const partnerLifecycleDefaultsSchema = z
  .object({
    scope: z.literal('partner'),
    autoResolve: z.boolean(),
    rearmMode: rearmModeSchema,
    rearmDelayMinutes: rearmDelayMinutesSchema.nullable(),
    cooldownMinutes: alertCooldownMinutesSchema,
  })
  .refine(isValidRearmPair, { message: REARM_PAIR_MESSAGE, path: ['rearmDelayMinutes'] });

const orgLifecycleDefaultsSchema = z
  .object({
    scope: z.literal('organization'),
    orgId: z.string().uuid(),
    autoResolve: z.boolean().nullable(),
    rearmMode: rearmModeSchema.nullable(),
    rearmDelayMinutes: rearmDelayMinutesSchema.nullable(),
    cooldownMinutes: alertCooldownMinutesSchema.nullable(),
  })
  .refine(isValidRearmPair, { message: REARM_PAIR_MESSAGE, path: ['rearmDelayMinutes'] });

export const alertLifecycleDefaultsSchema = z.discriminatedUnion('scope', [
  partnerLifecycleDefaultsSchema,
  orgLifecycleDefaultsSchema,
]);
export type AlertLifecycleDefaultsInput = z.infer<typeof alertLifecycleDefaultsSchema>;

export const alertLifecycleDefaultsQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
});
