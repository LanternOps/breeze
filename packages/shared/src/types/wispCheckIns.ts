/**
 * Wisp check-in timers (feature #10991): Wisp schedules its own follow-up on
 * its thread. When the timer fires the grantor is notified, a `check_in` post
 * lands on the thread, and the next turn in that thread reaches the model with
 * the check-in's instruction prepended.
 *
 * `WISP_CHECK_IN_STATUSES` mirrors the `wisp_check_ins_status_chk` CHECK and
 * the limits below mirror `wisp_check_ins_instruction_len_chk` /
 * `wisp_check_ins_due_window_chk` (apps/api/migrations/*-wisp-check-ins.sql).
 * Change them together.
 *
 * Lifecycle: scheduled → fired → consumed; scheduled | fired → cancelled.
 */
import type { WispEntityKind } from './wisp';

export const WISP_CHECK_IN_STATUSES = ['scheduled', 'fired', 'consumed', 'cancelled'] as const;
export type WispCheckInStatus = (typeof WISP_CHECK_IN_STATUSES)[number];

/** Earliest a check-in may fire, in minutes after it is scheduled. */
export const WISP_CHECK_IN_MIN_DELAY_MINUTES = 1;
/** Latest a check-in may fire, in minutes after it is scheduled (7 days). */
export const WISP_CHECK_IN_MAX_DELAY_MINUTES = 10_080;
/** Longest instruction, in characters (code points; `char_length` in SQL). */
export const WISP_CHECK_IN_INSTRUCTION_MAX = 1000;
/** Most `scheduled` check-ins one thread may hold at once. */
export const WISP_CHECK_IN_MAX_SCHEDULED_PER_THREAD = 5;
/** Most `fired` check-ins prepended to (and consumed by) one turn, oldest first. */
export const WISP_CHECK_IN_CONSUME_LIMIT = 5;

/** The row's `context` jsonb: the subject the check-in is about, when there is one. */
export type WispCheckInContext = { subject?: { kind: WispEntityKind; id: string } };

/** A check-in as the API returns it. */
export type WispCheckIn = {
  id: string;
  threadId: string;
  status: WispCheckInStatus;
  dueAt: string; // ISO
  instruction: string;
  subject: { kind: WispEntityKind; id: string } | null;
  firedAt: string | null; // ISO
  createdAt: string; // ISO
};
