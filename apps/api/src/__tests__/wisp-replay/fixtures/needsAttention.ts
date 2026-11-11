/**
 * "What needs my attention?" — Wisp used to sweep the fleet with a string of
 * reads to answer it. With the needs-you concerns on the standing state (W02)
 * it starts from the picture and checks at most one thing, in at most three
 * calls. Each device is named with its own org.
 */
import type { ModelView, ReplayFixture, ScriptedModelStep } from '../harness';
import { DEV, INVENTORY, replayCeiling, standingFacts } from './common';

/** `- high · Harbor Dental · 2h: FS-01 disk 96% full` → `{ severity, org, summary }`. */
function concernLines(block: string | null): Array<{ severity: string; org: string; summary: string }> {
  if (!block) return [];
  return block.split('\n').flatMap((line) => {
    const m = /^- (\S+) · (.+?) · [^:]+: (.+)$/.exec(line);
    return m ? [{ severity: m[1]!, org: m[2]!, summary: m[3]! }] : [];
  });
}

const SWEEP: ScriptedModelStep[] = [
  { call: 'query_devices', input: { status: 'offline' } },
  { call: 'get_active_alerts', input: {} },
  { call: 'list_concerns', input: {} },
  { call: 'get_fleet_health', input: {} },
  { say: 'I swept the fleet: FS-01 at Harbor Dental is nearly full and PC-07 at Juniper Legal is offline.' },
];

const fromThePicture = (v: ModelView): ScriptedModelStep | ScriptedModelStep[] => {
  const concerns = concernLines(v.standingState);
  if (concerns.length === 0) return SWEEP;
  return [
    // One look at the top item before recommending anything.
    { call: 'get_device_details', input: { deviceId: DEV.FS01 } },
    (after: ModelView) => {
      const detail = after.toolResults[0]?.isError ? '' : ' Its D: volume has 4 GB free.';
      const lines = concerns.map((c) => `${c.summary} (${c.org}, ${c.severity}).`);
      return { say: `Here is what needs you, most urgent first:\n${lines.join('\n')}\nFS-01 is the one to act on today.${detail}` };
    },
  ];
};

export const needsAttentionFixture: ReplayFixture = {
  name: 'what needs my attention',
  guards: '#10429: a status sweep starts from the standing state, not a fleet-wide read',
  inventory: INVENTORY,
  ceiling: replayCeiling(),
  standingFacts: standingFacts({
    concerns: {
      high: 1,
      medium: 2,
      low: 0,
      top: [
        { severity: 'high', orgName: 'Harbor Dental', summary: 'FS-01 disk 96% full', ageMinutes: 120 },
        { severity: 'medium', orgName: 'Juniper Legal', summary: 'PC-07 offline for 3 hours', ageMinutes: 180 },
        { severity: 'medium', orgName: 'Northfield Clinic', summary: 'PC-05 backup failed twice', ageMinutes: 300 },
      ],
    },
    alerts: { critical: 0, high: 2 },
  }),
  turns: [
    {
      user: 'What needs my attention right now?',
      modelScript: [fromThePicture],
      toolOutputs: {
        get_device_details: { id: DEV.FS01, hostname: 'FS-01', status: 'online', disks: [{ mount: 'D:', freeGb: 4, totalGb: 100 }] },
        query_devices: { devices: [{ id: DEV.PC07, hostname: 'PC-07', status: 'offline' }] },
        get_active_alerts: { alerts: [] },
        list_concerns: { concerns: [], total: 0 },
        get_fleet_health: { score: 82 },
      },
    },
  ],
  expect: {
    max: { toolCallsPerAnswer: 3, crossOrgMistakes: 0, promisesWithoutMechanism: 0, toolErrors: 0 },
    min: { answeredTurns: 1 },
    turns: [{ standingStateSent: true, maxToolCalls: 3, corrections: [] }],
  },
};
