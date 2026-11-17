/**
 * What a fired check-in says to the technician (#11675). A leaf module: the
 * row, shared constants and no I/O.
 *
 * A check-in carries two texts, for two readers:
 *   - `instruction` — Wisp's note to itself ("Tell the technician right away.
 *     Read-only: confirm status …"). It reaches the MODEL only: prepended to
 *     the next turn (checkInTurn.ts) or handed to a run check-in's assessment
 *     (`checkInRunInstruction`). It is never posted.
 *   - the post — written for the TECHNICIAN. The title is built from the
 *     trigger in code ("Back online: HL-PARTNER-MBP", "Still offline at 15:40
 *     UTC: …"), and a time check-in uses its `label`, the short line Wisp
 *     wrote for the technician at scheduling. The body says what happened and
 *     that a reply picks it up; Wisp's own answer comes on that next turn.
 *
 * The subject name (a device's display name or hostname, `<script> on
 * <device>`, `the run on <device>`; checkInTriggers.ts) and
 * the label are display text from outside this module (agent- or
 * model-written), so each is flattened to one line, stripped of control and
 * format characters, and capped before it is shown.
 */
import { WISP_CHECK_IN_PENDING_STATE_LINES, type WispCheckInFireReason, type WispCheckInTriggerEvent } from '@breeze/shared';
import type { WispCheckInRow } from '../../db/schema/wispCheckIns';

type PostRow = Pick<WispCheckInRow, 'instruction' | 'label' | 'triggerKind' | 'dueAt'>;

/** Code points of a subject name or label shown in a title. */
export const CHECK_IN_DISPLAY_MAX = 80;
/** The tail of a notify post: the instruction comes back to Wisp with the technician's next message. */
export const CHECK_IN_REPLY_LINE = 'Reply here and Wisp will pick it up.';

/** The title's lead when the event happened. */
const EVENT_TITLE: Readonly<Record<WispCheckInTriggerEvent, string>> = Object.freeze({
  device_online: 'Back online',
  script_finished: 'Script finished',
  command_finished: 'Command finished',
  run_settled: 'Run finished',
});
/** The title's lead when the deadline passed first ("Still offline at 15:40 UTC: …"). */
const DEADLINE_TITLE: Readonly<Record<WispCheckInTriggerEvent, string>> = Object.freeze({
  device_online: 'Still offline',
  script_finished: 'Still running',
  command_finished: 'Still pending',
  run_settled: 'Still running',
});
/** What the event's subject is called when neither a name nor a label is known. */
const GENERIC_SUBJECT: Readonly<Record<WispCheckInTriggerEvent, string>> = Object.freeze({
  device_online: 'the device',
  script_finished: 'the script',
  command_finished: 'the command',
  run_settled: 'the run',
});

/** Control (Cc), format (Cf), line and paragraph separators: never shown, and a line break would forge a second line. */
const INVISIBLE_OR_BREAK = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

/** One line, no control or format characters, at most `max` code points (an ellipsis marks a cut). null when nothing is left. */
export function displayText(text: string | null | undefined, max: number = CHECK_IN_DISPLAY_MAX): string | null {
  if (typeof text !== 'string') return null;
  const flat = text.replace(INVISIBLE_OR_BREAK, ' ').replace(/\s+/gu, ' ').trim();
  if (flat === '') return null;
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/** The label as a phrase: displayText, without the sentence's closing punctuation (the post adds its own). */
function labelPhrase(label: string | null): string | null {
  const text = displayText(label);
  if (text === null) return null;
  const bare = text.replace(/[.!?。]+$/u, '').trim();
  return bare === '' ? null : bare;
}

/** A sentence that starts with the subject: "the run on FS01 …" → "The run on FS01 …". A name is left as written. */
function sentenceStart(subject: string): string {
  return subject.startsWith('the ') ? `The ${subject.slice(4)}` : subject;
}

/** `HH:MM UTC`; a deadline post is written at (or just after) that time, so the date is not needed. */
function utcClock(at: Date): string {
  return `${at.toISOString().slice(11, 16)} UTC`;
}

/**
 * The technician-facing title and notice of a fire. `subjectName` is the
 * event subject's display name, read at fire time (null when unknown); the
 * fallback is the kind ("the device"), never the label: a label says what the
 * check-in is about, not what the subject is called. The notice has no
 * closing ask: a notify post adds CHECK_IN_REPLY_LINE (`checkInNotifyPost`),
 * a run check-in's degraded post asks to run it now.
 */
export function checkInPost(row: PostRow, reason: WispCheckInFireReason, subjectName: string | null): { title: string; notice: string } {
  const label = labelPhrase(row.label);
  if (row.triggerKind === 'time') {
    return {
      title: label ? `Check-in: ${label}` : 'Check-in from Wisp',
      notice: label ? `Wisp's check-in is due: ${label}.` : "Wisp's check-in is due.",
    };
  }
  const kind = row.triggerKind;
  const subject = displayText(subjectName) ?? GENERIC_SUBJECT[kind];
  if (reason === 'deadline') {
    return {
      title: `${DEADLINE_TITLE[kind]} at ${utcClock(row.dueAt)}: ${subject}`,
      notice: `Did not happen by ${utcClock(row.dueAt)}: ${WISP_CHECK_IN_PENDING_STATE_LINES[kind]}.`,
    };
  }
  return {
    title: `${EVENT_TITLE[kind]}: ${subject}`,
    notice: kind === 'device_online' ? `${sentenceStart(subject)} is back online.` : `${sentenceStart(subject)} has finished.`,
  };
}

/** A notify check-in's post: the notice, then that a reply picks it up. */
export function checkInNotifyPost(row: PostRow, reason: WispCheckInFireReason, subjectName: string | null): { title: string; body: string } {
  const { title, notice } = checkInPost(row, reason, subjectName);
  return { title, body: `${notice} ${CHECK_IN_REPLY_LINE}` };
}

/** The title of a run check-in's answer: the label, else the event's kind ("the device"), never the instruction. */
export function checkInResultTitle(row: Pick<WispCheckInRow, 'label' | 'triggerKind'>): string {
  const label = labelPhrase(row.label);
  if (label) return `Checked: ${label}`;
  if (row.triggerKind !== 'time') return `Checked: ${GENERIC_SUBJECT[row.triggerKind]}`;
  return 'Wisp checked in';
}

/**
 * MODEL-facing: what a run check-in's assessment is told to do — the
 * instruction, or for a `deadline` fire what did not happen by the due time
 * first ("Did not happen by 15:40 UTC: the device is still offline. <instruction>").
 * Built from the row alone, so a re-fire of a claimed row hands over the same
 * text. Never posted.
 */
export function checkInRunInstruction(row: Pick<WispCheckInRow, 'instruction' | 'triggerKind' | 'dueAt'>, reason: WispCheckInFireReason): string {
  if (reason !== 'deadline' || row.triggerKind === 'time') return row.instruction;
  return `Did not happen by ${utcClock(row.dueAt)}: ${WISP_CHECK_IN_PENDING_STATE_LINES[row.triggerKind]}. ${row.instruction}`;
}
