/**
 * "Tell me the moment it's back online" (#11685) — in 5 of 11 live runs Wisp
 * set a 15-minute `create_watch` for one device and said real-time notice was
 * not possible, though `schedule_check_in` with a `device_online` trigger
 * fires on the reconnect.
 *
 * The scripted model takes the event check-in only when what Wisp is told
 * carries the rule: the `create_watch` description sends a single awaited
 * event to `schedule_check_in`, and the behaviour block states "one event →
 * check-in, a condition → watch". Without it, the script plays the observed
 * watch run. This pins the guidance; it cannot measure the rate. The live
 * eval scenario `back-online-uses-event-check-in` does that.
 */
import type { ModelView, ReplayFixture, ScriptedModelStep } from '../harness';
import { CHECK_IN_ID, INVENTORY, ORG_JUNIPER, replayCeiling, standingFacts } from './common';

export const PARTNER_MBP = 'dddddddd-0001-4ddd-8ddd-dddddddddddd';
const WATCH_ID = 'cccccccc-0004-4ccc-8ccc-cccccccccccc';

/**
 * The rule as Wisp is told it, in both places: the create_watch description
 * sends one event to schedule_check_in, and a system-prompt line names both
 * tools for it. Keyed on the concept, not the wording; concernTools.test.ts
 * and threads.test.ts pin the exact text.
 */
function toldOneEventIsACheckIn(v: ModelView): boolean {
  const watch = v.toolDescriptions.create_watch ?? '';
  const rule = v.systemPrompt.split('\n').find((line) => /one event/i.test(line)) ?? '';
  return /one event/i.test(watch) && watch.includes('schedule_check_in')
    && rule.includes('`schedule_check_in`') && rule.includes('`create_watch`');
}

const decide = (v: ModelView): ScriptedModelStep[] => (toldOneEventIsACheckIn(v)
  ? [
    {
      call: 'schedule_check_in',
      input: {
        trigger: { event: 'device_online', subjectId: PARTNER_MBP, deadlineMinutes: 1440 },
        instruction: 'Tell the technician JL-PARTNER-MBP (Juniper Legal) is back online.',
      },
    },
    { say: "It's JL-PARTNER-MBP at Juniper Legal, offline since 13:05. I'll let you know the moment it's back online." },
  ]
  : [
    { call: 'create_watch', input: { orgId: ORG_JUNIPER, kind: 'custom_query', params: { deviceId: PARTNER_MBP }, cadenceMinutes: 15 } },
    { say: "It's JL-PARTNER-MBP at Juniper Legal. The watch can't tell you the instant it's back, because the fastest cadence is 15 minutes." },
  ]);

export const backOnlineFixture: ReplayFixture = {
  name: "tell me the moment it's back online",
  guards: '#11685: one awaited event is a device_online check-in, not a 15-minute watch',
  inventory: {
    ...INVENTORY,
    devices: [...INVENTORY.devices, { id: PARTNER_MBP, name: 'JL-PARTNER-MBP', orgId: ORG_JUNIPER }],
  },
  ceiling: replayCeiling(),
  standingFacts: standingFacts(),
  turns: [
    {
      user: "One of the partners at Juniper Legal says her MacBook has been off the network all afternoon. Which one is it, and tell me the moment it's back online.",
      modelScript: [
        { call: 'query_devices', input: { orgId: ORG_JUNIPER, status: 'offline' } },
        decide,
      ],
      toolOutputs: {
        query_devices: { devices: [{ id: PARTNER_MBP, hostname: 'JL-PARTNER-MBP', status: 'offline', lastSeenAt: '2026-11-09T13:05:00.000Z' }] },
        schedule_check_in: `Check-in scheduled (ID: ${CHECK_IN_ID}): it fires when the device comes online, or at 2026-11-10T13:10:00.000Z if it has not by then. Breeze will notify the user, and the instruction comes back to you with their next message in this thread.`,
        // Only the unguided path calls it; recorded so a lost rule shows up as this call, not as a missing output.
        create_watch: `Watch created (ID: ${WATCH_ID}), first check 2026-11-09T19:15:00.000Z.`,
      },
    },
  ],
  expect: {
    max: { promisesWithoutMechanism: 0, unansweredTurns: 0, toolErrors: 0 },
    turns: [{ corrections: [], maxToolCalls: 2 }],
  },
};
