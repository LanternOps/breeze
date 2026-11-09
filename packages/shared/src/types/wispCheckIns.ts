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
 *
 * Event check-ins (W04 #11493, #10410): a row may wait on an event instead of
 * a time. `WISP_CHECK_IN_TRIGGER_KINDS` mirrors `wisp_check_ins_trigger_kind_chk`
 * and `WISP_CHECK_IN_FIRE_REASONS` mirrors `wisp_check_ins_fire_reason_chk`
 * (apps/api/migrations/*-wisp-check-ins-event-triggers.sql). For an event row
 * `due_at` is the deadline: it fires on the event, or at `due_at` saying the
 * event did not happen.
 *
 * Run check-ins (W07 #11496, #10410): `mode: 'run'` admits one read-only
 * assessment run under the grant when the check-in fires and posts the run's
 * result. `WISP_CHECK_IN_MODES` mirrors `wisp_check_ins_mode_chk`
 * (apps/api/migrations/*-wisp-check-ins-run-mode.sql). A run row's lifecycle:
 * scheduled → running → consumed (the result was posted) or fired (the run
 * did not finish; the grantor was asked to run it now).
 */
import type { WispEntityKind } from './wisp';

export const WISP_CHECK_IN_STATUSES = ['scheduled', 'running', 'fired', 'consumed', 'cancelled'] as const;
export type WispCheckInStatus = (typeof WISP_CHECK_IN_STATUSES)[number];

/**
 * What a check-in does when it fires: `notify` (post the instruction; it
 * returns with the grantor's next message) or `run` (Wisp checks on its own,
 * read-only, under the grant, and posts the result).
 */
export const WISP_CHECK_IN_MODES = ['notify', 'run'] as const;
export type WispCheckInMode = (typeof WISP_CHECK_IN_MODES)[number];

/** Earliest a check-in may fire, in minutes after it is scheduled. */
export const WISP_CHECK_IN_MIN_DELAY_MINUTES = 1;
/** Latest a check-in may fire, in minutes after it is scheduled (7 days). */
export const WISP_CHECK_IN_MAX_DELAY_MINUTES = 10_080;
/** Longest instruction, in characters (code points; `char_length` in SQL). */
export const WISP_CHECK_IN_INSTRUCTION_MAX = 1000;
/** Most `scheduled` + `running` check-ins one thread may hold at once. */
export const WISP_CHECK_IN_MAX_SCHEDULED_PER_THREAD = 5;
/** Most `fired` check-ins prepended to (and consumed by) one turn, oldest first. */
export const WISP_CHECK_IN_CONSUME_LIMIT = 5;

/** What a check-in waits for: a time, or one of the events below. */
export const WISP_CHECK_IN_TRIGGER_KINDS = ['time', 'device_online', 'script_finished', 'command_finished', 'run_settled'] as const;
export type WispCheckInTriggerKind = (typeof WISP_CHECK_IN_TRIGGER_KINDS)[number];

/** The event kinds a check-in can wait for (every kind but `time`). */
export const WISP_CHECK_IN_TRIGGER_EVENTS = ['device_online', 'script_finished', 'command_finished', 'run_settled'] as const;
export type WispCheckInTriggerEvent = (typeof WISP_CHECK_IN_TRIGGER_EVENTS)[number];

/** An event check-in's deadline when the caller gives none, in minutes (24 h). */
export const WISP_CHECK_IN_DEFAULT_DEADLINE_MINUTES = 1440;

/**
 * Why a check-in fired: `due` (a time check-in reached its time), `event`
 * (the event happened) or `deadline` (an event check-in reached `due_at` and
 * the event had not happened).
 */
export const WISP_CHECK_IN_FIRE_REASONS = ['due', 'event', 'deadline'] as const;
export type WispCheckInFireReason = (typeof WISP_CHECK_IN_FIRE_REASONS)[number];

/** Longest `cancel_reason`, in characters (`wisp_check_ins_cancel_reason_len_chk`). */
export const WISP_CHECK_IN_CANCEL_REASON_MAX = 200;

/**
 * What a deadline post says is still true when the event did not happen
 * ("Did not happen by 15:40 UTC: the device is still offline. …").
 */
export const WISP_CHECK_IN_PENDING_STATE_LINES: Readonly<Record<WispCheckInTriggerEvent, string>> = Object.freeze({
  device_online: 'the device is still offline',
  script_finished: 'the script is still running',
  command_finished: 'the command is still pending',
  run_settled: 'the run is still going',
});

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
  /** The event it waits for; null for a time check-in. For an event check-in `dueAt` is the deadline. */
  trigger: { kind: WispCheckInTriggerEvent; subjectId: string } | null;
  /** Why it fired; null until it has. */
  fireReason: WispCheckInFireReason | null;
  /** Why Breeze cancelled it (e.g. `grant_inactive`, `subject_deleted`); null otherwise. */
  cancelReason: string | null;
  /** W07: `notify`, or `run` (Wisp checks on its own and posts the result). */
  mode: WispCheckInMode;
  /** W07: the assessment run a `run` check-in admitted; null until it has (and always for `notify`). */
  runId: string | null;
};
