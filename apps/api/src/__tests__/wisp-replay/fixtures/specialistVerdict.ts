/**
 * "What's the verdict?" — Wisp handed a slow workstation to a specialist, the
 * specialist reported back between turns, and Wisp said nothing had come back
 * and answered from older data (#11671). Now the settled run's result rides
 * on the next turn, once.
 */
import type { ReplayFixture, ModelView, ScriptedModelStep } from '../harness';
import { DEV, INVENTORY, ORG_HARBOR, replayCeiling, standingFacts } from './common';

const RUN_ID = 'dddddddd-0001-4ddd-8ddd-dddddddddddd';
const VERDICT = 'Memory is not the problem: RAM stayed at 36-61% over the window. The imaging service pins one core at 100% during exports.';

/** The model answers from a result it was given; otherwise it has to go and look. */
const verdictOrLook = (view: ModelView): ScriptedModelStep | ScriptedModelStep[] =>
  view.turnContent.includes(VERDICT)
    ? { say: 'The specialist finished: memory is fine (36-61%); the imaging service is pinning a core during exports. Tell Dana we found it and are fixing it.' }
    : [
      { call: 'get_ai_agent_run', input: { runId: RUN_ID } },
      { say: 'Here is what the specialist found.' },
    ];

export const specialistVerdictFixture: ReplayFixture = {
  name: "what's the verdict on the specialist's run",
  guards: '#11671: a finished specialist result reaches the next turn, once',
  inventory: INVENTORY,
  ceiling: replayCeiling(),
  standingFacts: standingFacts(),
  turns: [
    {
      user: 'Dana says PC-03 is crawling. Find out why.',
      modelScript: [
        { call: 'launch_specialist', input: { kind: 'device_troubleshooting', params: { deviceId: DEV.PC03, goal: 'Find why PC-03 is slow' } } },
        { say: 'I have handed PC-03 to the troubleshooting specialist; its report will land in this thread.' },
      ],
      toolOutputs: { launch_specialist: { success: true, launched: true, runId: RUN_ID } },
    },
    {
      user: "So what's the verdict on PC-03? And what do I tell Dana?",
      before: [{
        specialistSettles: { id: RUN_ID, orgId: ORG_HARBOR, status: 'completed', profile: 'device_troubleshooting', summary: VERDICT },
      }],
      modelScript: [verdictOrLook],
      toolOutputs: { get_ai_agent_run: { success: true, run: { id: RUN_ID, status: 'completed', summary: VERDICT } } },
    },
    {
      user: 'Thanks. Anything else on that box?',
      modelScript: [{ say: 'Nothing else is open on PC-03.' }],
    },
  ],
  expect: {
    max: { unansweredTurns: 0, toolErrors: 0 },
    turns: [
      { specialistResultsGiven: [] },
      { specialistResultsGiven: [RUN_ID], maxToolCalls: 0 },
      { specialistResultsGiven: [] },
    ],
  },
};
