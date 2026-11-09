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
  WISP_CHECK_IN_MODES,
  WISP_CHECK_IN_TRIGGER_EVENTS,
} from '../types/wispCheckIns';
import { wispEntityKindSchema } from './wisp';

/**
 * W04 (#11493, #10410): fire when an event happens instead of at a time. The
 * subject is the device (`device_online`), script execution
 * (`script_finished`), device command (`command_finished`) or agent run
 * (`run_settled`). `deadlineMinutes` (1..10080, default
 * WISP_CHECK_IN_DEFAULT_DEADLINE_MINUTES) is when it fires anyway, saying the
 * event did not happen.
 */
export const wispCheckInTriggerSchema = z.object({
  event: z.enum(WISP_CHECK_IN_TRIGGER_EVENTS),
  subjectId: z.guid(),
  deadlineMinutes: z.number().int().min(WISP_CHECK_IN_MIN_DELAY_MINUTES).max(WISP_CHECK_IN_MAX_DELAY_MINUTES).optional(),
});
export type WispCheckInTriggerInput = z.infer<typeof wispCheckInTriggerSchema>;

/**
 * Exactly one of `delayMinutes` (whole minutes, 1..10080), `at` (ISO 8601
 * WITH an offset or `Z`: a bare local time would be read in the server's time
 * zone) or `trigger` (an event, with a deadline). Unknown keys are stripped,
 * so nothing the model adds (a grantId, a threadId) reaches the handler.
 */
export const scheduleCheckInSchema = z
  .object({
    delayMinutes: z.number().int().min(WISP_CHECK_IN_MIN_DELAY_MINUTES).max(WISP_CHECK_IN_MAX_DELAY_MINUTES).optional(),
    at: z.iso.datetime({ offset: true }).optional(),
    instruction: z.string().trim().min(1).max(WISP_CHECK_IN_INSTRUCTION_MAX),
    subject: z.object({ kind: wispEntityKindSchema, id: z.guid() }).optional(),
    trigger: wispCheckInTriggerSchema.optional(),
    /** W07 (#11496, #10410): absent = `notify`. `run` checks on its own (read-only) when it fires. */
    mode: z.enum(WISP_CHECK_IN_MODES).optional(),
  })
  .superRefine((value, ctx) => {
    const given = Number(value.delayMinutes !== undefined) + Number(value.at !== undefined) + Number(value.trigger !== undefined);
    if (given !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['delayMinutes'],
        message: 'give exactly one of delayMinutes, at or trigger',
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
