/**
 * "Check back in 5–10 minutes" — Wisp used to promise a follow-up it had no
 * way to make. Now a promise is backed by a scheduled check-in (W04), or the
 * turn ends with the server-written correction (W08).
 */
import { FOLLOW_UP_CORRECTION } from '../../../services/wisp/promiseLinter';
import type { ReplayFixture } from '../harness';
import { CHECK_IN_ID, COMMAND_ID, DEV, INVENTORY, replayCeiling, standingFacts } from './common';

const scanQueued = (deviceId: string) => ({ success: true, queued: [{ deviceId, commandId: COMMAND_ID }] });

export const checkBackFixture: ReplayFixture = {
  name: 'check back in 5-10 minutes',
  guards: '#10427 / #10410: a follow-up promise needs a check-in, or it is corrected',
  inventory: INVENTORY,
  ceiling: replayCeiling(),
  standingFacts: standingFacts(),
  turns: [
    {
      user: 'Kick off a patch scan on PC-03 and check back in 5-10 minutes.',
      modelScript: [
        { call: 'manage_patches', input: { action: 'scan', deviceIds: [DEV.PC03] } },
        { call: 'schedule_check_in', input: { delayMinutes: 10, instruction: 'Read the PC-03 patch scan result' } },
        { say: "The scan is queued on PC-03. I'll check back in 10 minutes with what it found." },
      ],
      toolOutputs: {
        manage_patches: scanQueued(DEV.PC03),
        schedule_check_in: `Check-in scheduled (ID: ${CHECK_IN_ID}) for 2026-11-09T12:10:00.000Z. Breeze will notify the user then, and the instruction comes back to you with their next message in this thread.`,
      },
    },
    {
      user: 'Thanks. Same for PC-04 please.',
      modelScript: [
        { call: 'manage_patches', input: { action: 'scan', deviceIds: [DEV.PC04] } },
        // No schedule_check_in this time: the promise has nothing behind it.
        { say: "The scan is queued on PC-04 too. I'll check back on it in 10 minutes." },
      ],
      toolOutputs: { manage_patches: scanQueued(DEV.PC04) },
    },
  ],
  expect: {
    max: { promisesWithoutMechanism: 1, unansweredTurns: 0, toolErrors: 0 },
    turns: [
      { corrections: [] },
      { corrections: [FOLLOW_UP_CORRECTION] },
    ],
  },
};
