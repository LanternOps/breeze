/**
 * #10432 (W09 Task 1): the replay scorer. Pure: a hand-built trace in, the
 * per-session score out. The replay driver (harness.ts) produces real traces;
 * here each metric is pinned on its own.
 */
import { describe, expect, it } from 'vitest';
import { crossOrgMistakes, scoreTrace, type ReplayToolCall, type ReplayTrace, type ReplayTurnTrace } from './score';

const ORG_HARBOR = 'org-harbor';
const ORG_JUNIPER = 'org-juniper';
const INVENTORY: ReplayTrace['inventory'] = {
  orgs: [
    { id: ORG_HARBOR, name: 'Harbor Dental' },
    { id: ORG_JUNIPER, name: 'Juniper Legal' },
  ],
  devices: [
    { id: 'dev-fs01', name: 'FS-01', orgId: ORG_HARBOR },
    { id: 'dev-pc07', name: 'PC-07', orgId: ORG_JUNIPER },
  ],
};

const call = (over: Partial<ReplayToolCall> = {}): ReplayToolCall => ({
  tool: 'query_devices',
  input: {},
  output: JSON.stringify({ devices: [] }),
  isError: false,
  refused: false,
  unverified: false,
  standingWarning: false,
  approvalWaitSeconds: 0,
  ...over,
});

const turn = (over: Partial<ReplayTurnTrace> = {}): ReplayTurnTrace => ({
  user: 'hi',
  standingStateSent: false,
  toolCalls: [],
  assistantText: 'ok',
  corrections: [],
  done: true,
  captureId: null,
  captureStatus: null,
  ...over,
});

const trace = (turns: ReplayTurnTrace[]): ReplayTrace => ({ name: 'hand-built', inventory: INVENTORY, turns });

describe('scoreTrace', () => {
  it('scores one unbacked promise and one device named with the wrong org', () => {
    const score = scoreTrace(trace([
      turn({ assistantText: "Nothing new on Harbor Dental. I'll check back in 10 minutes." }),
      turn({ assistantText: 'PC-07 at Harbor Dental is offline.', toolCalls: [call()] }),
    ]));
    expect(score.promisesWithoutMechanism).toBe(1);
    expect(score.crossOrgMistakes).toBe(1);
    expect(score.answeredTurns).toBe(2);
    expect(score.unansweredTurns).toBe(0);
  });

  it('a promise a tool result backs is not counted', () => {
    const scheduled = call({
      tool: 'schedule_check_in',
      input: { delayMinutes: 10, instruction: 'look again' },
      output: 'Check-in scheduled (ID: 0f0f0f0f-1111-4222-8333-444455556666) for 2026-11-09T12:00:00.000Z.',
    });
    const score = scoreTrace(trace([turn({ assistantText: "I'll check back in 10 minutes.", toolCalls: [scheduled] })]));
    expect(score.promisesWithoutMechanism).toBe(0);
  });

  it('an offer is not a promise', () => {
    const score = scoreTrace(trace([turn({ assistantText: "I can check back in 10 minutes if you'd like." })]));
    expect(score.promisesWithoutMechanism).toBe(0);
  });

  it('counts a turn with no reply text, or no `done`, as unanswered', () => {
    const score = scoreTrace(trace([
      turn({ assistantText: '   ' }),
      turn({ assistantText: 'Partial reply', done: false }),
      turn({ assistantText: 'All clear.' }),
    ]));
    expect(score).toMatchObject({ answeredTurns: 1, unansweredTurns: 2 });
  });

  it('separates refusals from other tool errors and sums approval waits', () => {
    const score = scoreTrace(trace([
      turn({
        toolCalls: [
          call({ isError: true, output: JSON.stringify({ error: 'device offline' }) }),
          call({ isError: true, refused: true, output: JSON.stringify({ error: 'Refused: matches a standing instruction' }) }),
          call({ approvalWaitSeconds: 45 }),
          call({ approvalWaitSeconds: 15 }),
        ],
      }),
    ]));
    expect(score).toMatchObject({ toolErrors: 1, refusals: 1, approvalWaitSeconds: 60 });
  });

  it('tool calls per answered turn', () => {
    expect(scoreTrace(trace([
      turn({ toolCalls: [call(), call(), call()] }),
      turn({ toolCalls: [call()] }),
    ])).toolCallsPerAnswer).toBe(2);
    expect(scoreTrace(trace([turn({ toolCalls: [] })])).toolCallsPerAnswer).toBe(0);
    // Calls that produced no answer at all are never "free".
    expect(scoreTrace(trace([turn({ assistantText: '', toolCalls: [call()] })])).toolCallsPerAnswer).toBe(Number.POSITIVE_INFINITY);
  });

  it('the server-written correction is not part of the model reply it lints', () => {
    const score = scoreTrace(trace([
      turn({ assistantText: 'FS-01 is back online.', corrections: ['Correction: no follow-up is scheduled. Ask me to schedule a check-in, or set a watch.'] }),
    ]));
    expect(score.promisesWithoutMechanism).toBe(0);
  });
});

describe('crossOrgMistakes', () => {
  it('pairs each device with the nearest org named in its sentence', () => {
    expect(crossOrgMistakes('FS-01 at Harbor Dental and PC-07 at Juniper Legal are both healthy.', INVENTORY)).toBe(0);
    expect(crossOrgMistakes('FS-01 (Juniper Legal) needs a disk cleanup.', INVENTORY)).toBe(1);
  });

  it('a device named with no org in its sentence is no mistake', () => {
    expect(crossOrgMistakes('PC-07 is offline. Harbor Dental has no open alerts.', INVENTORY)).toBe(0);
  });

  it('a hostname reused in two orgs is right beside either of them', () => {
    const reused: ReplayTrace['inventory'] = {
      orgs: INVENTORY.orgs,
      devices: [
        { id: 'dev-pc01-harbor', name: 'PC-01', orgId: ORG_HARBOR },
        { id: 'dev-pc01-juniper', name: 'PC-01', orgId: ORG_JUNIPER },
      ],
    };
    expect(crossOrgMistakes('PC-01 at Harbor Dental is offline.', reused)).toBe(0);
    expect(crossOrgMistakes('PC-01 at Juniper Legal is offline.', reused)).toBe(0);
  });

  it('matches names whole and case-insensitively', () => {
    expect(crossOrgMistakes('fs-01 at juniper legal is full.', INVENTORY)).toBe(1);
    expect(crossOrgMistakes('FS-010 at Juniper Legal is full.', INVENTORY)).toBe(0);
  });
});
