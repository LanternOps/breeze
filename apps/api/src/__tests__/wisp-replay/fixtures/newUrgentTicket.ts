/**
 * #11677: "What needs my attention today?" right after an urgent ticket came
 * in. No assessment has seen the ticket and no concern names it, so the only
 * way Wisp can know is the standing state: its live ticket counts and
 * headlines, offline devices and approvals waiting. Without them the model has
 * to sweep (tickets, devices, approvals, alerts), past the three calls "keep it
 * short" allows, or answer from the concerns and leave the ticket out.
 */
import type { ModelView, ReplayFixture, ScriptedModelStep } from '../harness';
import { INVENTORY, replayCeiling, standingFacts, standingLine } from './common';

export const NEW_TICKET_SUBJECT = 'Server closet AC failed, file server overheating';

const SWEEP: ScriptedModelStep[] = [
  { call: 'manage_tickets', input: { action: 'list', status: 'new' } },
  { call: 'query_devices', input: { status: 'offline' } },
  { call: 'manage_alerts', input: { action: 'list' } },
  { call: 'list_concerns', input: {} },
  { say: 'FS-01 at Harbor Dental is nearly full; that is the one to act on today.' },
];

/** `- urgent · Harbor Dental · 4m · T-2027-0006 · unassigned: "…"` → the quoted subject and its org. */
function ticketHeadlines(block: string | null): Array<{ org: string; subject: string }> {
  if (!block) return [];
  return block.split('\n').flatMap((line) => {
    const m = /^- (?:urgent|high) · (.+?) · .*: "(.+)"$/.exec(line);
    return m ? [{ org: m[1]!, subject: m[2]! }] : [];
  });
}

/** `- "PC-07" · Juniper Legal · last seen 3h ago` → name and org. */
function offlineHeadlines(block: string | null): Array<{ name: string; org: string }> {
  if (!block) return [];
  return block.split('\n').flatMap((line) => {
    const m = /^- "(.+?)" · (.+?) · (?:last seen|never seen)/.exec(line);
    return m ? [{ name: m[1]!, org: m[2]! }] : [];
  });
}

const fromTheStandingState = (v: ModelView): ScriptedModelStep | ScriptedModelStep[] => {
  const tickets = ticketHeadlines(v.standingState);
  const approvals = standingLine(v.standingState, 'Approvals waiting on you:');
  if (tickets.length === 0 || !approvals) return SWEEP;
  const offline = offlineHeadlines(v.standingState);
  const lines = [
    ...tickets.map((t) => `Urgent ticket at ${t.org}: ${t.subject}.`),
    'FS-01 disk 96% full (Harbor Dental, high).',
    ...offline.map((d) => `${d.name} at ${d.org} is offline.`),
    `${approvals.replace('Approvals waiting on you:', 'Approvals waiting for you:')}.`,
  ];
  return { say: `Most urgent first:\n${lines.join('\n')}` };
};

const minutesAgo = (m: number): Date => new Date(Date.now() - m * 60_000);

export const newUrgentTicketFixture: ReplayFixture = {
  name: 'attention includes a ticket that arrived after the last look',
  guards: '#11677: open urgent tickets, offline devices and approvals are part of the attention answer',
  inventory: INVENTORY,
  ceiling: replayCeiling(),
  standingFacts: standingFacts({
    concerns: {
      high: 1, medium: 0, low: 0,
      top: [{ severity: 'high', orgName: 'Harbor Dental', summary: 'FS-01 disk 96% full', ageMinutes: 120 }],
    },
    tickets: {
      urgent: 1, high: 0, other: 2, unassignedUrgentHigh: 1, pastResponse: 0,
      top: [{
        priority: 'urgent', orgName: 'Harbor Dental', number: 'T-2027-0006', subject: NEW_TICKET_SUBJECT,
        createdAt: minutesAgo(1), assigned: false, responseDueAt: minutesAgo(-59), responded: false, slaPaused: false,
      }],
    },
    offlineDevices: { count: 1, top: [{ name: 'PC-07', orgName: 'Juniper Legal', lastSeenAt: minutesAgo(180) }] },
    approvals: { pending: 1 },
  }),
  turns: [
    {
      user: 'What needs my attention today? Keep it short.',
      modelScript: [fromTheStandingState],
      toolOutputs: {
        manage_tickets: { tickets: [] },
        query_devices: { devices: [] },
        manage_alerts: { alerts: [] },
        list_concerns: { concerns: [], total: 0 },
      },
    },
  ],
  expect: {
    max: { toolCallsPerAnswer: 3, crossOrgMistakes: 0, promisesWithoutMechanism: 0, toolErrors: 0 },
    min: { answeredTurns: 1 },
    turns: [{ standingStateSent: true, maxToolCalls: 3, corrections: [] }],
  },
};
