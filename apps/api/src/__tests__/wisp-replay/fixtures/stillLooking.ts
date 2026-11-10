/**
 * "Are you still looking?" — Wisp used to answer that it only acts when
 * messaged, or went and re-read its own state with tools. With the standing
 * state on the turn (W02, #10426/#10429) it answers from the snapshot, with no
 * tool call, and a second ask with unchanged facts is answered from the
 * snapshot it already has (the block is not re-sent).
 */
import type { ModelView, ReplayFixture, ScriptedModelStep } from '../harness';
import { INVENTORY, replayCeiling, standingFacts, standingLine } from './common';

/** Without a snapshot the model has to go and look. */
const LOOK_IT_UP: ScriptedModelStep[] = [
  { call: 'list_concerns', input: {} },
  { call: 'list_check_ins', input: {} },
  { call: 'get_wisp_activity', input: {} },
  { say: 'I am running between chats; I just checked my concerns and check-ins.' },
];

const answerFromThePicture = (v: ModelView): ScriptedModelStep | ScriptedModelStep[] => {
  const loop = standingLine(v.standingState, 'Loop:');
  const firstLook = standingLine(v.standingState, 'First look:');
  if (!loop || !firstLook) return LOOK_IT_UP;
  return { say: `Yes. I keep working between chats. ${loop} ${firstLook}` };
};

const LOOKUP_OUTPUTS = {
  list_concerns: { concerns: [], total: 0 },
  list_check_ins: 'No check-ins scheduled.',
  get_wisp_activity: { items: [] },
};

export const stillLookingFixture: ReplayFixture = {
  name: 'still looking',
  guards: '#10426 / #10429: status questions are answered from the standing state',
  inventory: INVENTORY,
  ceiling: replayCeiling(),
  standingFacts: standingFacts(),
  turns: [
    {
      user: 'Are you still looking at my orgs, or do you only do something when I message you?',
      modelScript: [answerFromThePicture],
      toolOutputs: LOOKUP_OUTPUTS,
    },
    {
      user: 'Still going?',
      modelScript: [answerFromThePicture],
      toolOutputs: LOOKUP_OUTPUTS,
    },
    {
      // The first look moved on: the new facts ride on the turn, and the answer uses them.
      standingFacts: standingFacts({ firstLook: { assessedOrgs: 3, settledOrgs: 3, inFlight: 0, totalOrgs: 3 } }),
      user: 'And now?',
      modelScript: [
        (v) => (/First look: 3 of 3 orgs assessed/.test(v.turnContent) ? answerFromThePicture(v) : LOOK_IT_UP),
      ],
      toolOutputs: LOOKUP_OUTPUTS,
    },
  ],
  expect: {
    max: { toolCallsPerAnswer: 0, unansweredTurns: 0, promisesWithoutMechanism: 0, toolErrors: 0 },
    turns: [
      { standingStateSent: true, maxToolCalls: 0, corrections: [] },
      // Unchanged facts: the snapshot from the first turn is still current.
      { standingStateSent: false, maxToolCalls: 0, corrections: [] },
      // Changed facts are sent again; a gate that sent only once would leave the model on the stale count.
      { standingStateSent: true, maxToolCalls: 0, corrections: [] },
    ],
  },
};
