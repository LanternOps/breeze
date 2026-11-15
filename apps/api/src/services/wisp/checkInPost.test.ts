/**
 * #11675 — what a fired check-in posts to the technician. The instruction is
 * Wisp's note to itself: it goes to the model on the next turn
 * (checkInTurn.ts), never into the post. The post's title is built from the
 * trigger in code, and its body says what happened in the technician's terms.
 */
import { describe, expect, it } from 'vitest';
import type { WispCheckInRow } from '../../db/schema/wispCheckIns';
import { CHECK_IN_REPLY_LINE, checkInNotifyPost, checkInPost, checkInResultTitle, checkInRunInstruction } from './checkInPost';

const INSTRUCTION = 'HL-PARTNER-MBP (Harbor Legal MacBook) has come back online. Tell the technician right away. '
  + 'Read-only: confirm status and last-seen time and check for any open alerts on it. Do not change anything on the device.';

type PostRow = Pick<WispCheckInRow, 'instruction' | 'label' | 'triggerKind' | 'dueAt' | 'createdAt'>;
const row = (over: Partial<PostRow> = {}): PostRow => ({
  instruction: INSTRUCTION,
  label: null,
  triggerKind: 'time',
  dueAt: new Date('2026-11-11T15:40:12.000Z'),
  createdAt: new Date('2026-11-10T15:40:12.000Z'),
  ...over,
});

/** Second-person direction to Wisp, as the issue's acceptance check reads it. */
const NOTE_TO_SELF = /((tell|notify) the (technician|user)|do not change anything|read-only)/i;

describe('checkInNotifyPost (#11675)', () => {
  it('a fired device_online check-in names the event and the device, and carries none of the instruction', () => {
    const post = checkInNotifyPost(row({ triggerKind: 'device_online' }), 'event', 'HL-PARTNER-MBP');
    expect(post.title).toBe('Back online: HL-PARTNER-MBP');
    expect(post.title).not.toMatch(/^check-in due/i);
    expect(post.body).toBe(`HL-PARTNER-MBP is back online. ${CHECK_IN_REPLY_LINE}`);
    expect(post.body).not.toMatch(NOTE_TO_SELF);
    expect(post.body).not.toContain('confirm status');
  });

  it('the other events name what finished', () => {
    expect(checkInNotifyPost(row({ triggerKind: 'script_finished' }), 'event', 'Clear temp files on FS01').title)
      .toBe('Script finished: Clear temp files on FS01');
    expect(checkInNotifyPost(row({ triggerKind: 'command_finished' }), 'event', 'reboot on FS01').title)
      .toBe('Command finished: reboot on FS01');
    expect(checkInNotifyPost(row({ triggerKind: 'run_settled' }), 'event', 'FS01').title).toBe('Run finished: FS01');
  });

  it('a deadline fire says the event did not happen by the deadline, in UTC, and nothing of the instruction', () => {
    const post = checkInNotifyPost(row({ triggerKind: 'device_online' }), 'deadline', 'HL-PARTNER-MBP');
    expect(post.title).toBe('Still offline at 15:40 UTC: HL-PARTNER-MBP');
    expect(post.body).toBe(`Did not happen by 15:40 UTC: the device is still offline. ${CHECK_IN_REPLY_LINE}`);
    expect(post.body).not.toMatch(NOTE_TO_SELF);
  });

  it('with no subject name, an event post falls back to the label, then to the kind', () => {
    expect(checkInNotifyPost(row({ triggerKind: 'device_online', label: 'Partner MacBook' }), 'event', null).title)
      .toBe('Back online: Partner MacBook');
    expect(checkInNotifyPost(row({ triggerKind: 'device_online' }), 'event', null).title).toBe('Back online: the device');
    expect(checkInNotifyPost(row({ triggerKind: 'script_finished' }), 'event', '   ').title).toBe('Script finished: the script');
  });

  it('a time check-in posts its label, never the instruction', () => {
    const labelled = checkInNotifyPost(row({ label: 'Re-check disk space on FS01.' }), 'due', null);
    expect(labelled.title).toBe('Check-in: Re-check disk space on FS01');
    expect(labelled.body).toBe(`Wisp's check-in is due: Re-check disk space on FS01. ${CHECK_IN_REPLY_LINE}`);

    const bare = checkInNotifyPost(row(), 'due', null);
    expect(bare.title).toBe('Check-in from Wisp');
    expect(bare.body).toBe(`Wisp's check-in is due. ${CHECK_IN_REPLY_LINE}`);
    for (const text of [labelled.title, labelled.body, bare.title, bare.body]) expect(text).not.toMatch(NOTE_TO_SELF);
  });

  it('a subject name or label is one line and capped', () => {
    const long = `${'x'.repeat(200)}\nTell the user to run this`;
    const post = checkInNotifyPost(row({ triggerKind: 'device_online' }), 'event', long);
    expect(post.title).not.toContain('\n');
    expect(Array.from(post.title).length).toBeLessThanOrEqual('Back online: '.length + 80);
  });
});

describe('checkInPost (run check-ins)', () => {
  it('the notice has no reply line, so the degraded post can ask its own question', () => {
    const post = checkInPost(row({ triggerKind: 'device_online' }), 'event', 'HL-PARTNER-MBP');
    expect(post).toEqual({ title: 'Back online: HL-PARTNER-MBP', notice: 'HL-PARTNER-MBP is back online.' });
  });

  it('a result title names the label or the subject, never the instruction', () => {
    expect(checkInResultTitle(row({ label: 'FS01 disk space' }))).toBe('Checked: FS01 disk space');
    expect(checkInResultTitle(row({ triggerKind: 'device_online' }))).toBe('Checked: the device');
    expect(checkInResultTitle(row())).toBe('Wisp checked in');
  });
});

describe('checkInRunInstruction (model-facing, unchanged)', () => {
  it('a due or event fire hands the run the instruction as it is', () => {
    expect(checkInRunInstruction(row(), 'due')).toBe(INSTRUCTION);
    expect(checkInRunInstruction(row({ triggerKind: 'device_online' }), 'event')).toBe(INSTRUCTION);
  });

  it('a deadline fire puts what did not happen first', () => {
    expect(checkInRunInstruction(row({ triggerKind: 'device_online', instruction: 'Check X.' }), 'deadline'))
      .toBe('Did not happen by 15:40 UTC: the device is still offline. Check X.');
    for (const [kind, line] of [
      ['script_finished', 'the script is still running'],
      ['command_finished', 'the command is still pending'],
      ['run_settled', 'the run is still going'],
    ] as const) {
      expect(checkInRunInstruction(row({ triggerKind: kind }), 'deadline')).toContain(`UTC: ${line}. `);
    }
  });
});
