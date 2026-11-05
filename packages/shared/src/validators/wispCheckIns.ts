/**
 * Wisp check-in timers (feature #10991, W03 #10994) — Zod for the three Wisp
 * chat tools: `schedule_check_in`, `list_check_ins`, `cancel_check_in`
 * (apps/api/src/services/wisp/checkInTools.ts).
 *
 * The limits are the shared constants in `../types/wispCheckIns`, which mirror
 * the `wisp_check_ins` CHECKs. The 1 minute .. 7 day window of an `at` is
 * checked by the service against its own clock (it writes `created_at` from
 * that clock), not here: a parse-time `Date.now()` and the insert's `now`
 * would disagree at the edges.
 */
import { z } from 'zod';
import {
  WISP_CHECK_IN_INSTRUCTION_MAX,
  WISP_CHECK_IN_MAX_DELAY_MINUTES,
  WISP_CHECK_IN_MIN_DELAY_MINUTES,
} from '../types/wispCheckIns';
import { wispEntityKindSchema } from './wisp';

/**
 * Exactly one of `delayMinutes` (whole minutes, 1..10080) or `at` (ISO 8601
 * WITH an offset or `Z`: a bare local time would be read in the server's time
 * zone). Unknown keys are stripped, so nothing the model adds (a grantId, a
 * threadId) reaches the handler.
 */
export const scheduleCheckInSchema = z
  .object({
    delayMinutes: z.number().int().min(WISP_CHECK_IN_MIN_DELAY_MINUTES).max(WISP_CHECK_IN_MAX_DELAY_MINUTES).optional(),
    at: z.iso.datetime({ offset: true }).optional(),
    instruction: z.string().trim().min(1).max(WISP_CHECK_IN_INSTRUCTION_MAX),
    subject: z.object({ kind: wispEntityKindSchema, id: z.guid() }).optional(),
  })
  .superRefine((value, ctx) => {
    const given = Number(value.delayMinutes !== undefined) + Number(value.at !== undefined);
    if (given !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['delayMinutes'],
        message: 'give exactly one of delayMinutes or at',
      });
    }
  });
export type ScheduleCheckInInput = z.infer<typeof scheduleCheckInSchema>;

/** `cancel_check_in` input: one check-in id (from `list_check_ins` or the schedule result). */
export const cancelCheckInSchema = z.object({ checkInId: z.guid() });
export type CancelCheckInInput = z.infer<typeof cancelCheckInSchema>;

/** `list_check_ins` input (no members; the API adds the tool-only `limit`). */
export const listCheckInsToolSchema = z.object({}).strict();
export type ListCheckInsToolInput = z.infer<typeof listCheckInsToolSchema>;
